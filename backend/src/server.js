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
  claimSubmission,
} = require("./memory");

const { extractCustomerData } = require("./extractor");
const { processMessage, WELCOME_MESSAGE, FLOW_STATES, resetFlow } = require("./flow");
const { syncLeadToCRM } = require("./crmClient");
const { initSession, onMessage, getAllSessions, getSessionQR, resolvePhoneFromChatId, resolveChatIdFromPhone } = require("./baileysClient");

const REQUIRED_ENV_VARS = [
  "PORT",
  "DEEPSEEK_API_KEY",
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

// ── OpenWa-compatible API key auth ──
const OPENWA_API_KEY = process.env.OPENWA_API_KEY || '';

function requireApiKey(req, res, next) {
  if (!OPENWA_API_KEY) return next();
  const key = req.headers['x-api-key'];
  if (key !== OPENWA_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Webhook store (persisted to baileys-auth volume) ──
const WEBHOOKS_FILE = '/app/auth/webhooks.json';
const fs_webhooks = require('fs');

function loadWebhooks() {
  try {
    if (fs_webhooks.existsSync(WEBHOOKS_FILE)) {
      return JSON.parse(fs_webhooks.readFileSync(WEBHOOKS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading webhooks:', e.message);
  }
  return {};
}

function saveWebhooks() {
  try {
    fs_webhooks.writeFileSync(WEBHOOKS_FILE, JSON.stringify(webhooks, null, 2));
  } catch (e) {
    console.error('Error saving webhooks:', e.message);
  }
}

let webhooks = loadWebhooks();

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

// Per-user processing queue to serialize messages and prevent race conditions
const userLocks = new Map();

function withUserLock(phone, fn) {
  const prev = userLocks.get(phone) || Promise.resolve();
  const current = prev.then(fn, fn); // run fn even if prev rejected
  // Clean up when this is the last in the chain
  current.finally(() => {
    if (userLocks.get(phone) === current) {
      userLocks.delete(phone);
    }
  });
  userLocks.set(phone, current);
  return current;
}

async function safeSend(to, text, chatId, sessionId) {
  try {
    await sendWhatsAppMessage(to, text, chatId, sessionId);
    return true;
  } catch (err) {
    console.error("!!! FAILED TO SEND WHATSAPP MESSAGE !!!");
    console.error("To:", to, "Text:", text?.substring(0, 100));
    console.error("Send error:", err.message);
    return false;
  }
}

async function handleIncomingMessage(msg) {
  // msg format: { from, chatId, sessionId, text, type, hasMedia, media, id, fromMe, rawMessage }

  // Dedup and quick filters before acquiring the user lock
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

  const phone = msg.from;

  // Serialize processing per user to prevent state race conditions
  return withUserLock(phone, () => processMessageLocked(msg));
}

async function processMessageLocked(msg) {
  const tStart = Date.now();

  try {
    const from = msg.from;
    const chatId = msg.chatId;
    const sessionId = msg.sessionId;
    const text = msg.text || "";
    const msgType = msg.type || "chat";
    const hasMedia = msg.hasMedia || false;

    console.log("=== MESSAGE RECEIVED ===");
    console.log("From:", from, "Text:", text, "Type:", msgType, "HasMedia:", hasMedia, "Session:", sessionId);
    if (hasMedia && msg.media) console.log("Media URL:", msg.media.url);

    // ── Sessions con webhooks registrados: saltar flow interno, solo forward ──
    const sessionWebhooks = webhooks[sessionId] || [];
    const hasExternalWebhooks = sessionWebhooks.length > 0;

    if (hasExternalWebhooks) {
      // Save message to DB for audit
      await db.query(
        `INSERT INTO messages(phone, message, direction)
         VALUES($1, $2, 'in')`,
        [from, text || `[${msgType}]`],
      ).catch(() => {});

      await createCustomer(from).catch(() => {});

      // Forward to webhook only — external service handles response.
      // Keep original chatId format for LID support (linked devices).
      const webhookChatId = msg.chatId || '';
      const payload = {
        event: 'message.received',
        session: { id: msg.sessionId, name: msg.sessionId },
        message: {
          from: msg.from,
          chatId: webhookChatId,
          body: msg.text || msg.media?.url || '',
          text: msg.text || '',
          type: msg.type || 'chat',
          hasMedia: msg.hasMedia || false,
          mediaUrl: msg.media?.url || null,
          mediaMime: msg.media?.mimetype || null,
        },
        from: msg.from,
        chatId: webhookChatId,
      };
      for (const wh of sessionWebhooks) {
        fetch(wh.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(e => console.error(`[Webhook] Forward to ${wh.url} failed:`, e.message));
      }
      console.log(`[Webhook] Session ${sessionId} forwarded to ${sessionWebhooks.length} webhook(s), skipping internal flow`);
      return;
    }

    if (msgType === "image") {
      const imageUrl = msg.media?.url || "";

      await db.query(
        `INSERT INTO messages(phone, message, image_url, direction)
         VALUES($1, $2, $3, 'in')`,
        [from, `[Imagen: ${msg.id}]`, imageUrl],
      );

      await createCustomer(from);
      const customer = await getCustomer(from);
      const currentState = customer?.flow_state || "";

      if (currentState === "image") {
        await updateCustomerMemory(from, "receipt_image", imageUrl);
        const flowResult = await processMessage(from, "imagen_recibida", USE_AI);
        const imgSendOk = await safeSend(from, flowResult.text, chatId, sessionId);
        if (imgSendOk) {
          await db.query(
            `INSERT INTO messages(phone, message, direction)
             VALUES($1, $2, 'out')`,
            [from, flowResult.text],
          );
        }

        if (flowResult.nextState === "complete") {
          const claimed = await claimSubmission(from);
          if (claimed) {
            console.log("Flow completado via imagen, sincronizando...");
            const crmOk = await syncLeadToCRM(claimed, sessionId);
            if (!crmOk) {
              await updateCustomerMemory(from, "submitted", "false");
              console.log("CRM falló (imagen), submitted revertido para reintento");
            }
          } else {
            console.log("Ya procesado anteriormente (imagen), omitiendo");
          }
        }
      } else {
        await safeSend(from, "¡Gracias por compartir la imagen! 📸 Un asesor la revisará pronto.", chatId, sessionId);
      }

      console.log("=== IMAGE PROCESSED OK ===");
      return;
    }

    if (!text) {
      console.log("Mensaje sin texto, ignorando");
      return;
    }

    await db.query(
      `INSERT INTO messages(phone, message, direction)
       VALUES($1, $2, 'in')`,
      [from, text],
    );

    await createCustomer(from);
    const customer = await getCustomer(from);

    if (text && (text.toLowerCase().includes("reiniciar") || text.toLowerCase().includes("empezar de nuevo"))) {
      await updateCustomerMemory(from, "submitted", "false");
      await resetFlow(from);
      await safeSend(from, WELCOME_MESSAGE, chatId, sessionId);
      console.log("=== FLOW RESET ===");
      return;
    }

    if (USE_AI && text && (text.toLowerCase().includes("hablar con ia") || text.toLowerCase().includes("hablar con人工"))) {
      const aiResponse1 = await askAI(text, customer);
      const aiSendOk1 = await safeSend(from, aiResponse1, chatId, sessionId);
      if (aiSendOk1) {
        await db.query(
          `INSERT INTO messages(phone, message, direction)
           VALUES($1, $2, 'out')`,
          [from, aiResponse1],
        );
      }
      console.log("=== AI MODE ===");
      return;
    }

    const flowResult = await processMessage(from, text, USE_AI);

    if (flowResult.useAI && USE_AI) {
      const aiResponse1 = await askAI(text, customer);
      const aiSendOk1 = await safeSend(from, aiResponse1, chatId, sessionId);
      if (aiSendOk1) {
        await db.query(
          `INSERT INTO messages(phone, message, direction)
           VALUES($1, $2, 'out')`,
          [from, aiResponse1],
        );
      }
    } else {
      console.log("Enviando respuesta a", from, "con chatId", chatId);
      const sendOk = await safeSend(from, flowResult.text, chatId, sessionId);
      if (sendOk) {
        console.log("Respuesta enviada OK");
        await db.query(
          `INSERT INTO messages(phone, message, direction)
           VALUES($1, $2, 'out')`,
          [from, flowResult.text],
        );
      }
    }

    if (flowResult.nextState === "complete") {
      const claimed = await claimSubmission(from);
      if (claimed) {
        console.log("Flow completado, sincronizando...");
        const crmOk = await syncLeadToCRM(claimed, sessionId);
        if (!crmOk) {
          await updateCustomerMemory(from, "submitted", "false");
          console.log("CRM falló, submitted revertido para reintento");
        }
      } else {
        console.log("Ya procesado anteriormente, omitiendo");
      }
    }

    // Webhook forwarding moved to top of function for sessions with webhooks

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

// ====== OpenWa-compatible API ======

// GET /api/sessions — list all WhatsApp sessions
app.get('/api/sessions', requireApiKey, (req, res) => {
  const allSessions = getAllSessions();
  res.json(allSessions.map(s => ({
    id: s.name,
    name: s.name,
    status: s.connected ? 'CONNECTED' : 'DISCONNECTED',
  })));
});

// POST /api/sessions — create/register a session (noop — sessions are pre-configured)
app.post('/api/sessions', requireApiKey, (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Session name required' });
  // Session already exists in Baileys config; just return its id
  res.json({ id: name, name, status: 'created' });
});

// GET /api/sessions/:id — get single session status
app.get('/api/sessions/:id', requireApiKey, (req, res) => {
  const allSessions = getAllSessions();
  const session = allSessions.find(s => s.name === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    id: session.name,
    name: session.name,
    status: session.connected ? 'CONNECTED' : 'DISCONNECTED',
  });
});

// GET /api/sessions/:id/webhooks — list registered webhooks
app.get('/api/sessions/:id/webhooks', requireApiKey, (req, res) => {
  const sessionWebhooks = webhooks[req.params.id] || [];
  res.json(sessionWebhooks);
});

// POST /api/sessions/:id/webhooks — register a webhook
app.post('/api/sessions/:id/webhooks', requireApiKey, (req, res) => {
  const { url, events } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Webhook URL required' });

  if (!webhooks[req.params.id]) webhooks[req.params.id] = [];
  const sessionWebhooks = webhooks[req.params.id];

  // Avoid duplicates
  if (!sessionWebhooks.some(w => w.url === url)) {
    sessionWebhooks.push({ url, events: events || ['message.received'], registeredAt: new Date().toISOString() });
    saveWebhooks();
    console.log(`[Webhook] Registered for session ${req.params.id}: ${url}`);
  }

  res.json({ success: true, url, events: events || ['message.received'] });
});

// DELETE /api/sessions/:id/webhooks — remove a webhook by URL
app.delete('/api/sessions/:id/webhooks', requireApiKey, (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Webhook URL required' });

  if (webhooks[req.params.id]) {
    webhooks[req.params.id] = webhooks[req.params.id].filter(w => w.url !== url);
    saveWebhooks();
  }
  res.json({ success: true });
});

// POST /api/sessions/:id/messages/send-text — send WhatsApp message
app.post('/api/sessions/:id/messages/send-text', requireApiKey, async (req, res) => {
  const { chatId, text } = req.body || {};
  if (!chatId || !text) return res.status(400).json({ error: 'chatId and text are required' });

  try {
    // Extract phone from chatId for the sendWhatsAppMessage call
    const to = (chatId || '').replace(/@.+$/, '');
    // Resolver el jid correcto (LID / prefijo local / estándar) desde el phone
    const jid = resolveChatIdFromPhone(to) || chatId;
    await sendWhatsAppMessage(to, text, jid, req.params.id);
    // Log del saliente para que el hilo del chat quede completo
    await db.query(
      `INSERT INTO messages(phone, message, direction)
       VALUES($1, $2, 'out')`,
      [to, text],
    ).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error(`[API] send-text error (session ${req.params.id}):`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:id/messages — historial de mensajes del chat (openwa-compatible)
app.get('/api/sessions/:id/messages', requireApiKey, async (req, res) => {
  try {
    const chatId = String(req.query.chatId || '');
    const phoneParam = String(req.query.phone || '');
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    // Candidatos de identidad: número del chatId, LID resuelto, y phone explícito
    // (los mensajes se guardan por phone numérico, con variantes -device y LID)
    const candidates = [];
    const raw = chatId.split('@')[0];
    if (raw) candidates.push(raw);
    if (chatId.includes('@lid')) {
      const resolved = resolvePhoneFromChatId(chatId);
      if (resolved) candidates.push(resolved);
    }
    if (phoneParam) candidates.push(phoneParam.replace(/\D/g, ''));
    const unique = [...new Set(candidates)].filter(Boolean);
    if (unique.length === 0) return res.status(400).json({ error: 'chatId or phone required' });

    const patterns = unique.map(c => c + '-%');
    const result = await db.query(
      `SELECT id, phone, message, image_url, direction,
              (created_at AT TIME ZONE 'UTC') AS created_at,
              count(*) OVER () AS total
       FROM messages
       WHERE phone = ANY($1::text[]) OR phone LIKE ANY($2::text[])
       ORDER BY created_at DESC, id DESC
       LIMIT $3 OFFSET $4`,
      [unique, patterns, limit, offset],
    );

    const total = result.rows.length ? Number(result.rows[0].total) : 0;
    const messages = result.rows
      .reverse() // DESC → ASC cronológico
      .map(r => ({
        id: r.id,
        chatId,
        fromMe: r.direction === 'out',
        text: r.message,
        timestamp: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        type: r.image_url ? 'image' : /^\[.*\]$/.test(r.message || '') ? 'media' : 'chat',
      }));

    res.json({ messages, total, limit, offset });
  } catch (err) {
    console.error('[API] messages error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ====== Startup ======

app.listen(process.env.PORT, "0.0.0.0", async () => {
  console.log(`Servidor corriendo en puerto ${process.env.PORT}`);

  // Migración idempotente: dirección de los mensajes (in/out) para el chat del CRM
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS direction VARCHAR(8) NOT NULL DEFAULT 'in'`)
    .catch(() => {});

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
