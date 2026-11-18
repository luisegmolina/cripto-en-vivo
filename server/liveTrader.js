// liveTrader.js — v16.2: BOT EN VIVO, APAGADO POR DEFECTO.
//
// El código de órdenes reales EXISTE, pero es IMPOSIBLE enviar una
// orden por accidente con la configuración actual:
//
//   1. Interruptor global: LIVE_ENABLED = process.env.LIVE_TRADING_ENABLED
//      === 'true'. Por defecto es false (en Render hoy NO está puesta).
//      Mientras sea false, enviarOrdenReal RECHAZA antes de tocar la
//      red y cada señal viable se registra solo como would-send.
//   2. Armado por usuario: aunque el interruptor global estuviera en
//      true, nadie opera sin armarse en POST /kalshi/live/enable, que
//      además devuelve 403 mientras la env no sea 'true'.
//   3. Kill switch por usuario (POST /kalshi/live/kill, siempre
//      disponible): detiene todo inmediatamente y es persistente.
//   4. Límites duros (ver abajo): al alcanzarlos, auto-detiene.
//
// QUÉ MATERIAL HACE FALTA PARA FIRMAR: NINGUNO NUEVO. El servidor ya
// guarda la clave privada de Kalshi del usuario, CIFRADA (AES-256-GCM,
// ver crypto.js + db.getKalshiConnection): el mismo keyId +
// privateKeyPem que kalshiGet usa para los GET de solo lectura sirve
// para firmar POST. El envío real reutiliza signHeaders() de
// kalshiServer.js (Ed25519 o RSA-PSS, mensaje timestamp + MÉTODO +
// ruta) — NO se inventa otra firma ni se toca READ_ONLY_PATHS, que
// sigue siendo solo GET. La clave se descifra SOLO en el servidor y
// SOLO en el camino de envío real; en modo would-send (live apagado)
// nunca se descifra ni se pide.
//
// QUÉ HACE (solo sobre señales VIABLES del auditor en papel):
//   - live apagado -> registra would-send (qué se habría enviado, con
//     payload V2 completo) SIN enviar nada ni tocar la red.
//   - live encendido + armado + límites OK -> envía UNA orden por
//     ventana con POST /trade-api/v2/portfolio/events/orders, con el
//     payload de construirPayloadOrdenV2 (reutilizado de paperAuditor,
//     no duplicado).
//   - Ninguna ruta envía órdenes directamente: las órdenes solo salen
//     desde aquí, al evaluar una señal viable del auditor.
//
// LÍMITES DUROS (defaults conservadores, documentados):
//   - MAX_CONTRACTS_PER_ORDER = 2 (el auditor ya usa 2).
//   - MAX_ORDERS_PER_DAY = 5 órdenes enviadas por usuario y día.
//   - MAX_DAILY_LOSS_USD = 20: pérdida POTENCIAL máxima acumulada
//     por día. Se cuenta como peor caso (contratos a $0: (ask + fee) ×
//     cantidad), NO como P&L realizado: es conservadora por diseño,
//     porque la liquidación llega después y el trader no la persigue.
//   - MAX_CONSECUTIVE_ERRORS = 3: 3 envíos fallidos seguidos
//     (red o Kalshi) auto-detenienen al usuario (kill).
// El día es UTC (YYYY-MM-DD). Los contadores se reinician al cambiar
// de día; los errores consecutivos solo se reinician con un envío OK.
//
// PERSISTENCIA: el registro de decisiones (would-send / blocked /
// killed / sent) se guarda en cev_user_data kind 'live_trade_log'
// (vía hook setPersistencia, registrado en routes.js), con tope de
// 50 entradas. Sin hook, no se persiste (modo pruebas).
//
// OBSERVADOR: un setInterval global de 1 s (perezoso, con unref)
// recorre los auditores habilitados de paperAuditor y procesa cada
// señal viable UNA sola vez por ticker (dedup en memoria + registro
// persistido). Se apaga solo cuando ya no queda ningún auditor activo.
// NO modifica paperAuditor.js: solo lee sus snapshots.
const { BASE, signHeaders } = require('./kalshiServer');
const { construirPayloadOrdenV2 } = require('./paperAuditor');
const paperAuditor = require('./paperAuditor');

// --- Interruptor global y límites ---

const LIVE_ORDERS_PATH = '/trade-api/v2/portfolio/events/orders';
const MAX_CONTRACTS_PER_ORDER = 2;
const MAX_ORDERS_PER_DAY = 5;
const MAX_DAILY_LOSS_USD = 20;
const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_LOG = 50;

// Lee la env EN CADA LLAMADA (no se cachea al importar): así los
// tests pueden encenderla/apagarla y un cambio en Render aplica al
// reiniciar el proceso, sin recompilar nada.
function isLiveEnabled(env = process.env) {
  return env && env.LIVE_TRADING_ENABLED === 'true';
}

// --- Funciones puras (testeables sin servidor ni Kalshi) ---

// Pérdida potencial máxima de una orden si los contratos expiran a $0:
// (ask + fee) × cantidad. null si los números no son válidos (y eso
// bloquea: no se opera con números que no se pueden calcular).
function calcularPerdidaPotencial({ askPriceDollars, feePerContractDollars, contractsQty }) {
  const ask = Number(askPriceDollars);
  const fee = Number(feePerContractDollars);
  const qty = Number(contractsQty);
  if (!Number.isFinite(ask) || ask <= 0 || ask >= 1) return null;
  if (!Number.isFinite(fee) || fee < 0) return null;
  if (!Number.isFinite(qty) || qty <= 0) return null;
  return +((ask + fee) * qty).toFixed(4);
}

// Día UTC en formato YYYY-MM-DD (para reiniciar los contadores).
function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function crearEstadoTrader() {
  return {
    armed: false,
    killed: false,
    killReason: null,
    killedAt: null,
    day: null,
    ordersToday: 0,
    potentialLossTodayUsd: 0,
    consecutiveErrors: 0,
    lastProcessedTicker: null,
    log: [],
    _loaded: false,
  };
}

// Reinicia los contadores diarios al cambiar de día. Los errores
// consecutivos NO se reinician con el día: solo con un envío OK.
function resetDiaSiCambio(estado, hoy = dayKey()) {
  if (estado.day !== hoy) {
    estado.day = hoy;
    estado.ordersToday = 0;
    estado.potentialLossTodayUsd = 0;
  }
  return estado;
}

// Comprueba los límites duros ANTES de enviar. Devuelve { ok } o
// { ok: false, reason }. Orden de comprobación: kill, armado,
// cantidad, órdenes/día, pérdida diaria, errores consecutivos.
function verificarLimites(estado, senal) {
  if (!estado) return { ok: false, reason: 'not_armed' };
  if (estado.killed) return { ok: false, reason: 'killed' };
  if (!estado.armed) return { ok: false, reason: 'not_armed' };
  const qty = Number(senal && senal.ordenV2Preview && senal.ordenV2Preview.payload
    ? senal.ordenV2Preview.payload.count
    : (senal && senal.contractsQty != null ? senal.contractsQty : NaN));
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: 'bad_quantity' };
  if (qty > MAX_CONTRACTS_PER_ORDER) return { ok: false, reason: 'max_contracts_per_order' };
  if (estado.ordersToday >= MAX_ORDERS_PER_DAY) return { ok: false, reason: 'max_orders_per_day' };
  const perdida = calcularPerdidaPotencial({
    askPriceDollars: senal.askPriceDollars,
    feePerContractDollars: senal.feePerContractDollars,
    contractsQty: qty,
  });
  if (perdida == null) return { ok: false, reason: 'bad_numbers' };
  if (estado.potentialLossTodayUsd + perdida > MAX_DAILY_LOSS_USD) return { ok: false, reason: 'max_daily_loss' };
  if (estado.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return { ok: false, reason: 'max_consecutive_errors' };
  return { ok: true, reason: null, perdidaPotencialUsd: perdida };
}

// Decisión pura sobre una señal viable. NUNCA toca la red.
//   - no viable -> 'ignore' (defensivo: el observador solo llama con viables).
//   - kill -> 'blocked' ('killed'), aunque live esté apagado: matar es matar.
//   - live apagado -> 'would-send' (se registra, no se envía).
//   - live encendido -> límites: 'send' o 'blocked' (con motivo).
function evaluarDecision({ liveEnabled, estado, senal }) {
  if (!senal || senal.viableDespuesDeComision !== true) return { action: 'ignore', reason: 'not_viable', perdidaPotencialUsd: null };
  if (estado && estado.killed) return { action: 'blocked', reason: 'killed', perdidaPotencialUsd: null };
  if (!liveEnabled) return { action: 'would-send', reason: 'live_disabled', perdidaPotencialUsd: null };
  const lim = verificarLimites(estado, senal);
  if (!lim.ok) return { action: 'blocked', reason: lim.reason, perdidaPotencialUsd: null };
  return { action: 'send', reason: null, perdidaPotencialUsd: lim.perdidaPotencialUsd };
}

// --- Envío real (único POST a Kalshi en todo el proyecto) ---

// Envía UNA orden V2 a Kalshi. LO PRIMERO que hace es comprobar el
// interruptor global: con live apagado RECHAZA sin tocar la red (ni
// siquiera firma). `fetchFn` inyectable para pruebas.
// Devuelve { sent, touchedNetwork, order?, status?, reason? }.
// Lanza Error si Kalshi responde no-OK o la red falla (el llamador
// lo cuenta como error consecutivo).
async function enviarOrdenReal({ keyId, privateKeyPem, payload, fetchFn = fetch, timeoutMs = 8000 } = {}) {
  if (!isLiveEnabled()) {
    return { sent: false, touchedNetwork: false, reason: 'live_disabled' };
  }
  if (!keyId || !privateKeyPem) throw new Error('Faltan credenciales de Kalshi para firmar la orden.');
  if (!payload || !payload.ticker) throw new Error('Payload V2 sin ticker: no se envía nada.');
  const headers = signHeaders({ keyId, privateKeyPem, method: 'POST', path: LIVE_ORDERS_PATH });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchFn(BASE + LIVE_ORDERS_PATH, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.message || j.error || `Kalshi HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return { sent: true, touchedNetwork: true, order: j.order || j, status: r.status };
  } finally { clearTimeout(t); }
}

// --- Estado por usuario + hooks inyectables ---

const traders = new Map(); // userId -> estado
let persistenciaHook = null;
let credencialesHook = null;
let cargarEstadoHook = null;
let sendFnHook = null; // por defecto enviarOrdenReal
let observadorInterval = null;
const procesando = new Set(); // `${userId}:${ticker}` en curso

function setPersistencia(fn) { persistenciaHook = typeof fn === 'function' ? fn : null; }
function setCredentialsProvider(fn) { credencialesHook = typeof fn === 'function' ? fn : null; }
function setCargarEstado(fn) { cargarEstadoHook = typeof fn === 'function' ? fn : null; }
function setSendFn(fn) { sendFnHook = typeof fn === 'function' ? fn : null; }

function getEstado(userId) {
  let est = traders.get(userId);
  if (!est) { est = crearEstadoTrader(); traders.set(userId, est); }
  return est;
}

// Carga el estado persistido (log + contadores + kill) una sola vez
// por proceso. Sin hook, no hay nada que cargar (modo pruebas).
async function cargarEstadoSiHaceFalta(userId) {
  const est = getEstado(userId);
  if (est._loaded || !cargarEstadoHook) { est._loaded = true; return est; }
  est._loaded = true;
  try {
    const saved = await cargarEstadoHook(userId);
    if (saved && typeof saved === 'object') {
      if (typeof saved.armed === 'boolean') est.armed = saved.armed;
      if (typeof saved.killed === 'boolean') est.killed = saved.killed;
      if (saved.killReason != null) est.killReason = saved.killReason;
      if (saved.killedAt != null) est.killedAt = saved.killedAt;
      if (typeof saved.day === 'string') est.day = saved.day;
      if (Number.isFinite(saved.ordersToday)) est.ordersToday = saved.ordersToday;
      if (Number.isFinite(saved.potentialLossTodayUsd)) est.potentialLossTodayUsd = saved.potentialLossTodayUsd;
      if (Number.isFinite(saved.consecutiveErrors)) est.consecutiveErrors = saved.consecutiveErrors;
      if (typeof saved.lastProcessedTicker === 'string') est.lastProcessedTicker = saved.lastProcessedTicker;
      if (Array.isArray(saved.log)) est.log = saved.log.slice(-MAX_LOG);
    }
  } catch (e) {
    console.log('[live-trader] No se pudo cargar el registro de trading:', e.message);
  }
  return est;
}

function serializarEstado(est) {
  return {
    armed: est.armed, killed: est.killed, killReason: est.killReason, killedAt: est.killedAt,
    day: est.day, ordersToday: est.ordersToday, potentialLossTodayUsd: est.potentialLossTodayUsd,
    consecutiveErrors: est.consecutiveErrors, lastProcessedTicker: est.lastProcessedTicker,
    log: est.log, updatedAt: new Date().toISOString(),
  };
}

async function persistir(userId) {
  const est = traders.get(userId);
  if (!est || !persistenciaHook) return;
  try { await persistenciaHook(userId, serializarEstado(est)); } catch (e) {
    console.log('[live-trader] No se pudo persistir el registro de trading:', e.message);
  }
}

// Kill switch: detiene todo inmediatamente y desarma. Persistente
// (no se levanta solo: solo POST /kalshi/live/enable, con la env en
// 'true' y decisión explícita del usuario).
async function kill(userId, reason = 'manual') {
  const est = await cargarEstadoSiHaceFalta(userId);
  est.killed = true;
  est.killReason = String(reason || 'manual');
  est.killedAt = new Date().toISOString();
  est.armed = false;
  await persistir(userId);
  return getSnapshot(userId);
}

// Armar para operar (solo lo llama POST /kalshi/live/enable, que ya
// comprobó la env). Levanta el kill y resetea los errores consecutivos.
async function arm(userId) {
  const est = await cargarEstadoSiHaceFalta(userId);
  est.armed = true;
  est.killed = false;
  est.killReason = null;
  est.killedAt = null;
  est.consecutiveErrors = 0;
  await persistir(userId);
  return getSnapshot(userId);
}

function getSnapshot(userId) {
  const est = traders.get(userId);
  const base = {
    liveEnabled: isLiveEnabled(),
    armed: false, killed: false, killReason: null, killedAt: null,
    limits: {
      maxContractsPerOrder: MAX_CONTRACTS_PER_ORDER,
      maxOrdersPerDay: MAX_ORDERS_PER_DAY,
      maxDailyLossUsd: MAX_DAILY_LOSS_USD,
      maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
    },
    today: { day: dayKey(), ordersSent: 0, potentialLossUsd: 0, consecutiveErrors: 0 },
    log: [], lastProcessedTicker: null,
  };
  if (!est) return base;
  return {
    ...base,
    armed: est.armed, killed: est.killed, killReason: est.killReason, killedAt: est.killedAt,
    today: {
      day: est.day || dayKey(),
      ordersSent: est.ordersToday,
      potentialLossUsd: est.potentialLossTodayUsd,
      consecutiveErrors: est.consecutiveErrors,
    },
    log: est.log.slice(-20),
    lastProcessedTicker: est.lastProcessedTicker,
  };
}

// Procesa UNA señal viable del auditor. Es el único camino hacia un
// envío real. Dedup por ticker: una ventana se procesa una sola vez.
// `deps` permite inyectar stubs en pruebas: { credsProvider, sendFn }.
async function handleViableSignal(userId, simulacion, deps = {}) {
  const est = await cargarEstadoSiHaceFalta(userId);
  resetDiaSiCambio(est);
  const ticker = simulacion && simulacion.ticker;
  if (!ticker) return { action: 'ignore', reason: 'no_ticker' };
  if (est.lastProcessedTicker === ticker) return { action: 'duplicate', reason: 'already_processed', ticker };
  if (est.log.some((e) => e.ticker === ticker && e.action !== 'duplicate')) {
    est.lastProcessedTicker = ticker;
    return { action: 'duplicate', reason: 'already_processed', ticker };
  }
  const decision = evaluarDecision({ liveEnabled: isLiveEnabled(), estado: est, senal: simulacion });
  const qty = Number(simulacion.ordenV2Preview && simulacion.ordenV2Preview.payload
    ? simulacion.ordenV2Preview.payload.count : NaN);
  const entry = {
    at: new Date().toISOString(),
    ticker,
    action: decision.action,
    reason: decision.reason,
    direccion: simulacion.direccionElegida || null,
    askPriceDollars: simulacion.askPriceDollars || null,
    feePerContractDollars: simulacion.feePerContractDollars != null ? simulacion.feePerContractDollars : null,
    contractsQty: Number.isFinite(qty) ? qty : null,
    perdidaPotencialUsd: decision.perdidaPotencialUsd != null ? decision.perdidaPotencialUsd : null,
    payloadPreview: simulacion.ordenV2Preview || null,
    orderId: null,
    error: null,
    autoKilled: false,
  };

  if (decision.action === 'send') {
    const credsProvider = deps.credsProvider || credencialesHook;
    const sendFn = deps.sendFn || sendFnHook || enviarOrdenReal;
    let creds = null;
    try { creds = credsProvider ? await credsProvider(userId) : null; } catch (e) { creds = null; entry.error = e.message; }
    if (!creds || !creds.keyId || !creds.privateKeyPem) {
      entry.action = 'blocked';
      entry.reason = 'no_credentials';
      if (!entry.error) entry.error = 'Sin credenciales de Kalshi descifradas en el servidor.';
    } else {
      try {
        const res = await sendFn({ keyId: creds.keyId, privateKeyPem: creds.privateKeyPem, payload: simulacion.ordenV2Preview.payload });
        if (res && res.sent) {
          entry.action = 'sent';
          entry.reason = null;
          entry.orderId = (res.order && (res.order.client_order_id || res.order.id)) || null;
          est.ordersToday += 1;
          if (decision.perdidaPotencialUsd != null) est.potentialLossTodayUsd = +(est.potentialLossTodayUsd + decision.perdidaPotencialUsd).toFixed(4);
          est.consecutiveErrors = 0;
        } else {
          entry.action = 'blocked';
          entry.reason = (res && res.reason) || 'send_rejected';
          entry.error = 'El envío devolvió sent=false sin lanzar error.';
          est.consecutiveErrors += 1;
        }
      } catch (e) {
        entry.action = 'blocked';
        entry.reason = 'send_error';
        entry.error = e.message || 'Error al enviar la orden.';
        est.consecutiveErrors += 1;
      }
      if (est.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS && !est.killed) {
        est.killed = true;
        est.killReason = 'max_consecutive_errors';
        est.killedAt = new Date().toISOString();
        est.armed = false;
        entry.autoKilled = true;
      }
    }
  }

  est.lastProcessedTicker = ticker;
  est.log.push(entry);
  est.log = est.log.slice(-MAX_LOG);
  await persistir(userId);
  return entry;
}

// --- Observador del auditor (modo sombra cuando live está apagado) ---

function ensureObservador() {
  if (observadorInterval) return;
  observadorInterval = setInterval(() => {
    let alguno = false;
    for (const [userId, aud] of paperAuditor._auditors) {
      if (!aud || !aud.enabled) continue;
      alguno = true;
      const snap = paperAuditor.getSnapshot(userId);
      const sim = snap && snap.simulacion;
      if (!sim || sim.viableDespuesDeComision !== true) continue;
      const clave = `${userId}:${sim.ticker}`;
      if (procesando.has(clave)) continue;
      procesando.add(clave);
      handleViableSignal(userId, sim).catch(() => {}).finally(() => procesando.delete(clave));
    }
    if (!alguno && observadorInterval) { clearInterval(observadorInterval); observadorInterval = null; }
  }, 1000);
  if (observadorInterval.unref) observadorInterval.unref();
}

module.exports = {
  LIVE_ORDERS_PATH, MAX_CONTRACTS_PER_ORDER, MAX_ORDERS_PER_DAY, MAX_DAILY_LOSS_USD,
  MAX_CONSECUTIVE_ERRORS, MAX_LOG,
  isLiveEnabled, calcularPerdidaPotencial, dayKey, crearEstadoTrader,
  resetDiaSiCambio, verificarLimites, evaluarDecision, enviarOrdenReal,
  setPersistencia, setCredentialsProvider, setCargarEstado, setSendFn,
  cargarEstadoSiHaceFalta, getSnapshot, kill, arm, handleViableSignal,
  ensureObservador,
  // Solo para pruebas: inspeccionar el estado en memoria.
  _traders: traders,
  // Re-exporta el constructor de payloads para que quede claro que
  // el trader NO duplica la lógica V2 del auditor.
  construirPayloadOrdenV2,
};
