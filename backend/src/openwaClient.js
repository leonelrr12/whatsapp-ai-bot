const axios = require("axios");
const { retryWithBackoff } = require("./utils");

const API_URL = process.env.OPENWA_API_URL;
const API_KEY = process.env.OPENWA_API_KEY;
const SESSION_NAME = process.env.OPENWA_SESSION_NAME;

let cachedSessionId = null;

function headers() {
  return {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json",
  };
}

async function getOrCreateSession() {
  const { data } = await axios.get(`${API_URL}/api/sessions`, {
    headers: headers(),
  });

  if (!Array.isArray(data)) throw new Error("Unexpected response from sessions list");

  let session = data.find((s) => s.name === SESSION_NAME);

  if (!session) {
    const { data: created } = await axios.post(
      `${API_URL}/api/sessions`,
      { name: SESSION_NAME },
      { headers: headers() },
    );
    if (!created || !created.id) throw new Error("Failed to create session");
    session = created;
  }

  cachedSessionId = session.id;
  return session;
}

async function getSessionStatus() {
  if (!cachedSessionId) await getOrCreateSession();

  try {
    const { data } = await axios.get(
      `${API_URL}/api/sessions/${cachedSessionId}`,
      { headers: headers() },
    );
    return data?.status || "UNKNOWN";
  } catch {
    cachedSessionId = null;
    return "UNKNOWN";
  }
}

async function registerWebhook(sessionId, webhookUrl) {
  await axios.post(
    `${API_URL}/api/sessions/${sessionId}/webhooks`,
    {
      url: webhookUrl,
      events: ["message.received", "session.status"],
    },
    { headers: headers() },
  );
}

async function sendWhatsAppMessage(to, text) {
  const chatId = `${to}@c.us`;
  try {
    if (!cachedSessionId) await getOrCreateSession();
    await retryWithBackoff(async () => {
      await axios.post(
        `${API_URL}/api/sessions/${cachedSessionId}/messages/send-text`,
        { chatId, text },
        { headers: headers() },
      );
    });
  } catch (error) {
    if (error.response?.status === 404) {
      cachedSessionId = null;
      await getOrCreateSession();
      return sendWhatsAppMessage(to, text);
    }
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
    if (!cachedSessionId) await getOrCreateSession();
    await retryWithBackoff(async () => {
      await axios.post(
        `${API_URL}/api/sessions/${cachedSessionId}/messages/send-image`,
        { chatId, image: { url: imageUrl }, caption },
        { headers: headers() },
      );
    });
  } catch (error) {
    if (error.response?.status === 404) {
      cachedSessionId = null;
      await getOrCreateSession();
      return sendImage(to, imageUrl, caption);
    }
    console.error(
      "Error enviando imagen WhatsApp:",
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function ensureWebhookRegistered() {
  const webhookUrl = process.env.WEBHOOK_URL || `http://backend:${process.env.PORT || 3000}/webhook`;

  try {
    const { data: existing } = await axios.get(
      `${API_URL}/api/sessions/${cachedSessionId}/webhooks`,
      { headers: headers() },
    );

    if (Array.isArray(existing)) {
      const alreadyRegistered = existing.some(
        (w) => w.url === webhookUrl && w.active !== false,
      );
      if (alreadyRegistered) {
        console.log("Webhook ya registrado");
        return;
      }
    }
  } catch {
  }

  try {
    await registerWebhook(cachedSessionId, webhookUrl);
    console.log("Webhook registrado en:", webhookUrl);
  } catch (error) {
    if (error.response?.status === 409) {
      console.log("Webhook ya existe (409)");
    } else {
      console.error("Error registrando webhook:", error.response?.data || error.message);
    }
  }
}

async function startSession(sessionId) {
  try {
    const { data } = await axios.post(
      `${API_URL}/api/sessions/${sessionId}/start`,
      {},
      { headers: headers() },
    );
    return data;
  } catch (error) {
    console.error("Error iniciando sesión:", error.response?.data || error.message);
    return null;
  }
}

async function initSession() {
  console.log("=== OPENWA STARTUP ===");

  try {
    const session = await getOrCreateSession();
    const status = session.status || "UNKNOWN";
    console.log(`Session "${SESSION_NAME}" (${session.id}):`, status);

    if (status === "created" || status === "disconnected") {
      console.log("Iniciando sesión...");
      await startSession(session.id);
    }

    await ensureWebhookRegistered();

    if (status !== "CONNECTED") {
      console.log("📱 Escanea el QR desde el endpoint /qr de OpenWA");
      startStatusPolling();
    } else {
      console.log("✅ Bot conectado y listo");
    }

    return session;
  } catch (error) {
    console.error("Error en initSession:", error.message);
    return null;
  }
}

function startStatusPolling() {
  const interval = setInterval(async () => {
    try {
      const status = await getSessionStatus();
      if (status === "CONNECTED") {
        console.log("✅ ¡Sesión conectada! Registrando webhook...");
        await ensureWebhookRegistered();
        clearInterval(interval);
      }
    } catch {
    }
  }, 5000);
}

module.exports = {
  sendWhatsAppMessage,
  sendImage,
  initSession,
  getOrCreateSession,
  ensureWebhookRegistered,
  getSessionStatus,
};
