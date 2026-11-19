// paperTrader.js — v17: TRADER CONTINUO EN PAPEL (sin dinero real).
//
// PAPEL SOLAMENTE. Este módulo NUNCA envía órdenes a Kalshi: no hay
// ningún POST/PUT/DELETE a Kalshi aquí, ni importa liveTrader.js ni
// toca LIVE_TRADING_ENABLED. La única lectura de Kalshi es GET
// público (mercados y quote), reutilizada de paperAuditor.js, y el
// tick BRTI en memoria de server/brti.js. Live sigue APAGADO y este
// módulo no lo puede encender: no hay ningún camino desde aquí hacia
// enviarOrdenReal.
//
// Qué hace: un motor propio por usuario, con intervalo de 1 s
// (perezoso, con unref, como el auditor), que opera EN PAPEL el
// contrato KXBTC15M durante TODA la ventana (v16.10: antes solo el
// último minuto) con un modelo de probabilidad continuo y salida
// continua (no solo "entrar y esperar a la liquidación" como el
// auditor). Cada trade cerrado guarda también el P&L hipotético de
// haber mantenido hasta liquidación (holdPnl), para comparar salida
// vs mantener.
//
// v17 (decisión de Luis, 18-nov): PAPEL SIN LÍMITES. (1) Se QUITA
// el tope de 5 entradas/día: evaluarEntrada ya no lo comprueba y
// 'max_entradas_dia' desaparece de los motivos; entradasHoy se
// sigue contando (abrirPosicion, resetDiaSiCambio, calcularStats)
// solo para mostrarlo en §6. (2) Se permite RE-ENTRAR en la misma
// ventana tras una salida: el estado sinReentrada desaparece y el
// tick siguiente a una salida evalúa la entrada con normalidad.
// Sigue siendo 1 posición abierta a la vez: solo se re-entra cuando
// ya no hay posición abierta (el `if (!est.posicionAbierta)`).
// (3) ultimaEntrada lleva `id` único por entrada (nuevoTradeId),
// para que el espejo vivo (v17, dedup por entrada) distinga dos
// entradas del mismo ticker.
//
// v16.10 (decisión de Luis, 18-nov 22:36): "Evaluar toda la ventana
// y quitar el lock roto de la salida". (1) El tick evalúa entrada y
// salida a cualquier R (desde el inicio de la ventana hasta R=1);
// antes del último minuto n=0 y R'=60 (el modelo ya lo contempla) y
// el TWAP bloqueado es null hasta que haya muestras del minuto
// final. (2) La salida por lock roto desaparece: quedan solo
// ganancia, stop-loss y fin de ventana. (3) Cada evaluación de
// entrada (o intento bloqueado) deja constancia en el anillo
// `evaluaciones` en memoria (ver abajo). El vivo NO cambia:
// ultimaEntrada ahora puede generarse a cualquier R y sigue
// alimentando el camino v16.9 (ensureTraderObserver →
// handleTraderEntry → verificarLimitesTrader → evaluarDecision).
//
// MODELO DE PROBABILIDAD (documentado aquí y testeado en
// tests-v16.6.mjs):
//   n    = ticks muestreados del minuto final (Map como el auditor).
//   R    = segundos para el cierre del contrato.
//   R'   = clamp(R−1, 0, 60). Si R>60, n=0 y R'=60 (sin muestras del
//          minuto final, el promedio requerido es el propio target).
//   S    = suma de las muestras del minuto final.
//   v    = valor BRTI actual. target = objetivo del contrato.
//   Promedio restante requerido para empatar:
//     reqAvg = (target×(n+R') − S)/R'   (si R'>0)
//     salto  = reqAvg − v
//   Sigma = desviación estándar MUESTRAL (denominador n−1) del anillo
//   de los últimos 120 valores BRTI; mínimo 10 muestras para entrar;
//   suelo sigma ≥ $1 (un anillo plano no da p=0/1 por división entre 0).
//   p_yes = Φ(−salto × √R' / σ),  p_no = 1 − p_yes,
//   donde Φ es la normal acumulada. Intuición: la media de los R'
//   ticks restantes se modela como N(v, σ²/R'); empatar exige que
//   esa media llegue a reqAvg. Si R'=0, p lo decide el TWAP bloqueado
//   vs target (1 o 0): sin tiempo restante, el promedio ya está
//   decidido por lo muestreado.
//
// EV POR CONTRATO (comprar un lado al ask a, fee taker Kalshi):
//   fee = 0.07×a×(1−a)   (reutiliza calcularComisionPorContrato).
//   EV  = p×(1 − a − fee) − (1−p)×(a + fee).
//   A precio justo (a = p), EV = −fee exactamente: sin filo no hay
//   edge, solo comisión. Por eso el test del decaimiento NO dice que
//   el EV a ask fijo caiga: a ask fijo el EV SUBE cuando R baja
//   (porque p sube); lo que decae es el precio de mercado — con el
//   bloqueo fijo, el ask justo (a = p) sube hacia $1 y la ganancia
//   máxima (1 − a − fee) se achica hasta la comisión.
//
// ENTRADA EN PAPEL (1 contrato; mismos topes del experimento live
// acotado, para que el papel sea comparable al live):
//   - Sin posición abierta en esa ventana. v17: tras una salida SE
//     PUEDE volver a entrar en la misma ventana si el EV lo
//     justifica (sin re-entrada ya no existe).
//   - Se evalúa a cualquier R (v16.10): desde el inicio de la
//     ventana hasta R=1. Antes del último minuto n=0, R'=60 y el
//     TWAP bloqueado es null (sin muestras del minuto final); el
//     salto es target − v y p sale de la normal con R'=60.
//   - Quote fresca (≤5 s) del mismo ticker, pedida con el mismo
//     throttle (≥5 s) a cualquier R.
//   - Sigma disponible (≥10 muestras en el anillo) y R' ≥ 1.
//   - EV×qty > $0.015 por orden (MIN_NET_EDGE_DOLLARS del auditor).
//   - Notional ≤ $5 por orden (1 contrato × ask < $1: siempre se
//     cumple, pero la guarda está y se testea).
//   - v17: SIN máximo de entradas/día (antes 5, UTC). entradasHoy
//     se sigue contando solo para mostrarlo.
//   Se entra por el lado de mayor EV (SÍ o NO, el que sea).
//
// SALIDA CONTINUA EN PAPEL (cada segundo, con posición abierta y
// quote fresca, a cualquier R; sin quote fresca se mantiene y se
// reintenta al segundo siguiente; NUNCA se sale con dato
// desactualizado). Reglas vigentes (v16.10):
//   (b) ganancia: valor neto de salida ≥ costo + $0.02 por contrato.
//   (c) stop-loss: valor neto ≤ 50% del costo.
//   (d) fin de ventana (R ≤ 3): si el valor neto < costo, vende por
//       lo que queda en vez de esperar al $0 (si va ganando, se
//       mantiene hasta liquidación).
//   La regla (a) lock roto se ELIMINÓ en v16.10 por decisión de
//   Luis (18-nov 22:36): el salto ya no vende nunca. El dato que la
//   mató: ventana 26NOV182330-30, entrada NO a $0.45 a las 22:29:01
//   y salida 1 s después por lock roto (−$0.0445 en papel).
//   Precio de salida: SÍ → yesBidDollars real del quote; NO →
//   1 − yesAskDollars. SUPOSICIÓN DOCUMENTADA: la quote NO trae
//   noBidDollars; se usa la identidad de libro único (la misma que
//   el código ya usa para noAsk = 1 − yesBid): en un mercado
//   yes/no de suma $1, el bid del NO es 1 − ask del SÍ. Si el dato
//   necesario no está (yesBid null para SÍ, yesAsk null para NO),
//   no hay precio de salida y se mantiene.
//   Valor neto de salida = precio de salida − fee(precio de salida).
//
// REGISTRO DE EVALUACIONES (v16.10, diagnóstico "por qué no
// apostó"): cada tick en que se evalúa —o se intenta evaluar— una
// entrada y no se entra, deja constancia en `evaluaciones`, un
// anillo en memoria con las últimas 20 por usuario, newest first:
//   { at: ISO string, R: segundos restantes (number),
//     lado: 'yes'|'no'|null, p: number|null, ev: number|null,
//     ask: number|null, motivo: string }.
//   Motivos: 'entrada' cuando entra; si no, 'sin_quote_fresca',
//   'sin_ev_valido', 'ev_bajo', 'max_notional'
//   (los que devuelve evaluarEntrada), 'sin_sigma' (sigma null),
//   'sin_tick_brti', 'tick_desactualizado', 'sin_tiempo' (R'<1).
//   v17: 'max_entradas_dia' y 'sin_reentrada' YA NO EXISTEN (sin
//   tope diario y con re-entrada permitida). Solo se registra
//   cuando la evaluación de entrada corre o está bloqueada (sin
//   posición abierta; con posición abierta no se registra nada de
//   entrada). p/ev/ask/lado solo se rellenan cuando evaluarEntrada
//   devuelve un candidato (ev_bajo, max_notional) o se entra; en
//   los bloqueos previos son null. Precedencia de los bloqueos:
//   sin_tick_brti → tick_desactualizado →
//   sin_quote_fresca → sin_sigma → sin_tiempo → evaluarEntrada.
//   (v17: sin_reentrada ya no bloquea nada y max_entradas_dia ya
//   no existe.)
//   EN MEMORIA, NO persistido: es diagnóstico por segundo y
//   persistirlo en cada tick sería carga de escritura sin valor; los
//   trades sí siguen persistidos. Se expone en getSnapshot como
//   `evaluaciones` (el cliente lo renderiza con este contrato
//   exacto). Se limpia al arrancar y al descubrir un contrato nuevo
//   (es diagnóstico de la ventana en curso); al cerrar la ventana se
//   conserva para poder inspeccionar la última ventana.
//
// LIQUIDACIÓN: al cerrar la ventana (R≤0) sin salida, la posición
// se liquida en papel al resultado oficial ($1 o $0 según el lado)
// cuando se publique (se pide a los 15 s, reintento a los 45 s,
// como el auditor); si no hay resultado aún, queda pendiente y se
// finaliza al llegar. El holdPnl de los trades cerrados por salida
// se completa en ese mismo momento.
//
// PERSISTENCIA: kind 'cev_paper_trades' (vía hook setPersistencia,
// registrado en routes.js con db.setUserData). Se persiste al
// entrar, al salir, al cerrar ventana con posición y al parar,
// NUNCA cada segundo. Incluye la posición abierta: al rearrancar,
// si el contrato descubierto es el mismo ticker, la posición se
// reanuda; si es otro ticker, la ventana ya cerró y pasa a
// pendiente de liquidación.
// v16.9 — ENTRADA VISIBLE PARA EL VIVO: al entrar en papel se
// guarda además `ultimaEntrada` (transitoria, NO persistida) en el
// estado; liveTrader la lee del snapshot (ensureTraderObserver +
// handleTraderEntry) para espejar la entrada en vivo. El camino es
// liveTrader → paperTrader en lectura: este módulo sigue sin enviar
// órdenes ni llamar a liveTrader.
const brti = require('./brti');
const {
  calcularComisionPorContrato,
  calcularTwapBloqueado,
  descubrirProximoContrato,
  obtenerQuoteContrato,
} = require('./paperAuditor');

// v16.9 — Las constantes de límites y las funciones puras del modelo
// viven en traderEval.js (extracción sin cambios de fórmula) y se
// re-exportan aquí con la misma API pública, para que los tests y
// demás imports sigan funcionando sin tocarlos.
const traderEval = require('./traderEval');
const {
  QTY_POR_ORDEN, MAX_NOTIONAL_USD, MIN_EV_USD,
  MIN_MUESTRAS_SIGMA, SIGMA_MIN_USD, ANILLO_MAX,
  GANANCIA_MIN_USD, STOP_FRACCION_COSTO, R_FIN_VENTANA,
  QUOTE_FRESCA_MS, QUOTE_THROTTLE_MS, MAX_TRADES, MAX_TRADES_SNAPSHOT,
  normalCdf, erf, calcularSaltoRequerido, calcularProbabilidad,
  calcularSigmaAnillo, calcularEV, precioSalida, valorNetoSalida,
  evaluarEntrada, evaluarSalida, calcularHoldPnl, calcularStats, dayKey,
} = traderEval;

function resetDiaSiCambio(est, hoy = dayKey()) {
  if (est.day !== hoy) {
    est.day = hoy;
    est.entradasHoy = 0;
  }
  return est;
}

// --- Estado por usuario + hooks inyectables ---

const traders = new Map(); // userId -> estado
let persistenciaHook = null;
let tickerInterval = null;
let tradeSeq = 0;
// v16.10 — Tamaño del anillo de evaluaciones de entrada (ver
// REGISTRO DE EVALUACIONES en el encabezado).
const MAX_EVALUACIONES = 20;

// v16.10 — Registra una evaluación de entrada (o un intento
// bloqueado) en el anillo en memoria del usuario: newest first,
// máx. MAX_EVALUACIONES. `reg` lleva { at, R, lado, p, ev, ask,
// motivo } con el contrato exacto del encabezado.
function registrarEvaluacion(est, reg) {
  if (!est) return;
  if (!Array.isArray(est.evaluaciones)) est.evaluaciones = [];
  est.evaluaciones.unshift({
    at: reg.at,
    R: reg.R,
    lado: reg.lado != null ? reg.lado : null,
    p: reg.p != null ? reg.p : null,
    ev: reg.ev != null ? reg.ev : null,
    ask: reg.ask != null ? reg.ask : null,
    motivo: reg.motivo,
  });
  est.evaluaciones = est.evaluaciones.slice(0, MAX_EVALUACIONES);
}

function setPersistencia(fn) {
  persistenciaHook = typeof fn === 'function' ? fn : null;
}

function crearEstadoTrader() {
  return {
    enabled: false,
    startedAt: null,
    contrato: null,
    muestras: new Map(),
    anillo: [],
    ultimoUpdatedAt: null,
    ultimoBrti: null,
    ultimoError: null,
    ultimoDescubrimientoMs: 0,
    tickEnCurso: false,
    twapActual: null,
    saltoActual: null,
    pActual: null,
    sigmaActual: null,
    quoteActual: null,
    quoteEnVuelo: false,
    posicionAbierta: null,
    // v16.9 — Última entrada en papel de la ventana en curso, para
    // que liveTrader la espeje en vivo. Transitoria: NO se persiste
    // (la posición abierta sí). Se limpia al arrancar, al descubrir
    // un contrato nuevo y al cerrar la ventana.
    ultimaEntrada: null,
    // v17: sinReentrada ELIMINADO — tras una salida se puede
    // volver a entrar en la misma ventana si el EV lo justifica.
    // v16.10 — Anillo de evaluaciones de entrada de la ventana en
    // curso (ver encabezado). En memoria, NO se persiste (ver
    // serializarEstado).
    evaluaciones: [],
    liquidacionProgramada: {},
    trades: [],
    day: null,
    entradasHoy: 0,
  };
}

function serializarEstado(est) {
  // v16.10 — `evaluaciones` NO se persiste a propósito: es
  // diagnóstico por segundo (hasta 1 registro/tick) y persistirlo
  // en cada tick sería carga de escritura sin valor; los trades sí
  // siguen persistidos (al entrar, al salir, al cerrar ventana y
  // al parar).
  return {
    trades: est.trades,
    posicionAbierta: est.posicionAbierta,
    day: est.day,
    entradasHoy: est.entradasHoy,
    updatedAt: new Date().toISOString(),
  };
}

async function persistir(userId) {
  const est = traders.get(userId);
  if (!est || !persistenciaHook) return;
  try { await persistenciaHook(userId, serializarEstado(est)); } catch (e) {
    console.log('[paper-trader] No se pudo persistir el registro en papel:', e.message);
  }
}

function nuevoTradeId() {
  tradeSeq += 1;
  return `pt-${Date.now().toString(36)}-${tradeSeq}`;
}

function tradeDesdePosicion(pos, extra = {}) {
  return {
    id: nuevoTradeId(),
    ticker: pos.ticker,
    targetPrice: pos.targetPrice,
    lado: pos.lado,
    askEntrada: pos.askEntrada,
    feeEntrada: pos.feeEntrada,
    costoTotal: pos.costoTotal,
    enteredAt: pos.enteredAt,
    pEstimada: pos.pEstimada,
    evEstimada: pos.evEstimada,
    exitedAt: null,
    motivoSalida: null,
    precioSalida: null,
    feeSalida: null,
    valorNetoSalida: null,
    pnlUsd: null,
    holdPnlUsd: null,
    resultadoOficial: null,
    estado: 'cerrado',
    closedAt: null,
    ...extra,
  };
}

function empujarAnillo(est, valor) {
  if (!Number.isFinite(valor)) return;
  est.anillo.push(valor);
  if (est.anillo.length > ANILLO_MAX) est.anillo.splice(0, est.anillo.length - ANILLO_MAX);
}

function abrirPosicion(est, { ticker, targetPrice, lado, ask, fee, p, ev, R, brtiValue, ahoraMs, quoteFetchedAt }) {
  const costo = +(Number(ask) + Number(fee)).toFixed(4);
  est.posicionAbierta = {
    ticker,
    lado,
    targetPrice,
    askEntrada: +Number(ask).toFixed(4),
    feeEntrada: +Number(fee).toFixed(4),
    costoTotal: costo,
    enteredAt: new Date(ahoraMs).toISOString(),
    segundosRestantesEntrada: R,
    pEstimada: +Number(p).toFixed(4),
    evEstimada: +Number(ev).toFixed(4),
    brtiEntrada: brtiValue,
  };
  // v16.9 — Entrada visible para el vivo: liveTrader la lee del
  // snapshot y la espeja (o la registra como would-send) con
  // handleTraderEntry. quoteFetchedAt es el fetchedAt de la quote
  // fresca usada en este tick: el vivo la exige fresca (≤5 s).
  // v17 — `id` único por entrada (nuevoTradeId): el espejo vivo
  // deduce por entrada, no por ticker, así que dos entradas del
  // mismo ticker ya no se confunden.
  est.ultimaEntrada = {
    id: nuevoTradeId(),
    ticker,
    lado,
    ask: +Number(ask).toFixed(4),
    fee: +Number(fee).toFixed(4),
    p: +Number(p).toFixed(4),
    ev: +Number(ev).toFixed(4),
    enteredAt: new Date(ahoraMs).toISOString(),
    quoteFetchedAt: quoteFetchedAt != null ? quoteFetchedAt : null,
  };
  est.entradasHoy += 1;
  return est.posicionAbierta;
}

function cerrarPosicion(est, { motivo, precioSalida: precio, ahoraMs }) {
  const pos = est.posicionAbierta;
  if (!pos) return null;
  est.posicionAbierta = null;
  const feeSalida = precio != null ? calcularComisionPorContrato(precio) : 0;
  const valorNeto = precio != null ? +(precio - feeSalida).toFixed(4) : null;
  const pnl = valorNeto != null ? +(valorNeto - pos.costoTotal).toFixed(4) : null;
  const trade = tradeDesdePosicion(pos, {
    exitedAt: new Date(ahoraMs).toISOString(),
    motivoSalida: motivo,
    precioSalida: precio != null ? +Number(precio).toFixed(4) : null,
    feeSalida: +Number(feeSalida).toFixed(4),
    valorNetoSalida: valorNeto,
    pnlUsd: pnl,
    estado: 'cerrado',
    closedAt: new Date(ahoraMs).toISOString(),
  });
  est.trades.unshift(trade);
  est.trades = est.trades.slice(0, MAX_TRADES);
  // v17: ya no se marca sinReentrada — tras la salida se puede
  // volver a entrar en la misma ventana si el EV lo justifica.
  return trade;
}

// La ventana cerró con la posición abierta: pasa a pendiente de
// liquidación (su P&L se fija cuando llegue el resultado oficial).
function convertirPosicionAPendiente(est) {
  const pos = est.posicionAbierta;
  if (!pos) return null;
  est.posicionAbierta = null;
  const trade = tradeDesdePosicion(pos, {
    motivoSalida: 'liquidacion',
    estado: 'pendiente-liquidacion',
  });
  est.trades.unshift(trade);
  est.trades = est.trades.slice(0, MAX_TRADES);
  return trade;
}

// Completa la liquidación de un ticker: las posiciones pendientes se
// cierran con su P&L real (1 o 0 según el lado) y los trades ya
// cerrados por salida completan su holdPnl. Sin resultado oficial
// no se toca nada (queda pendiente).
async function finalizarLiquidacion(userId, { ticker, oficial } = {}) {
  const est = traders.get(userId);
  if (!est) return { ok: false, reason: 'sin_estado', actualizados: 0 };
  const res = oficial && typeof oficial.result === 'string' ? oficial.result.toLowerCase() : null;
  if (res !== 'yes' && res !== 'no') return { ok: false, reason: 'sin_resultado', actualizados: 0 };
  const ahoraIso = new Date().toISOString();
  let actualizados = 0;
  for (const t of est.trades) {
    if (!t || t.ticker !== ticker) continue;
    if (t.estado === 'pendiente-liquidacion') {
      const pnl = calcularHoldPnl({ lado: t.lado, costoTotal: t.costoTotal, resultadoOficial: res });
      t.pnlUsd = pnl;
      t.holdPnlUsd = pnl;
      t.resultadoOficial = res;
      t.estado = 'cerrado';
      t.exitedAt = t.exitedAt || ahoraIso;
      t.closedAt = ahoraIso;
      actualizados += 1;
    } else if (t.estado === 'cerrado' && t.holdPnlUsd == null) {
      t.holdPnlUsd = calcularHoldPnl({ lado: t.lado, costoTotal: t.costoTotal, resultadoOficial: res });
      t.resultadoOficial = res;
      actualizados += 1;
    }
  }
  if (est.liquidacionProgramada) delete est.liquidacionProgramada[ticker];
  if (actualizados > 0) await persistir(userId);
  return { ok: true, actualizados };
}

// Pide el resultado oficial a los 15 s del cierre (la API tarda en
// publicar result) y reintenta a los 45 s si aún no está, como el
// auditor. Solo GET; con unref para no mantener vivo el proceso.
function programarLiquidacion(userId, ticker, deps = {}) {
  const est = traders.get(userId);
  if (!est || !ticker) return;
  est.liquidacionProgramada = est.liquidacionProgramada || {};
  if (est.liquidacionProgramada[ticker]) return;
  est.liquidacionProgramada[ticker] = true;
  const cotizar = deps.quote || obtenerQuoteContrato;
  const intentar = async () => {
    let oficial = null;
    try { oficial = await cotizar(ticker); } catch { oficial = null; }
    return finalizarLiquidacion(userId, { ticker, oficial });
  };
  const t = setTimeout(async () => {
    const r1 = await intentar();
    if (!r1.ok) {
      const est2 = traders.get(userId);
      const pendientes = !!est2 && est2.trades.some((x) => x && x.ticker === ticker
        && (x.estado === 'pendiente-liquidacion' || x.holdPnlUsd == null));
      if (pendientes) {
        const t2 = setTimeout(async () => { await intentar(); }, 30000);
        if (t2.unref) t2.unref();
      }
    }
  }, 15000);
  if (t.unref) t.unref();
}

function getSnapshot(userId, ahoraMs = Date.now()) {
  const est = traders.get(userId);
  if (!est) {
    return {
      enabled: false, startedAt: null, contrato: null, posicionAbierta: null,
      ultimaEntrada: null,
      evaluaciones: [],
      trades: [], stats: calcularStats([]), ultimoError: null,
      entradasHoy: 0, dia: dayKey(new Date(ahoraMs)),
      quote: null, saltoActual: null, pActual: null, sigmaActual: null, twapActual: null,
    };
  }
  return {
    enabled: est.enabled,
    startedAt: est.startedAt,
    contrato: est.contrato,
    posicionAbierta: est.posicionAbierta ? { ...est.posicionAbierta } : null,
    ultimaEntrada: est.ultimaEntrada ? { ...est.ultimaEntrada } : null,
    // v16.10 — Anillo de evaluaciones de entrada (newest first,
    // máx. 20, en memoria). Copia para no exponer el anillo interno.
    evaluaciones: (Array.isArray(est.evaluaciones) ? est.evaluaciones : []).slice(0, MAX_EVALUACIONES).map((e) => ({ ...e })),
    trades: est.trades.slice(0, MAX_TRADES_SNAPSHOT),
    stats: calcularStats(est.trades, est.entradasHoy),
    ultimoError: est.ultimoError,
    entradasHoy: est.entradasHoy,
    dia: est.day,
    quote: est.quoteActual ? {
      yesAskDollars: est.quoteActual.yesAskDollars,
      yesBidDollars: est.quoteActual.yesBidDollars,
      noAskDollars: est.quoteActual.noAskDollars,
      fetchedAt: est.quoteActual.fetchedAt,
    } : null,
    saltoActual: est.saltoActual,
    pActual: est.pActual,
    sigmaActual: est.sigmaActual,
    twapActual: est.twapActual,
  };
}

function startTrader(userId, persistido = null) {
  let est = traders.get(userId);
  if (!est) { est = crearEstadoTrader(); traders.set(userId, est); }
  resetDiaSiCambio(est);
  est.enabled = true;
  est.startedAt = new Date().toISOString();
  est.contrato = null;
  est.muestras = new Map();
  est.ultimoUpdatedAt = null;
  est.ultimoBrti = null;
  est.ultimoError = null;
  est.ultimoDescubrimientoMs = 0;
  est.twapActual = null;
  est.saltoActual = null;
  est.pActual = null;
  est.sigmaActual = null;
  est.quoteActual = null;
  est.quoteEnVuelo = false;
  est.ultimaEntrada = null;
  // v17: sinReentrada eliminado (re-entrada permitida).
  // v16.10 — El anillo de evaluaciones se limpia al arrancar: es
  // diagnóstico de la ventana en curso, no historial.
  est.evaluaciones = [];
  // El anillo de volatilidad se conserva entre arranques (es del
  // subyacente, no de la ventana).
  if (persistido && typeof persistido === 'object') {
    if (Array.isArray(persistido.trades)) est.trades = persistido.trades.filter((t) => t && t.ticker).slice(0, MAX_TRADES);
    else est.trades = [];
    if (typeof persistido.day === 'string' && persistido.day === est.day && Number.isFinite(persistido.entradasHoy)) {
      est.entradasHoy = persistido.entradasHoy;
    }
    // La posición abierta se restaura: si el contrato que se descubra
    // es el mismo ticker, se reanuda; si es otro, la ventana ya cerró
    // y pasa a pendiente de liquidación (ver tickTrader).
    est.posicionAbierta = (persistido.posicionAbierta && persistido.posicionAbierta.ticker)
      ? { ...persistido.posicionAbierta } : null;
  } else {
    est.trades = [];
    est.posicionAbierta = null;
  }
  ensureTicker();
  return getSnapshot(userId);
}

async function stopTrader(userId) {
  const est = traders.get(userId);
  if (!est) return getSnapshot(userId);
  est.enabled = false;
  est.contrato = null;
  // La posición abierta, si la hay, queda persistida tal cual: al
  // rearrancar se reanuda o pasa a pendiente de liquidación. No se
  // inventa un cierre al parar.
  await persistir(userId);
  return getSnapshot(userId);
}

// Un solo setInterval global de 1 s que recorre los usuarios
// habilitados. Perezoso (arranca al primer start) y con unref para
// no mantener vivo el proceso en pruebas. Se apaga solo cuando ya no
// queda nadie activo. Mismo patrón que paperAuditor.js.
function ensureTicker() {
  if (tickerInterval) return;
  tickerInterval = setInterval(() => {
    let alguno = false;
    for (const [userId, est] of traders) {
      if (!est.enabled) continue;
      alguno = true;
      if (!est.tickEnCurso) {
        est.tickEnCurso = true;
        tickTrader(userId).catch(() => {}).finally(() => { est.tickEnCurso = false; });
      }
    }
    if (!alguno && tickerInterval) { clearInterval(tickerInterval); tickerInterval = null; }
  }, 1000);
  if (tickerInterval.unref) tickerInterval.unref();
}

// Un tick del trader (1 s). `deps` permite inyectar stubs en pruebas:
// { brtiState, descubrir, quote }. Por defecto usa el WS en memoria
// y la API pública de Kalshi (solo GET).
async function tickTrader(userId, ahoraMs = Date.now(), deps = {}) {
  const est = traders.get(userId);
  if (!est || !est.enabled) return getSnapshot(userId, ahoraMs);
  resetDiaSiCambio(est, dayKey(new Date(ahoraMs)));
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
      // Posición restaurada de otra sesión con otro ticker: su
      // ventana ya cerró; pasa a pendiente de liquidación.
      if (est.posicionAbierta && est.posicionAbierta.ticker !== nuevo.ticker) {
        const tickerViejo = est.posicionAbierta.ticker;
        convertirPosicionAPendiente(est);
        programarLiquidacion(userId, tickerViejo, deps);
        await persistir(userId);
      }
      est.contrato = nuevo;
      est.ultimaEntrada = null; // v16.9: contrato nuevo, entrada vieja fuera
      est.evaluaciones = []; // v16.10: ventana nueva, diagnóstico nuevo
      est.muestras = new Map();
      est.ultimoUpdatedAt = null;
      est.ultimoBrti = null;
      est.twapActual = null;
      est.saltoActual = null;
      est.pActual = null;
      est.sigmaActual = null;
      est.quoteActual = null;
      est.quoteEnVuelo = false;
      est.ultimoError = null;
      return getSnapshot(userId, ahoraMs);
    }

    const closeEpochSec = Math.floor(est.contrato.closeMs / 1000);
    const R = closeEpochSec - segActualEpoch;

    // 2. Ventana en curso (R ≥ 1, v16.10): se evalúa entrada y
    //    salida a CUALQUIER R, no solo en el último minuto. Antes
    //    del último minuto n=0 y R'=60 (el modelo ya lo contempla)
    //    y el TWAP bloqueado es null hasta que haya muestras del
    //    minuto final. Leer el BRTI cada segundo mantiene vivo el
    //    WS (antes lo hacía el heartbeat de 30 s) y el anillo σ se
    //    alimenta igual con cada tick fresco.
    if (R >= 1) {
      const ahoraIso = new Date(ahoraMs).toISOString();
      // Sin posición abierta, cada intento bloqueado de evaluar la
      // entrada deja constancia en el anillo (v16.10). Con posición
      // abierta no se registra nada de entrada.
      const registrarBloqueo = (motivo) => {
        if (!est.posicionAbierta) {
          registrarEvaluacion(est, { at: ahoraIso, R, lado: null, p: null, ev: null, ask: null, motivo });
        }
      };
      const estadoBrti = await Promise.resolve(leerBrti(userId));
      if (!estadoBrti || estadoBrti.value == null) {
        est.ultimoError = 'Sin tick BRTI (WS sin dato). El trader espera al próximo tick.';
        registrarBloqueo('sin_tick_brti');
        return getSnapshot(userId, ahoraMs);
      }
      const edadMs = estadoBrti.updatedAt ? ahoraMs - new Date(estadoBrti.updatedAt).getTime() : null;
      if (edadMs == null || edadMs > 15000) {
        est.ultimoError = 'Tick BRTI desactualizado (>15 s). El trader espera al próximo tick.';
        registrarBloqueo('tick_desactualizado');
        return getSnapshot(userId, ahoraMs);
      }
      est.ultimoBrti = { value: estadoBrti.value, avg60s: estadoBrti.avg60s, avg15mFinal: estadoBrti.avg15mFinal, updatedAt: estadoBrti.updatedAt };
      est.ultimoError = null;

      // Solo suma la muestra (y el anillo) si el tick es fresco.
      // Muestras del minuto final SOLO con R en [1,60]; el anillo
      // de volatilidad se alimenta a cualquier R.
      if (estadoBrti.updatedAt !== est.ultimoUpdatedAt) {
        est.ultimoUpdatedAt = estadoBrti.updatedAt;
        if (R <= 60) est.muestras.set(segActualEpoch, estadoBrti.value);
        empujarAnillo(est, estadoBrti.value);
      }

      // Cotización en paralelo, sin bloquear el muestreo: a
      // cualquier R (v16.10; antes solo en el minuto final),
      // con throttle ≥5 s y una sola petición en vuelo. Si falla o
      // tarda, el muestreo sigue igual y la entrada/salida esperan
      // a la próxima quote fresca.
      if (!est.quoteEnVuelo && (!est.quoteActual || ahoraMs - (est.quoteActual.fetchedAt || 0) >= QUOTE_THROTTLE_MS)) {
        est.quoteEnVuelo = true;
        const tickerPedido = est.contrato.ticker;
        const solicitadoMs = ahoraMs;
        Promise.resolve()
          .then(() => cotizar(tickerPedido))
          .then((q) => {
            est.quoteEnVuelo = false;
            if (!q || q.ticker !== tickerPedido) return;
            if (!est.contrato || est.contrato.ticker !== tickerPedido) return;
            est.quoteActual = { yesAskDollars: q.yesAskDollars, yesBidDollars: q.yesBidDollars, noAskDollars: q.noAskDollars, ticker: q.ticker, fetchedAt: solicitadoMs };
          })
          .catch(() => { est.quoteEnVuelo = false; });
      }
      const quoteFresca = est.quoteActual && est.quoteActual.ticker === est.contrato.ticker
        && (ahoraMs - (est.quoteActual.fetchedAt || 0)) <= QUOTE_FRESCA_MS
        ? est.quoteActual : null;

      const { n, suma, twap } = calcularTwapBloqueado(est.muestras);
      const { Rprima, salto } = calcularSaltoRequerido({
        targetPrice: est.contrato.targetPrice, n, suma, segundosRestantes: R, brtiValue: estadoBrti.value,
      });
      const sigma = calcularSigmaAnillo(est.anillo);
      const { pYes, pNo } = calcularProbabilidad({
        salto, segundosRestantesEfectivos: Rprima, sigma, twapBloqueado: twap, targetPrice: est.contrato.targetPrice,
      });
      est.twapActual = twap == null ? null : +twap.toFixed(2);
      est.saltoActual = salto == null ? null : +salto.toFixed(2);
      est.sigmaActual = sigma == null ? null : +sigma.toFixed(2);
      est.pActual = (pYes == null || pNo == null) ? null : { pYes: +pYes.toFixed(4), pNo: +pNo.toFixed(4) };

      // 2a. SALIDA primero: con posición abierta y quote fresca, a
      // cualquier R. Reglas vigentes (b) ganancia, (c) stop-loss y
      // (d) fin de ventana; sin lock roto (v16.10).
      if (est.posicionAbierta && quoteFresca) {
        const precio = precioSalida({ lado: est.posicionAbierta.lado, quote: quoteFresca });
        const valorNeto = valorNetoSalida(precio);
        const dec = evaluarSalida({
          lado: est.posicionAbierta.lado, segundosRestantes: R,
          valorNeto, costoTotal: est.posicionAbierta.costoTotal,
        });
        if (dec.accion === 'vender') {
          cerrarPosicion(est, { motivo: dec.motivo, precioSalida: precio, ahoraMs });
          await persistir(userId);
        }
      }

      // 2b. ENTRADA (sin posición): cada resultado —entrar o no—
      // queda en el anillo `evaluaciones` (v16.10). v17: SIN
      // tope de entradas/día y SIN bloqueo de re-entrada: tras
      // una salida, el tick siguiente evalúa la entrada con
      // normalidad. Precedencia de los bloqueos:
      // sin_quote_fresca → sin_sigma → sin_tiempo →
      // evaluarEntrada (sin_ev_valido, ev_bajo, max_notional).
      if (!est.posicionAbierta) {
        if (!quoteFresca) {
          registrarBloqueo('sin_quote_fresca');
        } else if (sigma == null) {
          registrarBloqueo('sin_sigma');
        } else if (Rprima < 1) {
          registrarBloqueo('sin_tiempo');
        } else {
          const ent = evaluarEntrada({ pYes, pNo, quote: quoteFresca });
          if (ent.entrar) {
            abrirPosicion(est, {
              ticker: est.contrato.ticker, targetPrice: est.contrato.targetPrice,
              lado: ent.lado, ask: ent.ask, fee: ent.fee, p: ent.p, ev: ent.ev,
              R, brtiValue: estadoBrti.value, ahoraMs,
              quoteFetchedAt: quoteFresca ? quoteFresca.fetchedAt : null,
            });
            registrarEvaluacion(est, { at: ahoraIso, R, lado: ent.lado, p: ent.p, ev: ent.ev, ask: ent.ask, motivo: 'entrada' });
            await persistir(userId);
          } else {
            registrarEvaluacion(est, { at: ahoraIso, R, lado: ent.lado, p: ent.p, ev: ent.ev, ask: ent.ask, motivo: ent.motivo });
          }
        }
      }
      return getSnapshot(userId, ahoraMs);
    }

    // 3. Cierre (R <= 0): la ventana terminó. Con posición abierta
    //    pasa a pendiente de liquidación; los holdPnl pendientes de
    //    trades ya cerrados por salida se resuelven con el mismo
    //    resultado oficial (se pide a los 15 s, reintento a los 45 s).
    if (R <= 0) {
      const tickerCerrado = est.contrato.ticker;
      if (est.posicionAbierta) convertirPosicionAPendiente(est);
      const hayPendientes = est.trades.some((t) => t && t.ticker === tickerCerrado
        && (t.estado === 'pendiente-liquidacion' || t.holdPnlUsd == null));
      est.contrato = null;
      est.ultimaEntrada = null; // v16.9: ventana cerrada, entrada fuera
      est.muestras = new Map();
      est.quoteActual = null;
      est.quoteEnVuelo = false;
      est.twapActual = null;
      est.saltoActual = null;
      est.pActual = null;
      est.sigmaActual = null;
      est.ultimoDescubrimientoMs = 0;
      if (hayPendientes) programarLiquidacion(userId, tickerCerrado, deps);
      await persistir(userId);
      return getSnapshot(userId, ahoraMs);
    }
  } catch (e) {
    est.ultimoError = e.message || 'Error en el tick del trader.';
    return getSnapshot(userId, ahoraMs);
  }
  return getSnapshot(userId, ahoraMs);
}

module.exports = {
  QTY_POR_ORDEN, MAX_NOTIONAL_USD, MIN_EV_USD,
  MIN_MUESTRAS_SIGMA, SIGMA_MIN_USD, ANILLO_MAX,
  GANANCIA_MIN_USD, STOP_FRACCION_COSTO, R_FIN_VENTANA,
  QUOTE_FRESCA_MS, QUOTE_THROTTLE_MS, MAX_TRADES, MAX_TRADES_SNAPSHOT,
  normalCdf, erf, calcularSaltoRequerido, calcularProbabilidad,
  calcularSigmaAnillo, calcularEV, precioSalida, valorNetoSalida,
  evaluarEntrada, evaluarSalida, calcularHoldPnl, calcularStats, dayKey,
  setPersistencia, getSnapshot, startTrader, stopTrader, tickTrader,
  finalizarLiquidacion, programarLiquidacion, crearEstadoTrader,
  MAX_EVALUACIONES,
  // Solo para pruebas: inspeccionar el estado en memoria.
  _traders: traders,
};
