const axios = require("axios");
const { retryWithBackoff } = require("./utils");

const API_URL = process.env.OPENWA_API_URL;
const API_KEY = process.env.OPENWA_API_KEY;
const SESSION_NAME = process.env.OPENWA_SESSION_NAME;

function headers() {
  return {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json",
  };
}

async function ensureSession() {
  const { data } = await axios.get(`${API_URL}/api/sessions`, {
    headers: headers(),
  });

  if (!data.success) throw new Error("Failed to list sessions");

  const existing = data.data.find((s) => s.name === SESSION_NAME);
  if (existing) return existing;

  const { data: created } = await axios.post(
    `${API_URL}/api/sessions`,
    { name: SESSION_NAME },
    { headers: headers() },
  );

  if (!created.success) throw new Error("Failed to create session");
  return created.data;
}

async function getSessionQR(sessionId) {
  const { data } = await axios.get(
    `${API_URL}/api/sessions/${sessionId}/qr`,
    { headers: headers() },
  );
  return data.data;
}

async function registerWebhook(sessionId, webhookUrl) {
  const { data } = await axios.post(
    `${API_URL}/api/sessions/${sessionId}/webhooks`,
    {
      url: webhookUrl,
      events: ["message.received", "session.status"],
    },
    { headers: headers() },
  );
  return data;
}

async function sendWhatsAppMessage(to, text) {
  const chatId = `${to}@c.us`;
  try {
    const session = await ensureSession();
    await retryWithBackoff(async () => {
      await axios.post(
        `${API_URL}/api/sessions/${session.id}/messages/send-text`,
        { chatId, text },
        { headers: headers() },
      );
    });
  } catch (error) {
    console.error(
      "Error enviando mensaje WhatsApp:",
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function sendImage(to, imageUrl, caption) {
  const chatId = `${to}@c.us`;
  try {
    const session = await ensureSession();
    await retryWithBackoff(async () => {
      await axios.post(
        `${API_URL}/api/sessions/${session.id}/messages/send-image`,
        { chatId, image: { url: imageUrl }, caption },
        { headers: headers() },
      );
    });
  } catch (error) {
    console.error(
      "Error enviando imagen WhatsApp:",
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function initSession() {
  console.log("=== OPENWA STARTUP ===");

  try {
    const session = await ensureSession();
    console.log(`Session ${SESSION_NAME}:`, session.status);

    if (session.status !== "CONNECTED") {
      const qr = await getSessionQR(session.id);
      console.log("Escanea este QR con WhatsApp para vincular:");
      console.log(qr.code);
      console.log(
        "O ve al dashboard: http://<tu-servidor>:2886",
      );
    } else {
      const webhookUrl = `http://backend:${process.env.PORT || 3000}/webhook`;
      await registerWebhook(session.id, webhookUrl);
      console.log("Webhook registrado en:", webhookUrl);
    }

    return session;
  } catch (error) {
    console.error("Error en initSession:", error.message);
    return null;
  }
}

module.exports = {
  sendWhatsAppMessage,
  sendImage,
  initSession,
  ensureSession,
};
