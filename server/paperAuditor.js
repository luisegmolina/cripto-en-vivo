// paperAuditor.js — v16.1: AUDITOR EN PAPEL del sniper BRTI, DENTRO del servidor.
//
// PAPEL SOLAMENTE. Este módulo NUNCA envía órdenes a Kalshi: no hay
// ningún POST/PUT/DELETE a Kalshi aquí. La única escritura a Kalshi
// que existe en este archivo es una CADENA dentro del objeto de vista
// previa (ordenV2Preview): un ejemplo de cómo SERÍA el payload V2 si
// alguien lo enviara a mano. Nada en este archivo lo envía.
//
// Qué audita: si la estrategia del "bloqueo matemático" del último
// minuto tiene edge neto después de comisiones. Cada segundo del
// minuto final muestrea el `value` BRTI en vivo (el tick instantáneo
// del canal cfbenchmarks_value) y construye el promedio bloqueado.
// Al cerrar la ventana lo compara con el expiration_value oficial.
//
// Reglas que este archivo aplica (verificadas en el chat, nov-2026):
// - Fuente BRTI: brti.getBrtiState(userId) — lee el último tick en
//   memoria del WS de server/brti.js. Cada lectura actualiza
//   lastPollAt, así que mantiene vivo el WS (cierre por inactividad
//   a los 5 min). NO existe /api/brti; el endpoint es /kalshi/brti.
// - El promedio bloqueado se construye SOLO con `value` muestreado
//   1 vez por segundo en el minuto final. avg60s es trailing 60 s
//   (incluye segundos de ANTES del minuto final) y avg15mFinal se
//   retiene aunque el tick no lo traiga: ambos se guardan SOLO como
//   diagnóstico, nunca como input del salto requerido.
// - Dedup por updatedAt: si el tick no es fresco, ese segundo cuenta
//   como perdido. Con más de 2 ticks perdidos no se registra señal.
// - Si al descubrir un contrato le quedan <=60 s, se descarta y se
//   espera la siguiente ventana (promedio incompleto = auditoría falsa).
// - Comisión taker Kalshi: 0.07 * P * (1 - P) por contrato.
//   Break-even real = ask + fee. Señal solo entre T-18 y T-3.
// - Quote fresca al ticker exacto (GET público, sin caché de 15 s),
//   pero SIN bloquear el muestreo: v16.3 la pide solo cuando R ≤ 20,
//   en paralelo y sin esperar; si tarda o falla, el tick BRTI se
//   muestrea igual y la señal se evalúa con la última quote fresca.
// - Persistencia: solo al cerrar ventana y al parar/arrancar, nunca
//   cada segundo (vía hook setPersistencia, registrado en routes.js).
//   v16.3: además del top-20 para la UI, cada ventana liquidada se
//   guarda compacta y SIN tope en el historial (kind
//   'cev_paper_windows'); las stats se calculan sobre TODO el historial.
const crypto = require('crypto');
const brti = require('./brti');
const { BASE, parseTargetPrice } = require('./kalshiServer');

// Parámetros de la auditoría (los mismos del script externo de referencia).
const CONTRACTS_QTY = 2.00;
const MIN_REQ_MOVE_USD = 95;
const MIN_NET_EDGE_DOLLARS = 0.015;
const MAX_TICKS_PERDIDOS = 2;
const MAX_RESULTADOS = 20;
const SERIES_TICKER = 'KXBTC15M';

// --- Funciones puras (testeables sin servidor ni Kalshi) ---

// Comisión taker oficial de Kalshi: 0.07 * P * (1 - P) por contrato.
function calcularComisionPorContrato(precioDollars) {
  const p = Number(precioDollars);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  return 0.07 * p * (1 - p);
}

// Vista previa del payload V2 real (SOLO preview, nunca se envía).
// Verificado contra docs.kalshi.com (Create Order V2, actualizado
// 2026-11-18), endpoint V2 de creación de órdenes, single-book en
// perspectiva YES. Campos: ticker, client_order_id, side ("bid"|"ask"),
// count ("2.00"), price ("0.8500" en dólares, en perspectiva YES),
// time_in_force, self_trade_prevention_type.
// bid = comprar YES; ask = vender YES (= comprar NO a 1 - price).
// NO son price_dollars / size / action / yes_price_dollars.
function construirPayloadOrdenV2(ticker, direccion, askPriceDollars, qty = CONTRACTS_QTY) {
  const isYes = direccion === 'yes';
  const yesBookPrice = isYes ? Number(askPriceDollars) : (1 - Number(askPriceDollars));
  return {
    endpoint: '/trade-api/v2/portfolio/events/orders',
    payload: {
      ticker,
      client_order_id: crypto.randomUUID(),
      side: isYes ? 'bid' : 'ask',
      count: Number(qty).toFixed(2),
      price: yesBookPrice.toFixed(4),
      time_in_force: 'immediate_or_cancel',
      self_trade_prevention_type: 'taker_at_cross',
    },
  };
}

// Promedio bloqueado desde las muestras del minuto final.
// `muestras` es un Map(segundoEpoch -> valor BRTI) o un array de valores.
// Devuelve { n, suma, twap } con twap null si no hay muestras.
function calcularTwapBloqueado(muestras) {
  const valores = muestras instanceof Map ? Array.from(muestras.values()) : (Array.isArray(muestras) ? muestras : []);
  const validos = valores.filter((v) => Number.isFinite(v));
  const n = validos.length;
  if (n === 0) return { n: 0, suma: 0, twap: null };
  const suma = validos.reduce((a, b) => a + b, 0);
  return { n, suma, twap: suma / n };
}

// ¿Hay que descartar este contrato? Sí si al descubrirlo ya le quedan
// 60 s o menos: no daría tiempo a juntar los 60 ticks del minuto final.
function debeDescartarContrato(segParaCierre) {
  return segParaCierre <= 60;
}

// Evalúa una señal en papel. Devuelve la simulación o null.
// El salto requerido se calcula desde el TWAP bloqueado (suma de las
// muestras reales), NUNCA desde avg60s ni avg15mFinal.
function evaluarSenalPapel({
  ticker, targetPrice, twapBloqueado, muestrasCapturadas, ticksPerdidos,
  segundosRestantes, brtiValue, yesAskDollars, noAskDollars,
  contractsQty = CONTRACTS_QTY, minReqMoveUsd = MIN_REQ_MOVE_USD,
  minNetEdgeDollars = MIN_NET_EDGE_DOLLARS,
} = {}) {
  if (segundosRestantes < 3 || segundosRestantes > 18) return null;
  if (ticksPerdidos > MAX_TICKS_PERDIDOS) return null;
  if (muestrasCapturadas <= 0 || twapBloqueado == null || !Number.isFinite(twapBloqueado)) return null;
  if (!Number.isFinite(targetPrice) || !Number.isFinite(brtiValue)) return null;
  const segundosRestantesReales = segundosRestantes - 1;
  if (segundosRestantesReales <= 0) return null;

  const sumaAcumulada = twapBloqueado * muestrasCapturadas;
  const totalMuestrasEfectivas = muestrasCapturadas + segundosRestantesReales;
  const brtiRequeridoRestante = ((targetPrice * totalMuestrasEfectivas) - sumaAcumulada) / segundosRestantesReales;
  const saltoRequeridoUSD = brtiRequeridoRestante - brtiValue;

  let direccion = null;
  let askDisponible = null;
  if (saltoRequeridoUSD <= -minReqMoveUsd) { direccion = 'yes'; askDisponible = yesAskDollars; }
  else if (saltoRequeridoUSD >= minReqMoveUsd) { direccion = 'no'; askDisponible = noAskDollars; }

  if (!direccion || askDisponible == null || !Number.isFinite(askDisponible) || askDisponible <= 0 || askDisponible >= 1) return null;

  const fee = calcularComisionPorContrato(askDisponible);
  const costoTotal = askDisponible + fee;
  const gananciaNeta = 1.00 - costoTotal;

  return {
    timestamp: new Date().toISOString(),
    ticker,
    segundosRestantes,
    direccionElegida: direccion,
    targetPrice,
    brtiValue,
    twapBloqueado: +twapBloqueado.toFixed(2),
    muestrasCapturadas,
    ticksPerdidos,
    saltoRequeridoUSD: +saltoRequeridoUSD.toFixed(2),
    askPriceDollars: askDisponible.toFixed(4),
    feePerContractDollars: +fee.toFixed(4),
    breakEvenProb: +(costoTotal * 100).toFixed(2),
    netProfitIfWinPerContract: +gananciaNeta.toFixed(4),
    viableDespuesDeComision: gananciaNeta >= minNetEdgeDollars,
    ordenV2Preview: construirPayloadOrdenV2(ticker, direccion, askDisponible, contractsQty),
  };
}

// Construye el registro de una ventana cerrada a partir del estado del
// auditor y de la liquidación oficial (o null si aún no está publicada).
function finalizarVentana(estado, oficial) {
  const { n, twap } = calcularTwapBloqueado(estado.muestras);
  const target = estado.contrato ? estado.contrato.targetPrice : null;
  const ticker = estado.contrato ? estado.contrato.ticker : null;
  const expirationValue = oficial && oficial.expirationValue != null ? Number(oficial.expirationValue) : null;
  return {
    ticker,
    targetPrice: target,
    muestrasCapturadas: n,
    twapLocal: twap == null ? null : +twap.toFixed(2),
    prediccionLocal: (twap == null || target == null) ? null : (twap >= target ? 'yes' : 'no'),
    avg60sCapturado: estado.ultimoBrti && Number.isFinite(estado.ultimoBrti.avg60s) ? +estado.ultimoBrti.avg60s.toFixed(2) : null,
    avg15mFinalCapturado: estado.ultimoBrti && Number.isFinite(estado.ultimoBrti.avg15mFinal) ? +estado.ultimoBrti.avg15mFinal.toFixed(2) : null,
    resultadoOficialKalshi: (oficial && oficial.result) || 'pendiente',
    brtiLiquidacionOficial: Number.isFinite(expirationValue) ? expirationValue : null,
    errorTwapVsOficial: (Number.isFinite(expirationValue) && twap != null) ? +(twap - expirationValue).toFixed(2) : null,
    simulacion: estado.simulacion || null,
    closedAt: estado.closedAt || new Date().toISOString(),
  };
}

function calcularStats(resultados) {
  // v16.3 — un registro puede venir en forma completa (con
  // .simulacion, lo que guarda 'paper_audit') o compacta (con
  // .senal/.viable, lo que guarda el historial 'cev_paper_windows').
  // Se normaliza para que las stats valgan sobre ambas.
  const normalizar = (r) => {
    const sim = r.simulacion || null;
    return {
      ...r,
      senal: sim ? sim.direccionElegida : (r.senal || null),
      viable: sim ? !!sim.viableDespuesDeComision : (r.viable === true ? true : (r.viable === false ? false : null)),
    };
  };
  const list = (Array.isArray(resultados) ? resultados : []).map(normalizar);
  const senales = list.filter((r) => r.senal).length;
  const viablesList = list.filter((r) => r.senal && r.viable === true);
  const viables = viablesList.length;
  const viablesLiquidadas = viablesList.filter((r) => r.resultadoOficialKalshi && r.resultadoOficialKalshi !== 'pendiente');
  const aciertosEnViables = viablesLiquidadas.filter((r) => r.senal === r.resultadoOficialKalshi).length;
  const conPrediccion = list.filter((r) => r.prediccionLocal && r.resultadoOficialKalshi && r.resultadoOficialKalshi !== 'pendiente');
  const aciertos = conPrediccion.filter((r) => r.prediccionLocal === r.resultadoOficialKalshi).length;
  const conError = list.filter((r) => r.errorTwapVsOficial != null && Number.isFinite(Number(r.errorTwapVsOficial)));
  const errorMedioAbsUSD = conError.length > 0
    ? +(conError.reduce((s, r) => s + Math.abs(Number(r.errorTwapVsOficial)), 0) / conError.length).toFixed(2)
    : null;
  const errorMaxAbsUSD = conError.length > 0
    ? +conError.reduce((m, r) => Math.max(m, Math.abs(Number(r.errorTwapVsOficial))), 0).toFixed(2)
    : null;
  return {
    ventanas: list.length,
    senales,
    viables,
    viablesLiquidadas: viablesLiquidadas.length,
    aciertosEnViables,
    prediccionCorrecta: aciertos,
    prediccionTotal: conPrediccion.length,
    errorMedioAbsUSD,
    errorMaxAbsUSD,
  };
}

// v16.3 — Registro compacto para el historial sin tope: solo los
// campos mínimos que hacen falta para las stats (nada de muestras ni
// de payloads). La señal se guarda como dirección + viable.
function compactarRegistro(registro) {
  if (!registro || typeof registro !== 'object') return null;
  const sim = registro.simulacion || null;
  return {
    ticker: registro.ticker || null,
    targetPrice: registro.targetPrice != null ? registro.targetPrice : null,
    twapLocal: registro.twapLocal != null ? registro.twapLocal : null,
    brtiLiquidacionOficial: registro.brtiLiquidacionOficial != null ? registro.brtiLiquidacionOficial : null,
    errorTwapVsOficial: registro.errorTwapVsOficial != null ? registro.errorTwapVsOficial : null,
    prediccionLocal: registro.prediccionLocal || null,
    resultadoOficialKalshi: registro.resultadoOficialKalshi || 'pendiente',
    senal: sim ? sim.direccionElegida : null,
    viable: sim ? !!sim.viableDespuesDeComision : null,
    closedAt: registro.closedAt || null,
  };
}

// Inserta o actualiza (misma ventana: mismo ticker + closedAt) un
// registro compacto en el historial SIN tope. Devuelve el historial.
function actualizarHistorial(historial, registro) {
  const list = Array.isArray(historial) ? historial : [];
  const compacto = compactarRegistro(registro);
  if (!compacto) return list;
  const idx = list.findIndex((r) => r.ticker === compacto.ticker && r.closedAt === compacto.closedAt);
  if (idx >= 0) list[idx] = compacto;
  else list.push(compacto);
  return list;
}

// --- Lecturas públicas de Kalshi (solo GET, sin clave) ---

async function fetchConTimeout(url, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Próximo contrato KXBTC15M abierto (el que cierra antes).
async function descubrirProximoContrato(fetchFn = fetchConTimeout) {
  const data = await fetchFn(`${BASE}/trade-api/v2/markets?series_ticker=${SERIES_TICKER}&status=open`);
  const ahora = Date.now();
  const abiertos = (data.markets || [])
    .filter((m) => new Date(m.close_time).getTime() > ahora)
    .sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime());
  if (abiertos.length === 0) return null;
  const m = abiertos[0];
  const targetPrice = parseTargetPrice(m);
  if (!Number.isFinite(targetPrice)) return null;
  return {
    ticker: m.ticker,
    targetPrice,
    closeMs: new Date(m.close_time).getTime(),
    closeIso: m.close_time,
  };
}

// Quote fresca del ticker exacto (sin caché): ask YES/NO en dólares y,
// tras el cierre, result + expiration_value oficiales.
async function obtenerQuoteContrato(ticker, fetchFn = fetchConTimeout) {
  const data = await fetchFn(`${BASE}/trade-api/v2/markets/${encodeURIComponent(ticker)}`);
  const m = (data && (data.market || data)) || null;
  if (!m || !m.ticker) return null;
  const yesAsk = m.yes_ask_dollars != null ? parseFloat(m.yes_ask_dollars) : null;
  const yesBid = m.yes_bid_dollars != null ? parseFloat(m.yes_bid_dollars) : null;
  const noAsk = m.no_ask_dollars != null
    ? parseFloat(m.no_ask_dollars)
    : (yesBid !== null ? +(1 - yesBid).toFixed(4) : null);
  return {
    ticker: m.ticker,
    status: m.status || null,
    result: m.result || null,
    expirationValue: m.expiration_value != null ? Number(m.expiration_value) : null,
    yesAskDollars: yesAsk,
    yesBidDollars: yesBid,
    noAskDollars: noAsk,
  };
}

// --- Auditor en memoria (un estado por userId) ---

const auditors = new Map(); // userId -> estado
let persistenciaHook = null;
let persistenciaHistorialHook = null;
let tickerInterval = null;

function crearEstadoAuditor() {
  return {
    enabled: false,
    startedAt: null,
    contrato: null,
    muestras: new Map(),
    ultimoUpdatedAt: null,
    simulacion: null,
    ultimoBrti: null,
    ultimoError: null,
    ultimoDescubrimientoMs: 0,
    ultimoHeartbeatMs: 0,
    tickEnCurso: false,
    twapActual: null,
    saltoActual: null,
    ticksEsperadosActual: null,
    ticksPerdidosActual: null,
    quoteActual: null,
    quoteEnVuelo: false,
    resultados: [],
    // v16.3 — arranque automático (flag por usuario, default false) e
    // historial SIN tope de ventanas liquidadas (compactas).
    autostart: false,
    historial: [],
  };
}

// v16.3 — Arranque automático: flag por usuario (default false, nunca
// true por defecto). Lo lee routes.js al arrancar el servidor y lo
// escribe POST /kalshi/paper-audit/autostart. Solo arranca el AUDITOR
// EN PAPEL; sin la env LIVE_TRADING_ENABLED y sin armar, no sale
// ninguna orden.
function setAutostart(userId, v) {
  let est = auditors.get(userId);
  if (!est) { est = crearEstadoAuditor(); auditors.set(userId, est); }
  est.autostart = v === true;
  return est.autostart;
}
function isAutostart(userId) {
  const est = auditors.get(userId);
  return !!(est && est.autostart);
}

// Registra dónde persistir (lo llama routes.js con db.setUserData).
// Sin hook, no se persiste (modo pruebas).
function setPersistencia(fn) {
  persistenciaHook = typeof fn === 'function' ? fn : null;
}

// v16.3 — Hook aparte para el historial sin tope (kind
// 'cev_paper_windows'). Sin hook, no se persiste (modo pruebas).
function setPersistenciaHistorial(fn) {
  persistenciaHistorialHook = typeof fn === 'function' ? fn : null;
}

async function persistir(userId) {
  const est = auditors.get(userId);
  if (!est || !persistenciaHook) return;
  try {
    await persistenciaHook(userId, est.resultados);
  } catch (e) {
    console.log('[paper-audit] No se pudo persistir la auditoría:', e.message);
  }
}

async function persistirHistorial(userId) {
  const est = auditors.get(userId);
  if (!est || !persistenciaHistorialHook) return;
  try {
    await persistenciaHistorialHook(userId, est.historial);
  } catch (e) {
    console.log('[paper-audit] No se pudo persistir el historial:', e.message);
  }
}

function getSnapshot(userId, ahoraMs = Date.now()) {
  const est = auditors.get(userId);
  if (!est) {
    return {
      enabled: false, startedAt: null, contrato: null, brti: null,
      twapBloqueado: null, muestrasCapturadas: 0, ticksEsperados: null,
      ticksPerdidos: null, saltoRequeridoUSD: null, yesAskDollars: null,
      noAskDollars: null, simulacion: null, resultados: [],
      stats: calcularStats([]), ultimoError: null,
      autostart: false, historialTotal: 0,
    };
  }
  // v16.3 — las stats se calculan sobre TODO el historial (sin tope);
  // si aún no hay historial, se usan las últimas 20 como antes.
  const fuenteStats = est.historial.length > 0 ? est.historial : est.resultados;
  return {
    enabled: est.enabled,
    startedAt: est.startedAt,
    contrato: est.contrato,
    brti: est.ultimoBrti,
    twapBloqueado: est.twapActual,
    muestrasCapturadas: est.muestras.size,
    ticksEsperados: est.ticksEsperadosActual,
    ticksPerdidos: est.ticksPerdidosActual,
    saltoRequeridoUSD: est.saltoActual,
    yesAskDollars: est.quoteActual ? est.quoteActual.yesAskDollars : null,
    noAskDollars: est.quoteActual ? est.quoteActual.noAskDollars : null,
    simulacion: est.simulacion,
    resultados: est.resultados,
    stats: calcularStats(fuenteStats),
    ultimoError: est.ultimoError,
    autostart: est.autostart,
    historialTotal: est.historial.length,
  };
}

function startAuditor(userId, resultadosPersistidos = [], historialPersistido = []) {
  let est = auditors.get(userId);
  if (!est) { est = crearEstadoAuditor(); auditors.set(userId, est); }
  est.enabled = true;
  est.startedAt = new Date().toISOString();
  est.contrato = null;
  est.muestras = new Map();
  est.ultimoUpdatedAt = null;
  est.simulacion = null;
  est.ultimoBrti = null;
  est.ultimoError = null;
  est.ultimoDescubrimientoMs = 0;
  est.ultimoHeartbeatMs = 0;
  est.twapActual = null;
  est.saltoActual = null;
  est.ticksEsperadosActual = null;
  est.ticksPerdidosActual = null;
  est.quoteActual = null;
  est.quoteEnVuelo = false;
  est.resultados = Array.isArray(resultadosPersistidos) ? resultadosPersistidos.slice(0, MAX_RESULTADOS) : [];
  // v16.3 — el historial sin tope: si no hay historial persistido
  // pero sí resultados, se siembra desde TODOS ellos (compactados)
  // para no perder la continuidad de las stats — no desde la vista
  // recortada a 20.
  if (Array.isArray(historialPersistido) && historialPersistido.length > 0) {
    est.historial = historialPersistido.filter((r) => r && r.ticker);
  } else if (Array.isArray(resultadosPersistidos) && resultadosPersistidos.length > 0) {
    est.historial = resultadosPersistidos.map(compactarRegistro).filter(Boolean);
  } else {
    est.historial = [];
  }
  ensureTicker();
  return getSnapshot(userId);
}

async function stopAuditor(userId) {
  const est = auditors.get(userId);
  if (!est) return getSnapshot(userId);
  est.enabled = false;
  est.contrato = null;
  await persistir(userId);
  await persistirHistorial(userId);
  return getSnapshot(userId);
}

// Un solo setInterval global de 1 s que recorre los usuarios habilitados.
// Perezoso (arranca al primer start) y con unref para no mantener vivo
// el proceso en pruebas. Se apaga solo cuando ya no queda nadie activo.
function ensureTicker() {
  if (tickerInterval) return;
  tickerInterval = setInterval(() => {
    let alguno = false;
    for (const [userId, est] of auditors) {
      if (!est.enabled) continue;
      alguno = true;
      if (!est.tickEnCurso) {
        est.tickEnCurso = true;
        tickAuditor(userId).catch(() => {}).finally(() => { est.tickEnCurso = false; });
      }
    }
    if (!alguno && tickerInterval) { clearInterval(tickerInterval); tickerInterval = null; }
  }, 1000);
  if (tickerInterval.unref) tickerInterval.unref();
}

// v16.3 — Evalúa la señal con una quote ya disponible, usando el
// estado ACTUAL (muestras y TWAP de ahora) y el R del momento en que
// se pidió la quote (rForzado; si es null, R se calcula con ahoraMs).
// Solo entre T-18 y T-3 y si aún no hay simulación; si evaluarSenalPapel
// devuelve null, no se congela nada y el próximo tick reintenta.
function evaluarSenalConQuote(est, quote, ahoraMs = Date.now(), rForzado = null) {
  if (!est || !est.contrato || est.simulacion) return null;
  if (!quote || quote.ticker !== est.contrato.ticker) return null;
  if (quote.fetchedAt != null && (ahoraMs - quote.fetchedAt) > 5000) return null;
  const closeEpochSec = Math.floor(est.contrato.closeMs / 1000);
  const R = rForzado != null ? rForzado : (closeEpochSec - Math.floor(ahoraMs / 1000));
  if (R < 3 || R > 18) return null;
  const { n, twap } = calcularTwapBloqueado(est.muestras);
  const ticksEsperados = 61 - R;
  const ticksPerdidos = Math.max(ticksEsperados - n, 0);
  const sim = evaluarSenalPapel({
    ticker: est.contrato.ticker,
    targetPrice: est.contrato.targetPrice,
    twapBloqueado: twap,
    muestrasCapturadas: n,
    ticksPerdidos,
    segundosRestantes: R,
    brtiValue: est.ultimoBrti ? est.ultimoBrti.value : null,
    yesAskDollars: quote.yesAskDollars,
    noAskDollars: quote.noAskDollars,
  });
  if (sim) est.simulacion = sim;
  return sim;
}

// Un tick del auditor (1 s). `deps` permite inyectar stubs en pruebas:
// { brtiState, descubrir, quote }. Por defecto usa el WS en memoria y
// la API pública de Kalshi.
async function tickAuditor(userId, ahoraMs = Date.now(), deps = {}) {
  const est = auditors.get(userId);
  if (!est || !est.enabled) return getSnapshot(userId, ahoraMs);
  const leerBrti = deps.brtiState || ((id) => brti.getBrtiState(id));
  const descubrir = deps.descubrir || descubrirProximoContrato;
  const cotizar = deps.quote || obtenerQuoteContrato;
  const segActualEpoch = Math.floor(ahoraMs / 1000);

  try {
    // 1. Sin contrato: descubrir el próximo cada 15 s.
    if (!est.contrato) {
      if (ahoraMs - est.ultimoDescubrimientoMs < 15000) return getSnapshot(userId, ahoraMs);
      est.ultimoDescubrimientoMs = ahoraMs;
      const nuevo = await descubrir();
      if (!nuevo || !Number.isFinite(nuevo.targetPrice)) return getSnapshot(userId, ahoraMs);
      const segParaCierre = Math.floor(nuevo.closeMs / 1000) - segActualEpoch;
      if (debeDescartarContrato(segParaCierre)) {
        est.ultimoError = `Contrato ${nuevo.ticker} descartado: ya está dentro del último minuto (${segParaCierre}s). Se espera la siguiente ventana.`;
        return getSnapshot(userId, ahoraMs);
      }
      est.contrato = nuevo;
      est.muestras = new Map();
      est.ultimoUpdatedAt = null;
      est.simulacion = null;
      est.ultimoBrti = null;
      est.twapActual = null;
      est.saltoActual = null;
      est.ticksEsperadosActual = null;
      est.ticksPerdidosActual = null;
      est.quoteActual = null;
      est.quoteEnVuelo = false;
      est.ultimoError = null;
      return getSnapshot(userId, ahoraMs);
    }

    const closeEpochSec = Math.floor(est.contrato.closeMs / 1000);
    const R = closeEpochSec - segActualEpoch;

    // 2. Fuera del último minuto: heartbeat cada 30 s (leer el BRTI
    //    actualiza lastPollAt y mantiene vivo el WS).
    if (R > 60) {
      if (ahoraMs - est.ultimoHeartbeatMs >= 30000) {
        est.ultimoHeartbeatMs = ahoraMs;
        const s = leerBrti(userId);
        if (s && s.value != null) {
          est.ultimoBrti = { value: s.value, avg60s: s.avg60s, avg15mFinal: s.avg15mFinal, updatedAt: s.updatedAt };
        }
      }
      return getSnapshot(userId, ahoraMs);
    }

    // 3. Ventana del último minuto (T-60 a T-1).
    // v16.3 — MUESTREO DESACOPLADO: el tick BRTI se lee de memoria
    // (síncrono, sin red) y se muestrea SIEMPRE, aunque la cotización
    // tarde o falle. La cotización solo se pide cuando R ≤ 20, en
    // paralelo y sin esperar: un fallo o lentitud suya ya no salta
    // segundos de muestreo ni hace crecer ticksPerdidos. La señal se
    // evalúa con la última quote fresca (≤5 s) del mismo ticker.
    if (R >= 1 && R <= 60) {
      const estadoBrti = await Promise.resolve(leerBrti(userId));
      if (!estadoBrti || estadoBrti.value == null) {
        est.ultimoError = 'Sin tick BRTI (WS sin dato). El auditor espera al próximo tick.';
        return getSnapshot(userId, ahoraMs);
      }
      const edadMs = estadoBrti.updatedAt ? ahoraMs - new Date(estadoBrti.updatedAt).getTime() : null;
      if (edadMs == null || edadMs > 15000) {
        est.ultimoError = 'Tick BRTI desactualizado (>15 s). El auditor espera al próximo tick.';
        return getSnapshot(userId, ahoraMs);
      }
      est.ultimoBrti = { value: estadoBrti.value, avg60s: estadoBrti.avg60s, avg15mFinal: estadoBrti.avg15mFinal, updatedAt: estadoBrti.updatedAt };
      est.ultimoError = null;

      // Solo suma la muestra si el tick es fresco (updatedAt cambió).
      if (estadoBrti.updatedAt !== est.ultimoUpdatedAt) {
        est.ultimoUpdatedAt = estadoBrti.updatedAt;
        est.muestras.set(segActualEpoch, estadoBrti.value);
      }

      // Cotización en paralelo, sin bloquear: solo R ≤ 20 y una sola
      // petición en vuelo. Si falla o tarda, el muestreo sigue igual.
      if (R <= 20 && !est.quoteEnVuelo) {
        est.quoteEnVuelo = true;
        const tickerPedido = est.contrato.ticker;
        const solicitadoMs = ahoraMs;
        const rPedido = R;
        Promise.resolve()
          .then(() => cotizar(tickerPedido))
          .then((q) => {
            est.quoteEnVuelo = false;
            if (!q || q.ticker !== tickerPedido) return;
            if (!est.contrato || est.contrato.ticker !== tickerPedido) return;
            const quoteRecibida = { yesAskDollars: q.yesAskDollars, noAskDollars: q.noAskDollars, ticker: q.ticker, fetchedAt: solicitadoMs };
            est.quoteActual = quoteRecibida;
            // v16.3 — al llegar la quote, evaluar con el estado actual
            // (muestras y TWAP de ahora) y el R del momento en que se
            // pidió (la quote tarda <1 s en lo normal; el próximo tick
            // reevalúa con la quote ya en caché si no hubo señal).
            evaluarSenalConQuote(est, quoteRecibida, solicitadoMs, rPedido);
          })
          .catch(() => { est.quoteEnVuelo = false; });
      }
      const quote = est.quoteActual && est.quoteActual.ticker === est.contrato.ticker
        && (ahoraMs - (est.quoteActual.fetchedAt || 0)) <= 5000
        ? est.quoteActual : null;

      const { n, suma, twap } = calcularTwapBloqueado(est.muestras);
      const ticksEsperados = 61 - R;
      const ticksPerdidos = Math.max(ticksEsperados - n, 0);
      est.twapActual = twap == null ? null : +twap.toFixed(2);
      est.ticksEsperadosActual = ticksEsperados;
      est.ticksPerdidosActual = ticksPerdidos;
      // v16.3 — quoteActual YA NO se toca aquí: la gestiona solo la
      // petición en paralelo (con ticker + fetchedAt); si se
      // sobrescribiera sin ellos, la frescura de la quote se perdería.

      const segundosRestantesReales = Math.max(R - 1, 0);
      const totalMuestrasEfectivas = n + segundosRestantesReales;
      const brtiRequeridoRestante = (segundosRestantesReales > 0 && twap != null)
        ? ((est.contrato.targetPrice * totalMuestrasEfectivas) - suma) / segundosRestantesReales
        : twap;
      est.saltoActual = (brtiRequeridoRestante != null && Number.isFinite(brtiRequeridoRestante))
        ? +(brtiRequeridoRestante - estadoBrti.value).toFixed(2)
        : null;

      // v16.3 — la señal se evalúa con la quote en caché (fresca) o
      // al llegar la quote pedida (ver callback de arriba).
      evaluarSenalConQuote(est, quote, ahoraMs);
      return getSnapshot(userId, ahoraMs);
    }

    // 4. Cierre (R <= 0): congela la ventana y pide la liquidación
    //    oficial 15 s después (la API tarda en publicar result).
    if (R <= 0) {
      const estadoCierre = {
        contrato: est.contrato,
        muestras: new Map(est.muestras),
        simulacion: est.simulacion,
        ultimoBrti: est.ultimoBrti,
      };
      const tickerCerrado = est.contrato.ticker;
      est.contrato = null;
      est.muestras = new Map();
      est.simulacion = null;
      est.twapActual = null;
      est.saltoActual = null;
      est.ticksEsperadosActual = null;
      est.ticksPerdidosActual = null;
      est.quoteActual = null;
      est.quoteEnVuelo = false;
      est.ultimoDescubrimientoMs = 0;
      const guardarOActualizarRegistro = async (oficial) => {
        const registro = finalizarVentana(estadoCierre, oficial);
        const e2 = auditors.get(userId);
        if (!e2) return registro;
        const idx = e2.resultados.findIndex((r) => r.ticker === tickerCerrado && r.closedAt === estadoCierre.closedAt);
        if (idx >= 0) {
          e2.resultados[idx] = registro;
        } else {
          estadoCierre.closedAt = registro.closedAt;
          e2.resultados.unshift(registro);
          e2.resultados = e2.resultados.slice(0, MAX_RESULTADOS);
        }
        // v16.3 — el historial sin tope también se actualiza (misma
        // ventana: se actualiza en su sitio, no se duplica).
        e2.historial = actualizarHistorial(e2.historial, registro);
        await persistir(userId);
        await persistirHistorial(userId);
        return registro;
      };
      const t = setTimeout(async () => {
        let oficial = null;
        try { oficial = await cotizar(tickerCerrado); } catch { oficial = null; }
        const reg15 = await guardarOActualizarRegistro(oficial);
        // Si a los 15 s Kalshi aún no ha publicado result o expiration_value, reintenta a los 45 s (30 s después).
        if (!reg15 || reg15.resultadoOficialKalshi === 'pendiente' || reg15.brtiLiquidacionOficial == null) {
          const t2 = setTimeout(async () => {
            let oficial45 = null;
            try { oficial45 = await cotizar(tickerCerrado); } catch { oficial45 = null; }
            if (oficial45 && (oficial45.result || oficial45.expirationValue != null)) {
              await guardarOActualizarRegistro(oficial45);
            }
          }, 30000);
          if (t2.unref) t2.unref();
        }
      }, 15000);
      if (t.unref) t.unref();
      return getSnapshot(userId, ahoraMs);
    }
  } catch (e) {
    est.ultimoError = e.message || 'Error en el tick del auditor.';
    return getSnapshot(userId, ahoraMs);
  }
  return getSnapshot(userId, ahoraMs);
}

module.exports = {
  CONTRACTS_QTY, MIN_REQ_MOVE_USD, MIN_NET_EDGE_DOLLARS, MAX_TICKS_PERDIDOS, MAX_RESULTADOS,
  calcularComisionPorContrato, construirPayloadOrdenV2, calcularTwapBloqueado,
  debeDescartarContrato, evaluarSenalPapel, finalizarVentana, calcularStats,
  compactarRegistro, actualizarHistorial,
  descubrirProximoContrato, obtenerQuoteContrato,
  setPersistencia, setPersistenciaHistorial, setAutostart, isAutostart,
  getSnapshot, startAuditor, stopAuditor, tickAuditor, evaluarSenalConQuote,
  crearEstadoAuditor,
  // Solo para pruebas: inspeccionar el estado en memoria.
  _auditors: auditors,
};
