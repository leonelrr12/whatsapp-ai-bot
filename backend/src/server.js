const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const { askAI } = require("./ai");
const { sendWhatsAppMessage } = require("./whatsapp");
const db = require("./db");

const {
  getCustomer,
  createCustomer,
  updateCustomerMemory,
} = require("./memory");

const { extractCustomerData } = require("./extractor");
const { processMessage, WELCOME_MESSAGE, FLOW_STATES, resetFlow } = require("./flow");
const { appendToGoogleSheet } = require("./googleSheets");

const REQUIRED_ENV_VARS = [
  "PORT",
  "VERIFY_TOKEN",
  "BOT_PHONE_NUMBER",
  "OLLAMA_URL",
  "MODEL",
  "WHATSAPP_PHONE_ID",
  "WHATSAPP_TOKEN",
  "DB_HOST",
  "DB_PORT",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
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
app.use(express.json({ limit: "1mb" }));

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

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

const recentMessages = new Map();
const DEDUPLICATION_WINDOW_MS = 3000; // 3 seconds (catch true duplicate API calls only)

app.post("/webhook", webhookLimiter, async (req, res) => {
  console.log("=== WEBHOOK POST START ===");
  console.log("Body keys:", Object.keys(req.body || {}));
  
  try {
    const body = req.body;
    
    if (!body.entry || !body.entry[0]) {
      console.log("No entry, ignoring");
      return res.sendStatus(200);
    }

    const value = body.entry[0].changes?.[0]?.value;
    
    if (!value?.messages || !value.messages[0]) {
      console.log("No messages in value, ignoring");
      return res.sendStatus(200);
    }

    const message = value.messages[0];
    console.log("Message:", message);

    const from = message.from;
    const text = message.text?.body || message.text?.message;
    const image = message.image;
    const timestamp = parseInt(message.timestamp) || Date.now();
    
    console.log("Message type:", message.type);
    console.log("Has image:", !!image);
    
    // Deduplication: include flow state to avoid blocking same text at different stages
    const currentCustomer = await getCustomer(from);
    const flowState = currentCustomer?.flow_state || 'new';
    const dedupKey = `${from}:${text}:${flowState}:${message.id}`;
    
    const now = Date.now();
    if (recentMessages.has(dedupKey)) {
      const lastTime = recentMessages.get(dedupKey);
      if (now - lastTime < DEDUPLICATION_WINDOW_MS) {
        console.log("Duplicate message ignored:", dedupKey);
        return res.sendStatus(200);
      }
    }
    recentMessages.set(dedupKey, now);

    // Cleanup old entries
    if (recentMessages.size > 1000) {
      for (const [key, time] of recentMessages.entries()) {
        if (now - time > DEDUPLICATION_WINDOW_MS * 2) {
          recentMessages.delete(key);
        }
      }
    }

    console.log("=== MESSAGE RECEIVED ===");
    console.log("From:", from, "Text:", text, "Type:", message.type);

    res.sendStatus(200);

    // Handle image messages (recibo de luz)
    if (message.type === 'image' && image) {
      const imageUrl = `https://graph.facebook.com/v19.0/${image.id}/picture?access_token=${process.env.WHATSAPP_TOKEN}`;
      console.log("Image received:", image.id);

      await db.query(
        `INSERT INTO messages(phone, message, image_url)
         VALUES($1, $2, $3)`,
        [from, `[Imagen: ${image.id}]`, imageUrl],
      );

      await createCustomer(from);

      // Get current flow state before updating
      const customer = await getCustomer(from);
      const currentState = customer?.flow_state || '';

      if (currentState === 'image') {
        await updateCustomerMemory(from, 'receipt_image', imageUrl);
        const flowResult = await processMessage(from, 'imagen_recibida', USE_AI);
        await sendWhatsAppMessage(from, flowResult.text);
        await db.query(
          `INSERT INTO messages(phone, message)
           VALUES($1, $2)`,
          [from, flowResult.text],
        );
      } else {
        await sendWhatsAppMessage(from, "¡Gracias por compartir la imagen! 📸 Un asesor la revisará pronto.");
      }

      console.log("=== IMAGE PROCESSED OK ===");
      return;
    }

    await db.query(
      `INSERT INTO messages(phone, message)
       VALUES($1, $2)`,
      [from, text],
    );

    await createCustomer(from);

    const customer = await getCustomer(from);
    
    // Check if user wants to reset or start over
    if (text && (text.toLowerCase().includes('reiniciar') || text.toLowerCase().includes('empezar de nuevo'))) {
      await updateCustomerMemory(from, 'submitted', 'false');
      await resetFlow(from);
      await sendWhatsAppMessage(from, WELCOME_MESSAGE);
      console.log("=== FLOW RESET ===");
      return;
    }
    
    // Check if AI mode is enabled and user explicitly asks for it
    if (USE_AI && text && (text.toLowerCase().includes('hablar con ia') || text.toLowerCase().includes('hablar con人工'))) {
      const aiResponse = await askAI(text, customer);
      await sendWhatsAppMessage(from, aiResponse);
      await db.query(
        `INSERT INTO messages(phone, message)
         VALUES($1, $2)`,
        [from, aiResponse],
      );
      console.log("=== AI MODE ===");
      return;
    }
    
    // Use flow-based responses (no AI)
    const flowResult = await processMessage(from, text, USE_AI);
    
    if (flowResult.useAI && USE_AI) {
      const aiResponse = await askAI(text, customer);
      await sendWhatsAppMessage(from, aiResponse);
      await db.query(
        `INSERT INTO messages(phone, message)
         VALUES($1, $2)`,
        [from, aiResponse],
      );
    } else {
      await sendWhatsAppMessage(from, flowResult.text);
      await db.query(
        `INSERT INTO messages(phone, message)
         VALUES($1, $2)`,
        [from, flowResult.text],
      );
    }

    // Send to Google Sheets when flow completes (only once per customer)
    console.log("Flow nextState:", flowResult.nextState);
    if (flowResult.nextState === 'complete') {
      const updatedCustomer = await getCustomer(from);
      if (updatedCustomer && updatedCustomer.submitted !== 'true') {
        console.log("Flow completado, enviando a Google Sheets...");
        await updateCustomerMemory(from, 'submitted', 'true');
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

app.listen(process.env.PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${process.env.PORT}`);
});
