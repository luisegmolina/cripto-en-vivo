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
//   - Modo experimento (v16.4 Parte 2, por usuario, ruta POST
//     /kalshi/live/experiment): 1 contrato por orden, tope de $5 USD
//     de notional por orden y guarda de saldo (no se envía si el
//     saldo de Kalshi es menor que el costo de la orden). El default
//     global sigue siendo 2 contratos, sin tope de notional.
// El día es UTC (YYYY-MM-DD). Los contadores se reinician al cambiar
// de día; los errores consecutivos solo se reinician con un envío OK.
//
// PERSISTENCIA: el registro de decisiones (would-send / blocked /
// killed / sent) se guarda en cev_user_data kind 'live_trade_log'
// (vía hook setPersistencia, registrado en routes.js), con tope de
// 50 entradas. Sin hook, no se persiste (modo pruebas).
//
// v16.4 Parte 2 — EXPERIMENTO LIVE ACOTADO (decidido por Luis,
// 18-nov-2026; parámetros en las constantes de abajo y en
// VERSION.txt): config por usuario (modo experimento + contratos +
// notional + órdenes/día) persistida DENTRO del mismo
// live_trade_log (campo `experiment` del estado); conciliación del
// llenado real tras cada envío (consultar la orden + fills) y
// resultado realizado tras la liquidación (el observador lo registra
// cuando el auditor liquida la ventana). Live sigue APAGADO: nada de
// esto envía nada mientras LIVE_TRADING_ENABLED no sea 'true'.
//
// OBSERVADOR: un setInterval global de 1 s (perezoso, con unref)
// recorre los auditores habilitados de paperAuditor y procesa cada
// señal viable UNA sola vez por ticker (dedup en memoria + registro
// persistido). Se apaga solo cuando ya no queda ningún auditor activo.
// NO modifica paperAuditor.js: solo lee sus snapshots.
const { BASE, signHeaders, kalshiGet } = require('./kalshiServer');
const { construirPayloadOrdenV2 } = require('./paperAuditor');
const paperAuditor = require('./paperAuditor');

// --- Interruptor global y límites ---

const LIVE_ORDERS_PATH = '/trade-api/v2/portfolio/events/orders';
const LIVE_ORDER_BY_ID_PATH = '/trade-api/v2/portfolio/orders';
const MAX_CONTRACTS_PER_ORDER = 2;
const MAX_ORDERS_PER_DAY = 5;
const MAX_DAILY_LOSS_USD = 20;
const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_LOG = 50;

// v16.4 Parte 2 — EXPERIMENTO LIVE ACOTADO (decidido por Luis,
// 18-nov-2026). Marco de Luis: la web es el producto que le dará
// dinero; el bot es un experimento acotado al lado, NO el negocio.
// Su ÚNICA cuenta de Kalshi (la principal, sin subcuenta), saldo
// $40 USD. "Yo no apuesto": el experimento es acotado, no una apuesta.
//   - 1 contrato por orden (el default global sigue siendo 2).
//   - Máximo $5 USD de notional por orden (contratos × precio).
//   - Máximo 5 órdenes/día (igual que el global).
//   - Guarda de saldo: no se envía si el saldo de Kalshi es menor que
//     el costo de la orden (contratos × (ask + fee)).
// Pérdida esperada a 1 contrato ~$0,50/orden, ~$2,50/día a 5 órdenes,
// peor caso ~$4,86/día. Live sigue APAGADO: nada de esto envía nada
// mientras LIVE_TRADING_ENABLED no sea 'true' y el usuario no arme.
// NO hay plan Starter de Render ($7/mes): sin pagos; Luis despierta
// la web él mismo desde su laptop cuando se duerme.
const EXPERIMENT_CONTRACTS_PER_ORDER = 1;
const EXPERIMENT_MAX_NOTIONAL_USD_PER_ORDER = 5;
const EXPERIMENT_MAX_ORDERS_PER_DAY = 5;

// Lee la env EN CADA LLAMADA (no se cachea al importar): así los
// tests pueden encenderla/apagarla y un cambio en Render aplica al
// reiniciar el proceso, sin recompilar nada.
function isLiveEnabled(env = process.env) {
  return env && env.LIVE_TRADING_ENABLED === 'true';
}

// v16.4 Parte 2 — Config del experimento live acotado por usuario.
// Apagado por defecto: con enabled=false mandan los límites globales
// (2 contratos, sin tope de notional, 5 órdenes/día). Con el modo
// activo: 1 contrato y tope de $5 de notional por orden.
function crearConfigExperimento() {
  return {
    enabled: false,
    contractsPerOrder: EXPERIMENT_CONTRACTS_PER_ORDER,
    maxNotionalUsdPerOrder: EXPERIMENT_MAX_NOTIONAL_USD_PER_ORDER,
    maxOrdersPerDay: EXPERIMENT_MAX_ORDERS_PER_DAY,
    updatedAt: null,
  };
}

// Límites EFECTIVOS para un estado: los del experimento si el modo
// está activo, los globales si no. El tope de pérdida diaria ($20)
// y el de errores consecutivos (3) son los mismos en ambos modos.
function limitesEfectivos(estado) {
  const exp = estado && estado.experiment && estado.experiment.enabled === true ? estado.experiment : null;
  return {
    maxContractsPerOrder: exp ? exp.contractsPerOrder : MAX_CONTRACTS_PER_ORDER,
    maxOrdersPerDay: exp ? exp.maxOrdersPerDay : MAX_ORDERS_PER_DAY,
    maxNotionalUsdPerOrder: exp ? exp.maxNotionalUsdPerOrder : null,
    maxDailyLossUsd: MAX_DAILY_LOSS_USD,
    maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
  };
}

// ¿Es un error de timeout/aborto (el POST pudo llegar a Kalshi)?
function esErrorTimeout(e) {
  return !!e && (e.timeout === true || e.name === 'AbortError' || e.code === 'ABORT_ERR'
    || /abort/i.test(String(e.message || '')));
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
    experiment: crearConfigExperimento(),
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
// cantidad, órdenes/día, notional (solo en modo experimento),
// números, pérdida diaria, saldo, errores consecutivos.
// `opts.balanceUsd`: saldo real de Kalshi en dólares. Si es un
// número y es menor que el costo de la orden (contratos × (ask +
// fee)), bloquea con 'insufficient_balance'. Si es null/undefined
// (saldo desconocido), NO bloquea aquí: es el llamador
// (handleViableSignal) quien decide no enviar sin saldo conocido.
function verificarLimites(estado, senal, opts = {}) {
  if (!estado) return { ok: false, reason: 'not_armed' };
  if (estado.killed) return { ok: false, reason: 'killed' };
  if (!estado.armed) return { ok: false, reason: 'not_armed' };
  const qty = Number(senal && senal.ordenV2Preview && senal.ordenV2Preview.payload
    ? senal.ordenV2Preview.payload.count
    : (senal && senal.contractsQty != null ? senal.contractsQty : NaN));
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: 'bad_quantity' };
  const lim = limitesEfectivos(estado);
  if (qty > lim.maxContractsPerOrder) return { ok: false, reason: 'max_contracts_per_order' };
  if (estado.ordersToday >= lim.maxOrdersPerDay) return { ok: false, reason: 'max_orders_per_day' };
  const ask = Number(senal && senal.askPriceDollars);
  if (!Number.isFinite(ask) || ask <= 0 || ask >= 1) return { ok: false, reason: 'bad_numbers' };
  // v16.4 Parte 2 — Tope de notional por orden: contratos × precio.
  // En modo experimento es $5 (con 1 contrato y ask < $1 nunca llega
  // a $5, pero la guarda protege ante un precio o cantidad anómalos);
  // sin experimento no hay tope (null).
  const notionalUsd = +(qty * ask).toFixed(4);
  if (lim.maxNotionalUsdPerOrder != null && notionalUsd > lim.maxNotionalUsdPerOrder) return { ok: false, reason: 'max_notional_per_order' };
  const perdida = calcularPerdidaPotencial({
    askPriceDollars: senal.askPriceDollars,
    feePerContractDollars: senal.feePerContractDollars,
    contractsQty: qty,
  });
  if (perdida == null) return { ok: false, reason: 'bad_numbers' };
  if (estado.potentialLossTodayUsd + perdida > MAX_DAILY_LOSS_USD) return { ok: false, reason: 'max_daily_loss' };
  // v16.4 Parte 2 — Guarda de saldo: el saldo debe cubrir el costo
  // de la orden (lo mismo que la pérdida potencial: (ask + fee) × qty).
  const balanceUsd = opts.balanceUsd;
  if (Number.isFinite(balanceUsd) && balanceUsd < perdida) return { ok: false, reason: 'insufficient_balance' };
  if (estado.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return { ok: false, reason: 'max_consecutive_errors' };
  return { ok: true, reason: null, perdidaPotencialUsd: perdida, notionalUsd };
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
  if (!lim.ok) return { action: 'blocked', reason: lim.reason, perdidaPotencialUsd: null, notionalUsd: null };
  return { action: 'send', reason: null, perdidaPotencialUsd: lim.perdidaPotencialUsd, notionalUsd: lim.notionalUsd != null ? lim.notionalUsd : null };
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
  } catch (e) {
    // v16.4 Parte 2 — Ambigüedad por timeout: si el POST aborta a los
    // 8 s, Kalshi PUDO haber aceptado la orden. Se marca el error
    // (timeout=true) para que el llamador la busque por
    // client_order_id antes de contarla como error (ver
    // handleViableSignal). Sin esta marca, un timeout se contaría
    // como envío fallido aunque la orden existiera en Kalshi.
    if (ctrl.signal.aborted || e.name === 'AbortError' || e.code === 'ABORT_ERR') {
      const t2 = new Error(`Tiempo de espera agotado al enviar la orden a Kalshi (${timeoutMs} ms): no se sabe si la aceptó.`);
      t2.timeout = true;
      t2.cause = e;
      throw t2;
    }
    throw e;
  } finally { clearTimeout(t); }
}

// --- Conciliación (v16.4 Parte 2) ---
//
// Tras enviar una orden con éxito, el registro 'sent' NO basta:
// Kalshi puede no haberla llenado (orden limit en
// immediate_or_cancel, mercado movido, etc.). Se consulta la orden
// y los fills para anotar el llenado real, y tras la liquidación se
// registra el resultado realizado. Nada de esto envía órdenes: son
// solo GET. La conciliación NUNCA convierte un envío en no-enviado:
// si falla, la orden sigue contando como enviada y queda marcada
// como 'unknown' para revisarla a mano.

// GET autenticado genérico a Kalshi con timeout (8 s). 404 -> null
// (la orden no existe); otro no-OK o fallo de red -> lanza Error.
// La firma es sobre la ruta SIN query string (como en kalshiServer).
async function kalshiGetJson(path, { keyId, privateKeyPem, fetchFn = fetch, timeoutMs = 8000 } = {}) {
  if (!keyId || !privateKeyPem) throw new Error('Faltan credenciales de Kalshi para consultar.');
  const pathSinQuery = String(path).split('?')[0];
  const headers = signHeaders({ keyId, privateKeyPem, method: 'GET', path: pathSinQuery });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchFn(BASE + path, { signal: ctrl.signal, headers: { Accept: 'application/json', ...headers } });
    if (r.status === 404) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.message || j.error || `Kalshi HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return j;
  } finally { clearTimeout(t); }
}

// Consulta UNA orden en Kalshi: por order_id (GET
// /trade-api/v2/portfolio/orders/{order_id}) o, sin él, por
// client_order_id en la lista reciente (GET .../orders?limit=25).
// Devuelve { orderId, clientOrderId, status } o null si Kalshi no
// la tiene. Lanza Error si la red o Kalshi fallan (distinto de 404).
async function consultarOrdenKalshi({ keyId, privateKeyPem, orderId, clientOrderId, fetchFn = fetch } = {}) {
  if (!keyId || !privateKeyPem) throw new Error('Faltan credenciales de Kalshi para consultar la orden.');
  if (orderId) {
    const j = await kalshiGetJson(`${LIVE_ORDER_BY_ID_PATH}/${encodeURIComponent(String(orderId))}`, { keyId, privateKeyPem, fetchFn });
    if (!j) return null;
    const o = j.order || j;
    return { orderId: o.order_id || o.id || String(orderId), clientOrderId: o.client_order_id || null, status: o.status || null, raw: o };
  }
  if (clientOrderId) {
    const j = await kalshiGetJson(`${LIVE_ORDER_BY_ID_PATH}?limit=25`, { keyId, privateKeyPem, fetchFn });
    const list = (j && (j.orders || [])) || [];
    const o = list.find((x) => x && x.client_order_id === clientOrderId);
    if (!o) return null;
    return { orderId: o.order_id || o.id || null, clientOrderId: o.client_order_id, status: o.status || null, raw: o };
  }
  throw new Error('consultarOrdenKalshi necesita orderId o clientOrderId.');
}

// Concilia el llenado real de una orden enviada: consulta la orden y
// los fills (GET /portfolio/fills, ya en READ_ONLY_PATHS de
// kalshiServer) y suma los fills de ese ticker y lado desde el
// momento del envío. `side` es 'yes'/'no' (el lado del contrato, no
// bid/ask del payload). Devuelve null si Kalshi no tiene la orden;
// si los fills no se pueden leer, filledQty queda null y fillStatus
// 'unknown' (la orden sí existe: solo falta el detalle del llenado).
async function conciliarOrdenEnviada({ keyId, privateKeyPem, orderId, clientOrderId, ticker, side, placedAt, fetchFn = fetch, fillsFn = null, consultarOrdenFn = null } = {}) {
  const orden = consultarOrdenFn
    ? await consultarOrdenFn({ keyId, privateKeyPem, orderId, clientOrderId, fetchFn })
    : await consultarOrdenKalshi({ keyId, privateKeyPem, orderId, clientOrderId, fetchFn });
  if (!orden) return null;
  let fills = null;
  try {
    const f = fillsFn
      ? await fillsFn({ keyId, privateKeyPem, ticker })
      : await kalshiGet('/trade-api/v2/portfolio/fills', { keyId, privateKeyPem });
    fills = Array.isArray(f) ? f : (f && Array.isArray(f.fills) ? f.fills : []);
  } catch { fills = null; }
  if (fills === null) {
    return { orderId: orden.orderId || orderId || null, clientOrderId: orden.clientOrderId || clientOrderId || null, status: orden.status || null, filledQty: null, avgFillPriceDollars: null, fillStatus: 'unknown', fillsMatched: 0 };
  }
  const desde = Number.isFinite(Number(placedAt)) ? Number(placedAt) - 10000 : 0;
  const lado = String(side || '').toLowerCase();
  let qty = 0;
  let suma = 0;
  let n = 0;
  for (const f of fills) {
    if (!f || f.ticker !== ticker) continue;
    const fSide = String(f.side || '').toLowerCase();
    if (lado && fSide && fSide !== lado) continue;
    const t = f.created_time ? new Date(f.created_time).getTime() : 0;
    if (t && t < desde) continue;
    const c = Number(f.count_fp ?? f.count ?? f.quantity ?? 0);
    const p = f.price_dollars != null ? Number(f.price_dollars) : (Number.isFinite(Number(f.price)) ? Number(f.price) / 100 : NaN);
    if (!Number.isFinite(c) || c <= 0 || !Number.isFinite(p)) continue;
    qty += c;
    suma += p * c;
    n += 1;
  }
  const avg = qty > 0 ? +(suma / qty).toFixed(4) : null;
  const fillStatus = qty > 0 ? (orden.status === 'executed' ? 'filled' : 'partial') : (orden.status ? 'none' : 'unknown');
  return { orderId: orden.orderId || orderId || null, clientOrderId: orden.clientOrderId || clientOrderId || null, status: orden.status || null, filledQty: qty, avgFillPriceDollars: avg, fillStatus, fillsMatched: n };
}

// Resultado realizado de una orden llenada, una vez liquidada la
// ventana. Función pura. `direccion` y `resultadoOficial` son
// 'yes'/'no' (la señal apostada y el resultado oficial de Kalshi:
// gana si coinciden, como en calcularStats del auditor).
//   - sin llenado conocido -> 'sin_dato' (no se inventa un P&L).
//   - 0 contratos llenados -> 'no_llenó', pnl $0.
//   - sin resultado oficial aún -> 'pendiente'.
//   - gana: +qty × (1 − precio − fee); pierde: −qty × (precio + fee).
function calcularResultadoRealizado({ filledQty, avgFillPriceDollars, feePerContractDollars, direccion, resultadoOficial }) {
  if (filledQty == null) return { resultado: 'sin_dato', gano: null, pnlUsd: null };
  const qty = Number(filledQty);
  if (!Number.isFinite(qty) || qty < 0) return { resultado: 'sin_dato', gano: null, pnlUsd: null };
  if (qty === 0) return { resultado: 'no_llenó', gano: false, pnlUsd: 0 };
  const precio = Number(avgFillPriceDollars);
  const fee = Number(feePerContractDollars);
  if (!Number.isFinite(precio) || precio < 0 || precio >= 1 || !Number.isFinite(fee) || fee < 0) return { resultado: 'sin_dato', gano: null, pnlUsd: null };
  const dir = String(direccion || '').toLowerCase();
  const res = String(resultadoOficial || '').toLowerCase();
  if (res === 'pendiente' || res === '') return { resultado: 'pendiente', gano: null, pnlUsd: null };
  if ((dir !== 'yes' && dir !== 'no') || (res !== 'yes' && res !== 'no')) return { resultado: 'sin_dato', gano: null, pnlUsd: null };
  const gano = dir === res;
  const pnl = gano ? qty * (1 - precio - fee) : -qty * (precio + fee);
  return { resultado: gano ? 'ganó' : 'perdió', gano, pnlUsd: +pnl.toFixed(4) };
}

// Registra el resultado realizado de una orden enviada al liquidarse
// su ventana. Busca la entrada 'sent' por orderId (o por ticker) que
// aún no tenga resultado y la actualiza con resultadoRealizado +
// pnlRealizadoUsd. Devuelve { ok, entry } o { ok:false, reason }.
async function registrarLiquidacion(userId, { ticker, orderId, resultadoOficial } = {}) {
  const est = await cargarEstadoSiHaceFalta(userId);
  const entrada = est.log.find((e) => e && e.action === 'sent' && !e.resultadoRealizado
    && ((orderId && e.orderId && String(e.orderId) === String(orderId))
      || (!orderId && e.ticker === ticker)
      || (orderId && !e.orderId && e.ticker === ticker)));
  if (!entrada) return { ok: false, reason: 'no_sent_entry' };
  const r = calcularResultadoRealizado({
    filledQty: entrada.filledQty,
    avgFillPriceDollars: entrada.avgFillPriceDollars,
    feePerContractDollars: entrada.feePerContractDollars,
    direccion: entrada.direccion,
    resultadoOficial,
  });
  entrada.resultadoRealizado = r.resultado;
  entrada.pnlRealizadoUsd = r.pnlUsd;
  entrada.gano = r.gano;
  entrada.resultadoOficialKalshi = resultadoOficial || null;
  entrada.liquidadoAt = new Date().toISOString();
  await persistir(userId);
  return { ok: true, entry: entrada };
}

// --- Estado por usuario + hooks inyectables ---

const traders = new Map(); // userId -> estado
let persistenciaHook = null;
let credencialesHook = null;
let cargarEstadoHook = null;
let sendFnHook = null; // por defecto enviarOrdenReal
let balanceHook = null; // v16.4 Parte 2: proveedor de saldo (routes.js)
let observadorInterval = null;
const procesando = new Set(); // `${userId}:${ticker}` en curso

function setPersistencia(fn) { persistenciaHook = typeof fn === 'function' ? fn : null; }
function setCredentialsProvider(fn) { credencialesHook = typeof fn === 'function' ? fn : null; }
function setCargarEstado(fn) { cargarEstadoHook = typeof fn === 'function' ? fn : null; }
function setSendFn(fn) { sendFnHook = typeof fn === 'function' ? fn : null; }

// v16.4 Parte 2 — Proveedor de saldo real de Kalshi (dólares, o null
// si no se puede leer). Lo configura routes.js; sin él no hay guarda
// de saldo (modo pruebas). Ver handleViableSignal.
function setBalanceProvider(fn) { balanceHook = typeof fn === 'function' ? fn : null; }

function validarEnteroExperimento(valor, defecto, min, max, nombre) {
  if (valor === undefined || valor === null) return defecto;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${nombre} no válido: usa un entero entre ${min} y ${max}.`);
  }
  return n;
}
function validarNotionalExperimento(valor, defecto) {
  if (valor === undefined || valor === null) return defecto;
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0 || n > 100) {
    throw new Error('maxNotionalUsdPerOrder no válido: usa un número mayor que 0 (USD por orden).');
  }
  return n;
}

// v16.4 Parte 2 — Activa o desactiva el modo experimento para un
// usuario (ruta POST /kalshi/live/experiment). Con el modo activo:
// 1 contrato por orden y tope de $5 de notional por orden; con el
// modo apagado vuelven los defaults globales (2 contratos, sin tope
// de notional). Los valores explícitos se validan (contratos 1-2,
// notional > 0, órdenes/día 1-5); un valor inválido lanza Error (la
// ruta responde 400). NO enciende live ni arma nada: solo cambia los
// límites que verificarLimites aplicará CUANDO live esté encendido y
// armado. Se persiste en el mismo live_trade_log (serializarEstado).
async function setExperiment(userId, cfg = {}) {
  const est = await cargarEstadoSiHaceFalta(userId);
  const enabled = cfg.experimentMode === true;
  const exp = crearConfigExperimento();
  exp.enabled = enabled;
  if (enabled) {
    exp.contractsPerOrder = validarEnteroExperimento(cfg.contractsPerOrder, EXPERIMENT_CONTRACTS_PER_ORDER, 1, MAX_CONTRACTS_PER_ORDER, 'contractsPerOrder');
    exp.maxNotionalUsdPerOrder = validarNotionalExperimento(cfg.maxNotionalUsdPerOrder, EXPERIMENT_MAX_NOTIONAL_USD_PER_ORDER);
    exp.maxOrdersPerDay = validarEnteroExperimento(cfg.maxOrdersPerDay, EXPERIMENT_MAX_ORDERS_PER_DAY, 1, MAX_ORDERS_PER_DAY, 'maxOrdersPerDay');
  }
  exp.updatedAt = new Date().toISOString();
  est.experiment = exp;
  await persistir(userId);
  return getSnapshot(userId);
}

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
      if (saved.experiment && typeof saved.experiment === 'object') {
        const ex = saved.experiment;
        est.experiment = {
          enabled: ex.enabled === true,
          contractsPerOrder: Number.isFinite(Number(ex.contractsPerOrder)) ? Math.min(Math.max(Math.trunc(Number(ex.contractsPerOrder)), 1), MAX_CONTRACTS_PER_ORDER) : EXPERIMENT_CONTRACTS_PER_ORDER,
          maxNotionalUsdPerOrder: Number.isFinite(Number(ex.maxNotionalUsdPerOrder)) && Number(ex.maxNotionalUsdPerOrder) > 0 ? Number(ex.maxNotionalUsdPerOrder) : EXPERIMENT_MAX_NOTIONAL_USD_PER_ORDER,
          maxOrdersPerDay: Number.isFinite(Number(ex.maxOrdersPerDay)) ? Math.min(Math.max(Math.trunc(Number(ex.maxOrdersPerDay)), 1), MAX_ORDERS_PER_DAY) : EXPERIMENT_MAX_ORDERS_PER_DAY,
          updatedAt: typeof ex.updatedAt === 'string' ? ex.updatedAt : null,
        };
      }
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
    experiment: est.experiment || crearConfigExperimento(),
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
      maxNotionalUsdPerOrder: null,
    },
    experiment: crearConfigExperimento(),
    today: { day: dayKey(), ordersSent: 0, potentialLossUsd: 0, consecutiveErrors: 0, realizedPnlUsd: 0 },
    log: [], lastProcessedTicker: null,
  };
  if (!est) return base;
  const lim = limitesEfectivos(est);
  return {
    ...base,
    armed: est.armed, killed: est.killed, killReason: est.killReason, killedAt: est.killedAt,
    limits: {
      maxContractsPerOrder: lim.maxContractsPerOrder,
      maxOrdersPerDay: lim.maxOrdersPerDay,
      maxDailyLossUsd: lim.maxDailyLossUsd,
      maxConsecutiveErrors: lim.maxConsecutiveErrors,
      maxNotionalUsdPerOrder: lim.maxNotionalUsdPerOrder,
    },
    experiment: { ...(est.experiment || crearConfigExperimento()) },
    today: {
      day: est.day || dayKey(),
      ordersSent: est.ordersToday,
      potentialLossUsd: est.potentialLossTodayUsd,
      consecutiveErrors: est.consecutiveErrors,
      realizedPnlUsd: realizedPnlHoy(est),
    },
    log: est.log.slice(-20),
    lastProcessedTicker: est.lastProcessedTicker,
  };
}

// v16.4 Parte 2 — P&L realizado hoy: suma de pnlRealizadoUsd de las
// entradas liquidadas hoy (0 si hoy no hay ninguna liquidación).
function realizedPnlHoy(est) {
  if (!est || !Array.isArray(est.log)) return 0;
  const hoy = est.day || dayKey();
  let suma = 0;
  let hay = false;
  for (const e of est.log) {
    if (e && e.resultadoRealizado && typeof e.pnlRealizadoUsd === 'number'
      && typeof e.liquidadoAt === 'string' && e.liquidadoAt.slice(0, 10) === hoy) {
      suma += e.pnlRealizadoUsd;
      hay = true;
    }
  }
  return hay ? +suma.toFixed(4) : 0;
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
    notionalUsd: decision.notionalUsd != null ? decision.notionalUsd : null,
    payloadPreview: simulacion.ordenV2Preview || null,
    orderId: null,
    clientOrderId: null,
    fillStatus: null,
    filledQty: null,
    avgFillPriceDollars: null,
    reconciliation: null,
    reconciliationError: null,
    resultadoRealizado: null,
    pnlRealizadoUsd: null,
    resultadoOficialKalshi: null,
    liquidadoAt: null,
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
      // v16.4 Parte 2 — GUARDA DE SALDO: antes de enviar se consulta
      // el saldo real de Kalshi y se re-verifican los límites con él.
      // Sin proveedor de saldo configurado no hay guarda (modo
      // pruebas: las suites viejas no configuran ninguno); en
      // producción routes.js SIEMPRE lo configura. Si el saldo no se
      // puede saber, NO se envía (fail-closed) y cuenta como error
      // consecutivo (3 seguidos auto-detienen, como un envío fallido).
      const balanceProvider = deps.balanceProvider || balanceHook;
      let saldoOk = true;
      if (balanceProvider) {
        let balanceUsd = null;
        try { balanceUsd = await balanceProvider(userId); } catch (e) { balanceUsd = null; entry.error = e.message; }
        if (balanceUsd == null) {
          entry.action = 'blocked';
          entry.reason = 'balance_unknown';
          if (!entry.error) entry.error = 'No se pudo leer el saldo de Kalshi: sin saldo no se envía.';
          est.consecutiveErrors += 1;
          saldoOk = false;
        } else {
          const limSaldo = verificarLimites(est, simulacion, { balanceUsd });
          if (!limSaldo.ok) {
            entry.action = 'blocked';
            entry.reason = limSaldo.reason;
            entry.error = `Límite con saldo $${balanceUsd}: ${limSaldo.reason}.`;
            est.consecutiveErrors += 1;
            saldoOk = false;
          }
        }
      }
      if (saldoOk) {
        const clientOrderIdPayload = (simulacion.ordenV2Preview && simulacion.ordenV2Preview.payload && simulacion.ordenV2Preview.payload.client_order_id) || null;
        const marcarEnviada = (res, reason) => {
          entry.action = 'sent';
          entry.reason = reason || null;
          entry.orderId = (res.order && (res.order.order_id || res.order.client_order_id || res.order.id)) || null;
          entry.clientOrderId = clientOrderIdPayload;
          est.ordersToday += 1;
          if (decision.perdidaPotencialUsd != null) est.potentialLossTodayUsd = +(est.potentialLossTodayUsd + decision.perdidaPotencialUsd).toFixed(4);
          est.consecutiveErrors = 0;
        };
        const conciliar = async (orderId, clientOrderId) => {
          // Conciliación del llenado real. Si falla, la orden SIGUE
          // contando como enviada (Kalshi la aceptó): solo queda
          // marcada como 'unknown' para revisarla a mano.
          try {
            const conc = await conciliarOrdenEnviada({
              keyId: creds.keyId, privateKeyPem: creds.privateKeyPem,
              orderId, clientOrderId, ticker, side: entry.direccion, placedAt: Date.now(),
              fetchFn: deps.fetchFn, fillsFn: deps.fillsFn, consultarOrdenFn: deps.consultarOrdenFn,
            });
            if (conc) {
              entry.fillStatus = conc.fillStatus;
              entry.filledQty = conc.filledQty;
              entry.avgFillPriceDollars = conc.avgFillPriceDollars;
              entry.reconciliation = 'ok';
            } else {
              entry.fillStatus = 'unknown';
              entry.reconciliation = 'unknown';
            }
          } catch (e) {
            entry.fillStatus = 'unknown';
            entry.reconciliation = 'unknown';
            entry.reconciliationError = e.message || 'Error al conciliar la orden.';
          }
        };
        try {
          const res = await sendFn({ keyId: creds.keyId, privateKeyPem: creds.privateKeyPem, payload: simulacion.ordenV2Preview.payload });
          if (res && res.sent) {
            marcarEnviada(res, null);
            await conciliar(entry.orderId, entry.clientOrderId);
          } else {
            entry.action = 'blocked';
            entry.reason = (res && res.reason) || 'send_rejected';
            entry.error = 'El envío devolvió sent=false sin lanzar error.';
            est.consecutiveErrors += 1;
          }
        } catch (e) {
          if (esErrorTimeout(e)) {
            // Ambigüedad por timeout: el POST pudo llegar a Kalshi.
            // Se busca la orden por client_order_id: si Kalshi la
            // aceptó, cuenta como ENVIADA (no como error); si no está,
            // cuenta como error y NO se reintenta sola.
            let encontrada = null;
            try {
              encontrada = await conciliarOrdenEnviada({
                keyId: creds.keyId, privateKeyPem: creds.privateKeyPem,
                orderId: null, clientOrderId: clientOrderIdPayload,
                ticker, side: entry.direccion, placedAt: Date.now(),
                fetchFn: deps.fetchFn, fillsFn: deps.fillsFn, consultarOrdenFn: deps.consultarOrdenFn,
              });
            } catch (ce) {
              encontrada = null;
              entry.error = `${e.message || 'Timeout al enviar.'} Al buscarla en Kalshi: ${ce.message || ce}.`;
            }
            if (encontrada) {
              marcarEnviada({ order: { order_id: encontrada.orderId, client_order_id: encontrada.clientOrderId } }, 'sent_after_timeout');
              entry.fillStatus = encontrada.fillStatus;
              entry.filledQty = encontrada.filledQty;
              entry.avgFillPriceDollars = encontrada.avgFillPriceDollars;
              entry.reconciliation = 'ok';
            } else {
              entry.action = 'blocked';
              entry.reason = 'send_error';
              if (!entry.error) entry.error = `${e.message || 'Timeout al enviar la orden.'} No se encontró la orden en Kalshi por client_order_id: se cuenta como error, no como enviada.`;
              est.consecutiveErrors += 1;
            }
          } else {
            entry.action = 'blocked';
            entry.reason = 'send_error';
            entry.error = e.message || 'Error al enviar la orden.';
            est.consecutiveErrors += 1;
          }
        }
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
      // v16.4 Parte 2 — Liquidación: si el auditor ya liquidó la
      // ventana de una orden enviada (resultado oficial distinto de
      // 'pendiente'), se registra su resultado realizado. Best-effort:
      // un fallo aquí no tumba el observador ni el envío.
      try {
        const liquidadas = (snap && Array.isArray(snap.resultados) ? snap.resultados : [])
          .filter((r) => r && r.ticker && r.resultadoOficialKalshi && r.resultadoOficialKalshi !== 'pendiente');
        if (liquidadas.length) {
          const est = traders.get(userId);
          if (est) {
            for (const e of est.log) {
              if (!e || e.action !== 'sent' || e.resultadoRealizado) continue;
              const reg = liquidadas.find((r) => r.ticker === e.ticker);
              if (reg) registrarLiquidacion(userId, { ticker: e.ticker, resultadoOficial: reg.resultadoOficialKalshi }).catch(() => {});
            }
          }
        }
      } catch { /* best-effort */ }
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
  LIVE_ORDERS_PATH, LIVE_ORDER_BY_ID_PATH, MAX_CONTRACTS_PER_ORDER, MAX_ORDERS_PER_DAY, MAX_DAILY_LOSS_USD,
  MAX_CONSECUTIVE_ERRORS, MAX_LOG,
  EXPERIMENT_CONTRACTS_PER_ORDER, EXPERIMENT_MAX_NOTIONAL_USD_PER_ORDER, EXPERIMENT_MAX_ORDERS_PER_DAY,
  isLiveEnabled, calcularPerdidaPotencial, dayKey, crearEstadoTrader,
  resetDiaSiCambio, verificarLimites, evaluarDecision, enviarOrdenReal,
  crearConfigExperimento, limitesEfectivos, esErrorTimeout, setExperiment,
  consultarOrdenKalshi, conciliarOrdenEnviada, calcularResultadoRealizado, registrarLiquidacion,
  setPersistencia, setCredentialsProvider, setCargarEstado, setSendFn, setBalanceProvider,
  cargarEstadoSiHaceFalta, getSnapshot, kill, arm, handleViableSignal,
  ensureObservador,
  // Solo para pruebas: inspeccionar el estado en memoria.
  _traders: traders,
  // Re-exporta el constructor de payloads para que quede claro que
  // el trader NO duplica la lógica V2 del auditor.
  construirPayloadOrdenV2,
};
