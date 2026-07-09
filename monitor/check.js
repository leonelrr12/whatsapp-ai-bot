const axios = require("axios");
const fs = require("fs");
const path = require("path");

const STATE_FILE = "/data/state.json";
const CHECK_INTERVAL = (parseInt(process.env.CHECK_INTERVAL) || 300) * 1000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BACKEND_URL = process.env.BACKEND_URL || "http://backend:3000";
const OPENWA_URL = process.env.OPENWA_URL || "http://openwa-api:2785";
const OPENWA_API_KEY = process.env.OPENWA_API_KEY;

let state = {};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch { state = {}; }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function formatDate() {
  return new Date().toISOString();
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(`[${formatDate()}] TELEGRAM no configurado. Mensaje:\n${message}`);
    return;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      },
      { timeout: 10000 },
    );
    console.log(`[${formatDate()}] Alerta enviada por Telegram`);
  } catch (err) {
    console.error(`[${formatDate()}] Error enviando Telegram:`, err.message);
  }
}

async function checkService(name, url, key) {
  try {
    const headers = key ? { "X-API-Key": key } : {};
    const res = await axios.get(url, { headers, timeout: 8000 });
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return { ok: false, status: err.response?.status, error: err.message };
  }
}

async function checkBackend() {
  const result = await checkService("backend", `${BACKEND_URL}/health`);
  if (result.ok && result.data && result.data.db === "connected") {
    return { ok: true, detail: "DB conectada" };
  }
  return {
    ok: false,
    detail: result.data ? `DB: ${result.data.db}` : result.error,
  };
}

async function checkOpenWA() {
  const result = await checkService("openwa-api", `${OPENWA_URL}/api/health`, OPENWA_API_KEY);
  if (result.ok) {
    return { ok: true, detail: "API saludable" };
  }
  return { ok: false, detail: result.error };
}

async function checkSession() {
  try {
    const { data } = await axios.get(`${OPENWA_URL}/api/sessions`, {
      headers: OPENWA_API_KEY ? { "X-API-Key": OPENWA_API_KEY } : {},
      timeout: 8000,
    });
    if (!Array.isArray(data) || data.length === 0) {
      return { ok: false, detail: "Sin sesiones" };
    }
    const session = data[0];
    const connected = session.status === "CONNECTED" || session.status === "ready";
    return {
      ok: connected,
      detail: connected
        ? `Conectado: ${session.pushName || session.name}`
        : `Estado: ${session.status}`,
    };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

async function doCheck() {
  const results = {
    timestamp: formatDate(),
    backend: await checkBackend(),
    openwa: await checkOpenWA(),
    session: await checkSession(),
  };

  const allOk = results.backend.ok && results.openwa.ok && results.session.ok;
  const summary = allOk ? "✅ TODOS LOS SERVICIOS OK" : "❌ ALERTA - Servicios con fallo";

  let message = `<b>${summary}</b>\n\n`;
  message += `📡 Backend: ${results.backend.ok ? "✅" : "❌"} ${results.backend.detail}\n`;
  message += `🔌 OpenWA:  ${results.openwa.ok ? "✅" : "❌"} ${results.openwa.detail}\n`;
  message += `📱 Sesión:   ${results.session.ok ? "✅" : "❌"} ${results.session.detail}\n`;
  message += `\n🕐 ${results.timestamp}`;

  console.log(`\n=== CHECK ${results.timestamp} ===`);
  console.log(`Backend: ${results.backend.ok ? "OK" : "FAIL"} - ${results.backend.detail}`);
  console.log(`OpenWA:  ${results.openwa.ok ? "OK" : "FAIL"} - ${results.openwa.detail}`);
  console.log(`Session: ${results.session.ok ? "OK" : "FAIL"} - ${results.session.detail}`);

  const lastState = state.lastAllOk;

  if (allOk && lastState === false) {
    await sendTelegram(`🟢 <b>RECUPERACIÓN</b>\n\nTodos los servicios funcionan de nuevo.\n\n${message}`);
  } else if (!allOk && lastState !== false) {
    await sendTelegram(message);
  }

  state.lastAllOk = allOk;
  state.lastResults = results;
  saveState();
}

loadState();
console.log(`Monitor iniciado - intervalo: ${CHECK_INTERVAL / 1000}s`);

doCheck();
setInterval(doCheck, CHECK_INTERVAL);
