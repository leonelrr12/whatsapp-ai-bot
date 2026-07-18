const express = require("express");
const cors = require("cors");
const path = require("path");

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
const { syncLeadToCRM } = require("./crmClient");
const { initSession, onMessage, getAllSessions, getSessionQR } = require("./baileysClient");

const REQUIRED_ENV_VARS = [
  "PORT",
  "OLLAMA_URL",
  "MODEL",
  "DB_HOST",
  "DB_PORT",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
  "APP_HOST",
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

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use("/uploads", express.static("uploads"));

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

// ====== Incoming Message Handler (replaces webhook logic) ======

const processedEvents = new Map();
const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000;

async function handleIncomingMessage(msg) {
  // msg format: { from, chatId, sessionId, text, type, hasMedia, media, id, fromMe, rawMessage }
  const tStart = Date.now();

  try {
    // Dedup by message id
    const msgId = msg.id;
    if (msgId && processedEvents.has(msgId)) {
      console.log("Evento duplicado ignorado:", msgId);
      return;
    }

    if (msgId) processedEvents.set(msgId, Date.now());
    if (processedEvents.size > 10000) {
      const now = Date.now();
      for (const [key, time] of processedEvents.entries()) {
        if (now - time > IDEMPOTENCY_TTL) processedEvents.delete(key);
      }
    }

    if (msg.fromMe) {
      console.log("Mensaje propio, ignorando");
      return;
    }

    const from = msg.from;
    const chatId = msg.chatId;
    const sessionId = msg.sessionId;
    const text = msg.text || "";
    const msgType = msg.type || "chat";
    const hasMedia = msg.hasMedia || false;

    console.log("=== MESSAGE RECEIVED ===");
    console.log("From:", from, "Text:", text, "Type:", msgType, "HasMedia:", hasMedia);
    if (hasMedia && msg.media) console.log("Media URL:", msg.media.url);

    if (msgType === "image") {
      const imageUrl = msg.media?.url || "";
      const fileName = msg.media?.fileName || `receipt_${Date.now()}.jpg`;

      await db.query(
        `INSERT INTO messages(phone, message, image_url)
         VALUES($1, $2, $3)`,
        [from, `[Imagen: ${msgId}]`, imageUrl],
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

        if (flowResult.nextState === "complete") {
          const updatedCustomer = await getCustomer(from);
          if (updatedCustomer && updatedCustomer.submitted !== "true") {
            console.log("Flow completado via imagen, sincronizando...");
            await updateCustomerMemory(from, "submitted", "true");
            await syncLeadToCRM(updatedCustomer);
            if (process.env.GOOGLE_SHEETS_ENABLED === 'true') {
              await appendToGoogleSheet(updatedCustomer);
            }
          }
        }
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
        console.log("Flow completado, sincronizando...");
        await updateCustomerMemory(from, "submitted", "true");
        await syncLeadToCRM(updatedCustomer);
        if (process.env.GOOGLE_SHEETS_ENABLED === 'true') {
          await appendToGoogleSheet(updatedCustomer);
        }
      } else {
        console.log("Ya procesado anteriormente, omitiendo");
      }
    }

    console.log(`=== MESSAGE PROCESSED OK (${Date.now() - tStart}ms) ===`);
  } catch (error) {
    console.error("Error:", error.message, error.stack);
  }
}

// Register the message handler with Baileys
onMessage(handleIncomingMessage);

// ====== Baileys Session Endpoints ======

// GET /sessions - list all WhatsApp sessions and their status
app.get("/sessions", (req, res) => {
  const sessions = getAllSessions();
  res.json(sessions);
});

// GET /qr/:sessionName - get QR code for a session (HTML page for scanning)
app.get("/qr/:sessionName", (req, res) => {
  const sessionName = req.params.sessionName;
  const qr = getSessionQR(sessionName);

  if (!qr) {
    return res.status(404).send(`<html><body>
      <h2>QR no disponible para "${sessionName}"</h2>
      <p>La sesión ya está conectada o el QR ha expirado.</p>
      <p><a href="/sessions">Ver estado de sesiones</a></p>
    </body></html>`);
  }

  // Render QR as HTML with auto-refresh
  const QRCode = require("qrcode");
  QRCode.toDataURL(qr, (err, url) => {
    if (err) {
      return res.status(500).send("Error generating QR");
    }
    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Scan QR - ${sessionName}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: Arial, sans-serif; text-align: center; padding: 20px; background: #f0f0f0; }
    h2 { color: #333; }
    .qr-box { background: white; padding: 30px; border-radius: 10px; display: inline-block; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    img { max-width: 300px; }
    p { color: #666; margin-top: 20px; }
    .refresh { color: #999; font-size: 12px; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="qr-box">
    <h2>📱 Escanea el QR para "${sessionName}"</h2>
    <img src="${url}" alt="QR Code" />
    <p>Abre WhatsApp &gt; Dispositivos Vinculados &gt; Vincular un Dispositivo</p>
    <p class="refresh">Esta página se actualiza automáticamente cada 15 segundos</p>
  </div>
  <script>
    setTimeout(() => location.reload(), 15000);
  </script>
</body>
</html>`);
  });
});

// ====== Startup ======

app.listen(process.env.PORT, "0.0.0.0", async () => {
  console.log(`Servidor corriendo en puerto ${process.env.PORT}`);

  // Start Baileys sessions
  const result = await initSession();
  const connected = result.sessions?.filter(s => s.connected).length || 0;
  const total = result.sessions?.length || 0;

  if (connected > 0) {
    console.log(`✅ ${connected}/${total} sesiones WhatsApp conectadas - Bot listo`);
  }
  if (connected < total) {
    console.log(`📱 ${total - connected} sesión(es) pendiente(s) de QR.`);
    console.log(`   Abre GET /qr/:sessionName para escanear`);
  }
});
