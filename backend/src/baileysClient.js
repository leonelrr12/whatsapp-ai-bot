const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { retryWithBackoff } = require("./utils");

// Baileys imports
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");

// ====== Configuration ======

const APP_HOST = process.env.APP_HOST || `http://localhost:${process.env.PORT || 3000}`;

const SESSIONS_CONFIG = (() => {
  try {
    const raw = process.env.WHATSAPP_SESSIONS;
    if (raw) return JSON.parse(raw);
    // Fallback: single session from legacy env vars or default
    const name = process.env.OPENWA_SESSION_NAME || "default";
    return [{ id: name, authDir: `/app/auth/${name}` }];
  } catch (e) {
    console.error("Error parsing WHATSAPP_SESSIONS:", e.message);
    return [{ id: "default", authDir: "/app/auth/default" }];
  }
})();

// ====== State ======

// Map<sessionId, { sock, state, saveCreds, qr, connected, config }>
const sessions = new Map();
let messageHandler = null;


// ====== Helpers ======

function normalizeJid(jid) {
  if (!jid) return jid;
  // Convert @c.us to @s.whatsapp.net (Baileys native format)
  if (jid.endsWith("@c.us")) {
    return jid.replace(/@c\.us$/, "@s.whatsapp.net");
  }
  // @lid and @s.whatsapp.net are valid Baileys JIDs - pass through unchanged
  // DO NOT convert @lid to @s.whatsapp.net - they are different identifiers
  // @g.us also passes through unchanged
  return jid;
}

function extractText(msg) {
  if (!msg.message) return "";
  const m = msg.message;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId;
  if (m.listResponseMessage?.title) return m.listResponseMessage.title;
  return "";
}

function getMessageType(msg) {
  if (!msg.message) return "unknown";
  const m = msg.message;
  if (m.imageMessage) return "image";
  if (m.videoMessage) return "video";
  if (m.audioMessage) return "audio";
  if (m.documentMessage) return "document";
  if (m.stickerMessage) return "sticker";
  if (m.conversation || m.extendedTextMessage) return "chat";
  if (m.buttonsResponseMessage || m.listResponseMessage) return "chat";
  return "unknown";
}

function hasMediaType(msg) {
  const m = msg.message || {};
  return !!(m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage);
}

function normalizeMessage(msg, sessionId) {
  // Skip if no message content
  if (!msg.message) return null;

  // Use senderPn (real phone JID) if available, otherwise use remoteJid
  // senderPn is the actual phone number when the message comes via LID
  const realJid = msg.key.senderPn || msg.key.remoteJid;
  const fromRaw = realJid || "";

  // Extract phone number from JID
  const from = fromRaw.replace(/@.+$/, "");

  return {
    from,
    chatId: realJid,
    sessionId,
    text: extractText(msg),
    type: getMessageType(msg),
    hasMedia: hasMediaType(msg),
    media: null, // populated later for images
    id: msg.key.id,
    fromMe: !!msg.key.fromMe,
    rawMessage: msg, // keep original for media download
    timestamp: msg.messageTimestamp || Date.now() / 1000,
  };
}

const reconnectAttempts = new Map();

function getReconnectDelay(sessionId) {
  const attempts = reconnectAttempts.get(sessionId) || 0;
  reconnectAttempts.set(sessionId, attempts + 1);
  // Exponential backoff: 5s, 10s, 20s, 40s, capped at 60s
  return Math.min(5000 * Math.pow(2, attempts), 60000);
}

function resetReconnectDelay(sessionId) {
  reconnectAttempts.delete(sessionId);
}

// ====== Session Management ======

async function initSingleSession(config) {
  const { id, authDir } = config;

  // Skip if already connected
  if (sessions.has(id)) {
    const existing = sessions.get(id);
    if (existing.connected) {
      console.log(`[${id}] Session already connected, skipping init`);
      return existing;
    }
    // Cleanup old socket
    try { existing.sock?.ws?.close(); } catch {}
    sessions.delete(id);
  }

  console.log(`[${id}] Initializing session...`);
  console.log(`[${id}] Auth dir: ${authDir}`);

  // Ensure auth directory exists
  fs.mkdirSync(authDir, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // Get latest WhatsApp Web version
    let version;
    try {
      const { version: latestVersion } = await fetchLatestBaileysVersion();
      version = latestVersion;
      console.log(`[${id}] Using WA version: ${version.join(".")}`);
    } catch {
      console.log(`[${id}] Using default WA version`);
    }

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // we handle QR ourselves
      version,
      browser: [id, "Chrome", "1.0.0"], // Use session ID as browser name to distinguish devices
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 60000,
    });

    const sessionData = { sock, state, saveCreds, qr: null, connected: false, config };
    sessions.set(id, sessionData);

    // ====== Event Handlers ======

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // New QR code available
        sessionData.qr = qr;
        console.log(`\n📱 [${id}] QR CODE READY - Scan with WhatsApp`);
        console.log(`   Or open: ${APP_HOST}/qr/${id}\n`);
        // Also print to terminal
        try {
          const QRCode = require("qrcode-terminal");
          QRCode.generate(qr, { small: true });
        } catch {}
      }

      if (connection === "open") {
        sessionData.connected = true;
        sessionData.qr = null;
        resetReconnectDelay(id);
        const me = sock.user?.id || sock.authState?.creds?.me?.id || "unknown";
        console.log(`✅ [${id}] WhatsApp connected! Bot JID: ${me}`);
      }

      if (connection === "close") {
        sessionData.connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`🚫 [${id}] Session logged out. Clearing auth and regenerating QR...`);
          sessionData.qr = null;
          reconnectAttempts.set(id, 0);
          sessions.delete(id);
          // Clear invalid auth files
          try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
          // Re-initialize with fresh auth (will generate new QR)
          try {
            await initSingleSession(config);
          } catch (err) {
            console.error(`[${id}] Re-init after logout failed:`, err.message);
          }
          return;
        }

        if (statusCode === DisconnectReason.restartRequired) {
          console.log(`🔄 [${id}] Server restart requested, reconnecting...`);
        } else {
          console.log(
            `⚠️ [${id}] Connection closed (${statusCode || "unknown"}). Reason:`,
            lastDisconnect?.error?.message || "unknown",
          );
        }

        // Reconnect with backoff
        const delay = getReconnectDelay(id);
        console.log(`[${id}] Reconnecting in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
        try {
          await initSingleSession(config);
        } catch (err) {
          console.error(`[${id}] Reconnect error:`, err.message);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      // Process "notify" (new messages) and recent "append" (history sync of recent messages)
      if (type !== "notify" && type !== "append") return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        // Skip old append messages (only process recent ones)
        if (type === "append") {
          const msgAge = (Date.now() / 1000) - (msg.messageTimestamp || 0);
          if (msgAge > 60) continue;
        }

        const normalized = normalizeMessage(msg, id);
        if (!normalized) continue;

        // Skip non-message events (reactions, status, etc.)
        if (normalized.type === "unknown") continue;

        // Handle image/video media - download and save
        if (normalized.hasMedia && normalized.rawMessage) {
          try {
            const buffer = await downloadMediaMessage(
              normalized.rawMessage,
              "buffer",
              {},
              { logger: undefined },
            );
            const ext =
              normalized.type === "image"
                ? normalized.rawMessage.message.imageMessage?.mimetype === "image/png"
                  ? "png"
                  : "jpg"
                : normalized.type === "video"
                  ? "mp4"
                  : "bin";
            const fileName = `receipt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
            const filePath = path.join(process.cwd(), "uploads", fileName);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, buffer);

            const baseUrl = process.env.APP_HOST || "";
            const imageUrl = `${baseUrl}/uploads/${fileName}`;
            normalized.media = {
              data: buffer.toString("base64"),
              mimetype: normalized.rawMessage.message.imageMessage?.mimetype || "image/jpeg",
              url: imageUrl,
              fileName,
            };
            console.log(`[${id}] Media saved: ${fileName}`);
          } catch (err) {
            console.error(`[${id}] Error downloading media:`, err.message);
            // Continue processing even if media download fails
          }
        }

        if (messageHandler) {
          try {
            await messageHandler(normalized);
          } catch (err) {
            console.error(`[${id}] Error in message handler:`, err.message, err.stack);
          }
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messages.update", () => {}); // noop, required to avoid unhandled rejection

    return sessionData;
  } catch (err) {
    console.error(`[${id}] Failed to initialize session:`, err.message);
    sessions.delete(id);
    return null;
  }
}

// ====== Public API (compatible with openwaClient.js) ======

async function initSession() {
  console.log("=== BAILEYS STARTUP ===");
  console.log(`Sessions configured: ${SESSIONS_CONFIG.map((c) => c.id).join(", ")}`);

  const results = [];
  for (const config of SESSIONS_CONFIG) {
    const session = await initSingleSession(config);
    results.push({
      id: config.id,
      connected: session?.connected || false,
    });
  }

  const connected = results.filter((r) => r.connected).length;
  console.log(`\n✅ ${connected}/${results.length} sessions connected`);
  if (connected < results.length) {
    console.log("📱 Check QR endpoints for pending sessions\n");
  }

  return {
    sessions: results,
    status: connected > 0 ? "CONNECTED" : "qr_ready",
  };
}

async function sendWhatsAppMessage(to, text, chatId, sessionName) {
  if (!chatId) {
    chatId = `${to}@s.whatsapp.net`;
  }
  chatId = normalizeJid(chatId);

  // Find session
  let session;
  if (sessionName && sessions.has(sessionName)) {
    session = sessions.get(sessionName);
  } else {
    // Use first connected session
    for (const [name, s] of sessions) {
      if (s.connected) {
        session = s;
        sessionName = name;
        break;
      }
    }
  }

  if (!session || !session.connected) {
    throw new Error(`No WhatsApp session available. Connected sessions: ${
      Array.from(sessions.entries()).filter(([, s]) => s.connected).map(([n]) => n).join(", ") || "none"
    }`);
  }

  await retryWithBackoff(async () => {
    const result = await session.sock.sendMessage(chatId, { text });
    console.log(`[${sessionName}] Message sent to ${chatId}`);
    return result;
  });
}

async function sendImage(to, imageUrl, caption, chatId, sessionName) {
  if (!chatId) {
    chatId = `${to}@s.whatsapp.net`;
  }
  chatId = normalizeJid(chatId);

  // Find session
  let session;
  if (sessionName && sessions.has(sessionName)) {
    session = sessions.get(sessionName);
  } else {
    for (const [name, s] of sessions) {
      if (s.connected) {
        session = s;
        sessionName = name;
        break;
      }
    }
  }

  if (!session || !session.connected) {
    throw new Error(`No WhatsApp session available`);
  }

  await retryWithBackoff(async () => {
    const result = await session.sock.sendMessage(chatId, {
      image: { url: imageUrl },
      caption: caption || undefined,
    });
    console.log(`[${sessionName}] Image sent to ${chatId}`);
    return result;
  });
}

function onMessage(handler) {
  messageHandler = handler;
}

function getAllSessions() {
  return Array.from(sessions.entries()).map(([name, s]) => ({
    name,
    connected: s.connected,
    qr: s.qr ? true : false,
  }));
}

function getSessionQR(sessionName) {
  const session = sessions.get(sessionName);
  if (!session) return null;
  return session.qr || null;
}

function getSessionStatus() {
  return Array.from(sessions.entries()).map(([name, s]) => ({
    name,
    connected: s.connected,
    hasQR: !!s.qr,
  }));
}

// Ensure webhook compatibility (noop - webhooks are not used with Baileys)
async function ensureWebhookRegistered() {
  console.log("Baileys: webhooks not needed (direct events)");
}

async function getOrCreateSession() {
  return initSession();
}

module.exports = {
  sendWhatsAppMessage,
  sendImage,
  initSession,
  getOrCreateSession,
  ensureWebhookRegistered,
  getSessionStatus,
  getAllSessions,
  getSessionQR,
  onMessage,
};
