const express = require("express");
const cors = require("cors");

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

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Chatbot funcionando");
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
const DEDUPLICATION_WINDOW_MS = 10 * 1000; // 10 seconds

app.post("/webhook", async (req, res) => {
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
    const timestamp = parseInt(message.timestamp) || Date.now();
    
    // Deduplication based on from + text content + 10-second window
    const timeWindow = Math.floor(timestamp / 10000) * 10000;
    const dedupKey = `${from}:${text}:${timeWindow}`;
    
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
    console.log("From:", from, "Text:", text);

    res.sendStatus(200);

    await db.query(
      `INSERT INTO messages(phone, message)
       VALUES($1, $2)`,
      [from, text],
    );

    await createCustomer(from);

    const customer = await getCustomer(from);
    
    // Check if user wants to reset or start over
    if (text.toLowerCase().includes('reiniciar') || text.toLowerCase().includes('empezar de nuevo')) {
      await resetFlow(from);
      await sendWhatsAppMessage(from, WELCOME_MESSAGE);
      console.log("=== FLOW RESET ===");
      return;
    }
    
    // Check if AI mode is enabled and user explicitly asks for it
    if (USE_AI && (text.toLowerCase().includes('hablar con ia') || text.toLowerCase().includes('hablar con人工'))) {
      const aiResponse = await askAI(text, customer);
      await sendWhatsAppMessage(from, aiResponse);
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

    console.log("=== MESSAGE PROCESSED OK ===");
  } catch (error) {
    console.error("Error:", error.message, error.stack);
  }
});

app.listen(process.env.PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${process.env.PORT}`);
});
