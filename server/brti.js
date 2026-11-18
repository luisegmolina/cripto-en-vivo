// v13.5 — Valor en vivo de Kalshi (BRTI) por WebSocket, SOLO LECTURA.
//
// Por qué hace falta: el mercado BTC 15 min (KXBTC15M) NO se liquida
// con Coinbase ni con Pyth, sino con el índice CF Benchmarks BRTI
// (promedio de 60 segundos al final de la ventana, 7 exchanges).
// El precio de Coinbase puede diferir del de liquidación, así que
// la pestaña Kalshi mostraba el precio equivocado para decidir si
// vas ganando o perdiendo.
//
// Cómo funciona (verificado contra docs.kalshi.com, nov-2026):
// - WebSocket: wss://external-api-ws.kalshi.com/trade-api/ws/v2
//   (el host legacy wss://api.elections.kalshi.com/trade-api/ws/v2
//   también sigue soportado; se usa el primero).
// - La conexión EXIGE autenticación en el handshake, incluso para
//   datos públicos: tres cabeceras KALSHI-ACCESS-KEY /
//   KALSHI-ACCESS-SIGNATURE / KALSHI-ACCESS-TIMESTAMP. El mensaje
//   firmado es `{timestamp}GET/trade-api/ws/v2` (misma firma que
//   REST: Ed25519 directa, RSA-PSS SHA-256). Por eso el WebSocket
//   se abre SOLO desde este servidor, con la clave del usuario ya
//   conectado, nunca desde el navegador (el WebSocket del navegador
//   no puede poner cabeceras y expondría la clave).
// - Suscripción: {"id":1,"cmd":"subscribe","params":
//   {"channels":["cfbenchmarks_value"],"index_ids":["BRTI"]}}.
// - Cada mensaje trae el valor BRTI en vivo, el promedio de los
//   últimos 60 s (avg_60s_data.value) y, en el último minuto de la
//   ventana, el promedio final de la ventana
//   (last_60s_windowed_average_15min), que es el número que liquida.
// - OJO con la forma del mensaje (verificado en tráfico real por
//   terceros): `msg.data` es un STRING JSON, no un objeto — hay que
//   decodificarlo dos veces. `avg_60s_data` sí es un objeto normal.
//   El timestamp del tick es `received_at` (epoch ms) a nivel del
//   cuerpo, no un campo `ts_ms`.
//
// REGLA DURA: este módulo solo LEE el índice. No hay suscripción a
// canales privados de órdenes/posiciones, no hay envío de órdenes,
// no hay POST a Kalshi. La clave privada solo se usa aquí para
// firmar el handshake y nunca sale de este servidor.
//
// Entrega al frontend: el servidor mantiene UNA conexión por usuario
// conectado y guarda el último valor en memoria. El frontend sondea
// GET /api/kalshi/brti (autenticado, JWT) cada pocos segundos y lee
// ese último valor (caché de 1-2 s en la práctica, porque el WS
// empuja ~1 tick/s). Si el usuario NO tiene Kalshi conectado, NO se
// abre ninguna conexión a Kalshi y el endpoint responde
// connected:false: el cliente cae a Coinbase con aviso, nunca en
// blanco. Si el WS falla o no hay dato, el endpoint lo dice
// (source 'kalshi-unavailable') y el cliente también cae a Coinbase.
// Una conexión sin sondeo durante 5 min se cierra sola (límite de
// conexiones concurrentes de Kalshi + plan gratis de Render).
const WebSocket = require('ws');
const { signHeaders } = require('./kalshiServer');

const WS_URL = process.env.KALSHI_WS_URL || 'wss://external-api-ws.kalshi.com/trade-api/ws/v2';
const BRTI_INDEX_ID = 'BRTI';
const IDLE_CLOSE_MS = 5 * 60 * 1000; // sin sondeo 5 min: cerrar la conexión
const MAX_BACKOFF_MS = 60 * 1000;

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// avg_60s_data puede venir como {value: "70300.12"} o como número
// directo; last_60s_windowed_average_15min igual.
function avgFieldToNumber(v) {
  if (v == null) return null;
  if (typeof v === 'object') return numOrNull(v.value ?? v.avg ?? v.average);
  return numOrNull(v);
}

// Parsea UN mensaje del canal cfbenchmarks_value.
// Devuelve {value, avg60s, avg15mFinal, receivedAt} o null si no es
// un tick BRTI válido. Función pura, probada en Node.
function parseCfBenchmarksMessage(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.type && parsed.type !== 'cfbenchmarks_value') return null;
  // El cuerpo útil va en parsed.msg (SDK) o directo en parsed.
  const payload = (parsed.msg && typeof parsed.msg === 'object') ? parsed.msg : parsed;
  // `data` es un STRING JSON: {"type":"value","time":...,"id":"BRTI",
  // "value":"65766.03"} — segunda decodificación obligatoria.
  let data = payload.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return null; }
  }
  if (!data || typeof data !== 'object') return null;
  const indexId = data.id || payload.index_id || payload.indexId || null;
  if (indexId && indexId !== BRTI_INDEX_ID) return null;
  const value = numOrNull(data.value ?? payload.value);
  if (value == null) return null;
  const avg60s = avgFieldToNumber(payload.avg_60s_data);
  const avg15mFinal = avgFieldToNumber(payload.last_60s_windowed_average_15min);
  const receivedAt = numOrNull(payload.received_at ?? data.time ?? parsed.received_at)
    || Date.now();
  return { value, avg60s, avg15mFinal, receivedAt };
}

// Cabeceras del handshake WS: misma firma que REST, con el mensaje
// fijo `{timestamp}GET/trade-api/ws/v2`.
function wsAuthHeaders({ keyId, privateKeyPem }) {
  return signHeaders({ keyId, privateKeyPem, method: 'GET', path: '/trade-api/ws/v2' });
}

// --- Una conexión por usuario conectado ---
const connections = new Map(); // userId -> {ws, state, backoffMs, reconnectTimer, idleTimer, creds}

function freshState() {
  return { value: null, avg60s: null, avg15mFinal: null, updatedAt: null, status: 'connecting', error: null, lastPollAt: Date.now() };
}

function scheduleReconnect(userId, entry) {
  if (entry.reconnectTimer) return;
  const delay = entry.backoffMs;
  entry.backoffMs = Math.min(entry.backoffMs * 2, MAX_BACKOFF_MS);
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    if (!connections.has(userId)) return;
    if (Date.now() - entry.state.lastPollAt > IDLE_CLOSE_MS) { stopBrti(userId); return; }
    connectWs(userId, entry);
  }, delay);
  if (entry.reconnectTimer.unref) entry.reconnectTimer.unref();
}

function connectWs(userId, entry) {
  let headers;
  try {
    headers = wsAuthHeaders(entry.creds);
  } catch (e) {
    entry.state.status = 'error';
    entry.state.error = `No se pudo firmar el handshake de Kalshi: ${e.message}`;
    return;
  }
  entry.state.status = 'connecting';
  let ws;
  try {
    ws = new WebSocket(WS_URL, { headers });
  } catch (e) {
    entry.state.status = 'error';
    entry.state.error = `No se pudo abrir el WebSocket de Kalshi: ${e.message}`;
    scheduleReconnect(userId, entry);
    return;
  }
  entry.ws = ws;
  ws.on('open', () => {
    entry.backoffMs = 1000;
    entry.state.status = 'connected';
    entry.state.error = null;
    try {
      ws.send(JSON.stringify({ id: 1, cmd: 'subscribe', params: { channels: ['cfbenchmarks_value'], index_ids: [BRTI_INDEX_ID] } }));
    } catch (e) {
      entry.state.status = 'error';
      entry.state.error = `No se pudo suscribir al canal BRTI: ${e.message}`;
    }
  });
  ws.on('message', (data) => {
    const tick = parseCfBenchmarksMessage(data.toString());
    if (!tick) return; // respuestas subscribed/indexlist/errores: se ignoran, no son ticks
    entry.state.value = tick.value;
    entry.state.avg60s = tick.avg60s;
    entry.state.avg15mFinal = tick.avg15mFinal;
    entry.state.updatedAt = new Date(tick.receivedAt).toISOString();
    entry.state.status = 'live';
    entry.state.error = null;
  });
  ws.on('error', (e) => {
    entry.state.status = 'error';
    entry.state.error = `WebSocket de Kalshi: ${e.message || e}`;
  });
  ws.on('close', () => {
    entry.ws = null;
    if (entry.state.status !== 'error') {
      entry.state.status = 'error';
      entry.state.error = 'La conexión WebSocket con Kalshi se cerró.';
    }
    if (connections.has(userId)) scheduleReconnect(userId, entry);
  });
}

// Arranca (o reutiliza) la conexión BRTI de un usuario. Solo se
// llama desde la ruta autenticada /api/kalshi/brti, con las
// credenciales descifradas del usuario. Sin credenciales no se
// llama nunca: sin Kalshi conectado no hay conexión.
function ensureBrti(userId, creds) {
  let entry = connections.get(userId);
  if (entry) {
    entry.state.lastPollAt = Date.now();
    entry.creds = creds; // la clave pudo cambiar al reconectar
    if (!entry.ws && !entry.reconnectTimer) connectWs(userId, entry);
    return entry.state;
  }
  entry = { ws: null, state: freshState(), backoffMs: 1000, reconnectTimer: null, creds };
  connections.set(userId, entry);
  connectWs(userId, entry);
  return entry.state;
}

function getBrtiState(userId) {
  const entry = connections.get(userId);
  if (!entry) return null;
  entry.state.lastPollAt = Date.now();
  return entry.state;
}

function stopBrti(userId) {
  const entry = connections.get(userId);
  if (!entry) return;
  connections.delete(userId);
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  try { entry.ws && entry.ws.close(); } catch { /* ya cerrado */ }
}

module.exports = { WS_URL, BRTI_INDEX_ID, parseCfBenchmarksMessage, wsAuthHeaders, ensureBrti, getBrtiState, stopBrti };
