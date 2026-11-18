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
// - Quote fresca al ticker exacto (GET público, sin caché de 15 s).
// - Persistencia: solo al cerrar ventana y al parar/arrancar, nunca
//   cada segundo (vía hook setPersistencia, registrado en routes.js).
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
  const list = Array.isArray(resultados) ? resultados : [];
  const senales = list.filter((r) => r.simulacion).length;
  const viablesList = list.filter((r) => r.simulacion && r.simulacion.viableDespuesDeComision);
  const viables = viablesList.length;
  const viablesLiquidadas = viablesList.filter((r) => r.resultadoOficialKalshi && r.resultadoOficialKalshi !== 'pendiente');
  const aciertosEnViables = viablesLiquidadas.filter((r) => r.simulacion.direccionElegida === r.resultadoOficialKalshi).length;
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
    resultados: [],
  };
}

// Registra dónde persistir (lo llama routes.js con db.setUserData).
// Sin hook, no se persiste (modo pruebas).
function setPersistencia(fn) {
  persistenciaHook = typeof fn === 'function' ? fn : null;
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

function getSnapshot(userId, ahoraMs = Date.now()) {
  const est = auditors.get(userId);
  if (!est) {
    return {
      enabled: false, startedAt: null, contrato: null, brti: null,
      twapBloqueado: null, muestrasCapturadas: 0, ticksEsperados: null,
      ticksPerdidos: null, saltoRequeridoUSD: null, yesAskDollars: null,
      noAskDollars: null, simulacion: null, resultados: [],
      stats: calcularStats([]), ultimoError: null,
    };
  }
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
    stats: calcularStats(est.resultados),
    ultimoError: est.ultimoError,
  };
}

function startAuditor(userId, resultadosPersistidos = []) {
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
  est.resultados = Array.isArray(resultadosPersistidos) ? resultadosPersistidos.slice(0, MAX_RESULTADOS) : [];
  ensureTicker();
  return getSnapshot(userId);
}

async function stopAuditor(userId) {
  const est = auditors.get(userId);
  if (!est) return getSnapshot(userId);
  est.enabled = false;
  est.contrato = null;
  await persistir(userId);
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
    if (R >= 1 && R <= 60) {
      const [estadoBrti, quote] = await Promise.all([
        Promise.resolve(leerBrti(userId)),
        cotizar(est.contrato.ticker),
      ]);
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

      const { n, suma, twap } = calcularTwapBloqueado(est.muestras);
      const ticksEsperados = 61 - R;
      const ticksPerdidos = Math.max(ticksEsperados - n, 0);
      est.twapActual = twap == null ? null : +twap.toFixed(2);
      est.ticksEsperadosActual = ticksEsperados;
      est.ticksPerdidosActual = ticksPerdidos;
      est.quoteActual = quote ? { yesAskDollars: quote.yesAskDollars, noAskDollars: quote.noAskDollars } : null;

      const segundosRestantesReales = Math.max(R - 1, 0);
      const totalMuestrasEfectivas = n + segundosRestantesReales;
      const brtiRequeridoRestante = (segundosRestantesReales > 0 && twap != null)
        ? ((est.contrato.targetPrice * totalMuestrasEfectivas) - suma) / segundosRestantesReales
        : twap;
      est.saltoActual = (brtiRequeridoRestante != null && Number.isFinite(brtiRequeridoRestante))
        ? +(brtiRequeridoRestante - estadoBrti.value).toFixed(2)
        : null;

      if (!est.simulacion && R <= 18 && R >= 3 && quote && quote.ticker === est.contrato.ticker) {
        est.simulacion = evaluarSenalPapel({
          ticker: est.contrato.ticker,
          targetPrice: est.contrato.targetPrice,
          twapBloqueado: twap,
          muestrasCapturadas: n,
          ticksPerdidos,
          segundosRestantes: R,
          brtiValue: estadoBrti.value,
          yesAskDollars: quote.yesAskDollars,
          noAskDollars: quote.noAskDollars,
        });
      }
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
        await persistir(userId);
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
  descubrirProximoContrato, obtenerQuoteContrato,
  setPersistencia, getSnapshot, startAuditor, stopAuditor, tickAuditor,
  crearEstadoAuditor,
  // Solo para pruebas: inspeccionar el estado en memoria.
  _auditors: auditors,
};
