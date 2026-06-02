const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const { askAI } = require("./ai");
const { sendWhatsAppMessage, sendImage } = require("./whatsapp");
const db = require("./db");

const {
  getCustomer,
  createCustomer,
  updateCustomerMemory,
} = require("./memory");

const { extractCustomerData } = require("./extractor");
const { processMessage, WELCOME_MESSAGE, FLOW_STATES, resetFlow } = require("./flow");
const { appendToGoogleSheet } = require("./googleSheets");
const { initSession } = require("./openwaClient");

const REQUIRED_ENV_VARS = [
  "PORT",
  "OLLAMA_URL",
  "MODEL",
  "DB_HOST",
  "DB_PORT",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
  "OPENWA_API_URL",
  "OPENWA_API_KEY",
  "OPENWA_SESSION_NAME",
];

const USE_AI = process.env.USE_AI === 'true';
console.log("=== CONFIG ===");
console.log("USE_AI:", USE_AI);

function validateEnvVars() {
  const missing = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`Variables de entorno faltantes: ${missing.join(", ")}`);
    process.exit(1);
  }
}

validateEnvVars();

const app = express();

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Demasiadas solicitudes, intenta de nuevo más tarde" },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.send("Chatbot funcionando");
});

app.get("/health", async (req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ status: "ok", db: "connected", uptime: process.uptime() });
  } catch {
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

const processedEvents = new Map();
const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000;

app.post("/webhook", webhookLimiter, async (req, res) => {
  console.log("=== WEBHOOK POST START ===");

  try {
    const body = req.body;

    // Dedup by deliveryId only (unique per delivery)
    const deliveryId = body.deliveryId || req.headers["x-openwa-delivery-id"];

    if (deliveryId && processedEvents.has(deliveryId)) {
      console.log("Evento duplicado ignorado:", deliveryId);
      return res.sendStatus(200);
    }

    if (deliveryId) processedEvents.set(deliveryId, Date.now());
    if (processedEvents.size > 10000) {
      const now = Date.now();
      for (const [key, time] of processedEvents.entries()) {
        if (now - time > IDEMPOTENCY_TTL) {
          processedEvents.delete(key);
        }
      }
    }

    if (body.event !== "message.received") {
      console.log("Evento ignorado:", body.event, body.data?.status || "");
      return res.sendStatus(200);
    }

    const data = body.data;
    if (!data || data.fromMe) {
      console.log("Mensaje propio o vacío, ignorando");
      return res.sendStatus(200);
    }

    const from = data.from.replace(/@[^@]+$/, "");
    const chatId = data.from;
    const sessionId = body.sessionId;
    const text = data.body || "";
    const msgType = data.type || "chat";
    const hasMedia = data.hasMedia || false;

    res.sendStatus(200);

    console.log("=== MESSAGE RECEIVED ===");
    console.log("From:", from, "Text:", text, "Type:", msgType, "HasMedia:", hasMedia);
    if (hasMedia) console.log("Media:", JSON.stringify(data.media));

    if (msgType === "image") {
      const imageUrl = data.media?.url || "";
      console.log("Image received:", data.id, "URL:", imageUrl.substring(0, 80));

      await db.query(
        `INSERT INTO messages(phone, message, image_url)
         VALUES($1, $2, $3)`,
        [from, `[Imagen: ${data.id}]`, imageUrl],
      );

      await createCustomer(from);
      const customer = await getCustomer(from);
      const currentState = customer?.flow_state || "";

      if (currentState === "image") {
        await updateCustomerMemory(from, "receipt_image", imageUrl);
        const flowResult = await processMessage(from, "imagen_recibida", USE_AI);
        await sendWhatsAppMessage(from, flowResult.text, chatId, sessionId);
        await db.query(
          `INSERT INTO messages(phone, message)
           VALUES($1, $2)`,
          [from, flowResult.text],
        );
      } else {
        await sendWhatsAppMessage(from, "¡Gracias por compartir la imagen! 📸 Un asesor la revisará pronto.", chatId, sessionId);
      }

      console.log("=== IMAGE PROCESSED OK ===");
      return;
    }

    if (!text) {
      console.log("Mensaje sin texto, ignorando");
      return;
    }

    await db.query(
      `INSERT INTO messages(phone, message)
       VALUES($1, $2)`,
      [from, text],
    );

    await createCustomer(from);
    const customer = await getCustomer(from);

    if (text && (text.toLowerCase().includes("reiniciar") || text.toLowerCase().includes("empezar de nuevo"))) {
      await updateCustomerMemory(from, "submitted", "false");
      await resetFlow(from);
      await sendWhatsAppMessage(from, WELCOME_MESSAGE, chatId, sessionId);
      console.log("=== FLOW RESET ===");
      return;
    }

    if (USE_AI && text && (text.toLowerCase().includes("hablar con ia") || text.toLowerCase().includes("hablar con人工"))) {
      const aiResponse = await askAI(text, customer);
      await sendWhatsAppMessage(from, aiResponse, chatId, sessionId);
      await db.query(
        `INSERT INTO messages(phone, message)
         VALUES($1, $2)`,
        [from, aiResponse],
      );
      console.log("=== AI MODE ===");
      return;
    }

    const flowResult = await processMessage(from, text, USE_AI);

    if (flowResult.useAI && USE_AI) {
      const aiResponse = await askAI(text, customer);
      await sendWhatsAppMessage(from, aiResponse, chatId, sessionId);
      await db.query(
        `INSERT INTO messages(phone, message)
         VALUES($1, $2)`,
        [from, aiResponse],
      );
    } else {
      console.log("Enviando respuesta a", from, "con chatId", chatId);
      await sendWhatsAppMessage(from, flowResult.text, chatId, sessionId);
      console.log("Respuesta enviada OK");
      await db.query(
        `INSERT INTO messages(phone, message)
         VALUES($1, $2)`,
        [from, flowResult.text],
      );
    }

    if (flowResult.nextState === "complete") {
      const updatedCustomer = await getCustomer(from);
      if (updatedCustomer && updatedCustomer.submitted !== "true") {
        console.log("Flow completado, enviando a Google Sheets...");
        await updateCustomerMemory(from, "submitted", "true");
        await appendToGoogleSheet(updatedCustomer);
      } else {
        console.log("Ya enviado a Google Sheets anteriormente, omitiendo");
      }
    }

    console.log("=== MESSAGE PROCESSED OK ===");
  } catch (error) {
    console.error("Error:", error.message, error.stack);
  }
});

app.listen(process.env.PORT, "0.0.0.0", async () => {
  console.log(`Servidor corriendo en puerto ${process.env.PORT}`);

  const session = await initSession();
  if (session && session.status === "CONNECTED") {
    console.log("Bot listo para recibir mensajes ✅");
  } else {
    console.log("Escanea el QR del dashboard de OpenWA para conectar 📱");
  }
});
