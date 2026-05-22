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

const processedMessages = new Set();

app.post("/webhook", async (req, res) => {
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;

    if (!value?.messages) {
      return res.sendStatus(200);
    }

    const message = value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    if (message.from === process.env.BOT_PHONE_NUMBER) {
      return res.sendStatus(200);
    }

    const messageId = message.id;
    if (processedMessages.has(messageId)) {
      console.log("Mensaje duplicado, ignorando:", messageId);
      return res.sendStatus(200);
    }
    processedMessages.add(messageId);
    if (processedMessages.size > 100) {
      processedMessages.clear();
    }

    const from = message.from;
    const text = message.text?.body;

    console.log("Mensaje recibido:", from, text, "ID:", messageId);

    res.sendStatus(200);

    await db.query(
      `INSERT INTO messages(phone, message)
       VALUES($1, $2)`,
      [from, text],
    );

    await createCustomer(from);

    const extractedData = extractCustomerData(text);

    for (const [field, value] of Object.entries(extractedData)) {
      await updateCustomerMemory(from, field, value);
    }

    const updatedCustomer = await getCustomer(from);

    const aiResponse = await askAI(text, updatedCustomer);

    await sendWhatsAppMessage(from, aiResponse);

    await db.query(
      `INSERT INTO messages(phone, message)
       VALUES($1, $2)`,
      [from, aiResponse],
    );

    console.log("Mensaje procesado correctamente");
  } catch (error) {
    console.error("Error procesando mensaje:", error);
  }
});

app.listen(process.env.PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${process.env.PORT}`);
});
