// traderEval.js — v16.9: EVALUACIÓN PURA DEL TRADER (sin red, sin estado).
//
// Extraído de paperTrader.js (v16.6) sin cambiar una sola fórmula:
// las constantes de límites y las funciones puras del modelo de
// probabilidad continuo (salto requerido, p por normal acumulada,
// sigma del anillo, EV por contrato, decisión de entrada/salida,
// holdPnl, stats y dayKey) viven aquí para que paperTrader.js y
// liveTrader.js las compartan sin duplicarlas.
//
// SOLO requiere de paperAuditor lo que el modelo necesita:
// calcularComisionPorContrato (fee taker 0.07×a×(1−a)),
// MIN_NET_EDGE_DOLLARS ($0.015, umbral de EV) y MIN_REQ_MOVE_USD
// ($95, salto que rompe el lock). No importa liveTrader, no lee
// LIVE_TRADING_ENABLED, no toca la red ni persiste nada.
const {
  calcularComisionPorContrato,
  MIN_NET_EDGE_DOLLARS,
  MIN_REQ_MOVE_USD,
} = require('./paperAuditor');

// --- Límites (los del experimento live acotado, v16.4) ---
const QTY_POR_ORDEN = 1;
const MAX_ENTRADAS_DIA = 5;
const MAX_NOTIONAL_USD = 5;
const MIN_EV_USD = MIN_NET_EDGE_DOLLARS; // $0.015 por orden
const MIN_MUESTRAS_SIGMA = 10;
const SIGMA_MIN_USD = 1;
const ANILLO_MAX = 120;
const GANANCIA_MIN_USD = 0.02;
const STOP_FRACCION_COSTO = 0.5;
const R_FIN_VENTANA = 3;
const QUOTE_FRESCA_MS = 5000;
const QUOTE_THROTTLE_MS = 5000;
const MAX_TRADES = 100;
const MAX_TRADES_SNAPSHOT = 20;

// --- Funciones puras (testeables sin servidor ni Kalshi) ---

// erf(x) por Abramowitz-Stegun 7.1.26 (|error| < 1.5e-7).
function erf(x) {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}

// Normal acumulada Φ. Φ(0)=0.5, Φ(1)=0.8413, Φ(1.96)=0.9750.
function normalCdf(x) {
  if (!Number.isFinite(x)) return NaN;
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// Salto requerido para empatar el target con el promedio bloqueado.
// R' = clamp(R−1, 0, 60); si R>60, n=0 y R'=60. Si R'<=0 no hay
// promedio restante que calcular: reqAvg/salto son null y la
// probabilidad la decide el TWAP (ver calcularProbabilidad).
function calcularSaltoRequerido({ targetPrice, n, suma, segundosRestantes, brtiValue } = {}) {
  const R = Number(segundosRestantes);
  const Rprima = Math.min(Math.max(R - 1, 0), 60);
  const nEf = R > 60 ? 0 : (Number(n) || 0);
  const sumaEf = R > 60 ? 0 : (Number(suma) || 0);
  if (Rprima <= 0) return { Rprima, reqAvg: null, salto: null };
  const reqAvg = (Number(targetPrice) * (nEf + Rprima) - sumaEf) / Rprima;
  return { Rprima, reqAvg, salto: reqAvg - Number(brtiValue) };
}

// p_yes = Φ(−salto × √R' / σ); p_no = 1 − p_yes. Si R'<=0, lo decide
// el TWAP bloqueado vs target (1 o 0). Sin sigma válido no hay p.
function calcularProbabilidad({ salto, segundosRestantesEfectivos, sigma, twapBloqueado, targetPrice } = {}) {
  const Rp = Number(segundosRestantesEfectivos);
  if (!Number.isFinite(Rp) || Rp <= 0) {
    if (twapBloqueado == null || targetPrice == null || !Number.isFinite(twapBloqueado) || !Number.isFinite(targetPrice)) {
      return { pYes: null, pNo: null };
    }
    const pYes = twapBloqueado >= targetPrice ? 1 : 0;
    return { pYes, pNo: 1 - pYes };
  }
  const s = Number(sigma);
  if (!Number.isFinite(s) || s <= 0) return { pYes: null, pNo: null };
  const pYes = normalCdf(-Number(salto) * Math.sqrt(Rp) / s);
  return { pYes, pNo: 1 - pYes };
}

// Sigma: desviación estándar muestral del anillo reciente. null si
// hay menos de 10 muestras (no se entra sin sigma). Suelo $1.
function calcularSigmaAnillo(anillo) {
  const vals = (Array.isArray(anillo) ? anillo : []).filter((v) => Number.isFinite(v));
  if (vals.length < MIN_MUESTRAS_SIGMA) return null;
  const media = vals.reduce((a, b) => a + b, 0) / vals.length;
  const varianza = vals.reduce((s, v) => s + (v - media) * (v - media), 0) / (vals.length - 1);
  return Math.max(Math.sqrt(varianza), SIGMA_MIN_USD);
}

// EV por contrato al comprar un lado al ask a con probabilidad p de
// ganar: p×(1 − a − fee) − (1−p)×(a + fee). null si el ask no vale.
function calcularEV({ p, askDollars } = {}) {
  const a = Number(askDollars);
  const prob = Number(p);
  if (!Number.isFinite(a) || a <= 0 || a >= 1) return null;
  if (!Number.isFinite(prob) || prob < 0 || prob > 1) return null;
  const fee = calcularComisionPorContrato(a);
  return prob * (1 - a - fee) - (1 - prob) * (a + fee);
}

// Precio de salida en papel. SÍ → yesBid real. NO → 1 − yesAsk
// (identidad de libro único: la quote no trae noBidDollars; es la
// misma identidad que el código ya usa para noAsk = 1 − yesBid).
// null si falta el dato necesario: sin precio no se sale.
function precioSalida({ lado, quote } = {}) {
  if (!quote) return null;
  // OJO: Number(null) es 0, así que el ausente se chequea ANTES de
  // convertir: un bid/ask ausente es "sin precio", no precio $0.
  if (lado === 'yes') {
    if (quote.yesBidDollars == null) return null;
    const b = Number(quote.yesBidDollars);
    return Number.isFinite(b) && b >= 0 && b <= 1 ? b : null;
  }
  if (lado === 'no') {
    if (quote.yesAskDollars == null) return null;
    const a = Number(quote.yesAskDollars);
    return Number.isFinite(a) && a >= 0 && a <= 1 ? +(1 - a).toFixed(4) : null;
  }
  return null;
}

// Valor neto de salida: precio − fee(precio). null sin precio.
function valorNetoSalida(precio) {
  const p = Number(precio);
  if (precio == null || !Number.isFinite(p) || p < 0 || p > 1) return null;
  return +(p - calcularComisionPorContrato(p)).toFixed(4);
}

// Decisión pura de entrada. Devuelve { entrar, motivo, lado, ask,
// fee, ev, p }. `quoteFresca` la calcula el llamador (≤5 s).
function evaluarEntrada({ pYes, pNo, quote, quoteFresca = true, entradasHoy = 0, maxEntradasDia = MAX_ENTRADAS_DIA, minEvUsd = MIN_EV_USD, qty = QTY_POR_ORDEN, maxNotionalUsd = MAX_NOTIONAL_USD } = {}) {
  const base = { entrar: false, motivo: null, lado: null, ask: null, fee: null, ev: null, p: null };
  if (!quoteFresca || !quote) return { ...base, motivo: 'sin_quote_fresca' };
  if (entradasHoy >= maxEntradasDia) return { ...base, motivo: 'max_entradas_dia' };
  const candidatos = [
    { lado: 'yes', p: pYes, ask: quote.yesAskDollars },
    { lado: 'no', p: pNo, ask: quote.noAskDollars },
  ];
  let mejor = null;
  for (const c of candidatos) {
    if (c.p == null || !Number.isFinite(Number(c.ask))) continue;
    const ev = calcularEV({ p: c.p, askDollars: c.ask });
    if (ev == null) continue;
    if (!mejor || ev > mejor.ev) {
      mejor = { lado: c.lado, p: c.p, ask: Number(c.ask), ev, fee: calcularComisionPorContrato(c.ask) };
    }
  }
  if (!mejor) return { ...base, motivo: 'sin_ev_valido' };
  if (mejor.ev * qty <= minEvUsd) return { ...base, motivo: 'ev_bajo', lado: mejor.lado, ask: mejor.ask, fee: mejor.fee, ev: mejor.ev, p: mejor.p };
  if (qty * mejor.ask > maxNotionalUsd) return { ...base, motivo: 'max_notional', lado: mejor.lado, ask: mejor.ask, fee: mejor.fee, ev: mejor.ev, p: mejor.p };
  return { ...base, entrar: true, motivo: null, lado: mejor.lado, ask: mejor.ask, fee: mejor.fee, ev: mejor.ev, p: mejor.p };
}

// Decisión pura de salida. Orden de las reglas: (a) lock roto,
// (b) ganancia, (c) stop-loss, (d) fin de ventana. Sin valor neto
// (sin precio de salida) se mantiene siempre.
function evaluarSalida({ lado, salto, twapBloqueado, targetPrice, segundosRestantes, valorNeto, costoTotal } = {}) {
  const mantener = { accion: 'mantener', motivo: null };
  if (valorNeto == null || !Number.isFinite(valorNeto)) return mantener;
  const costo = Number(costoTotal);
  if (!Number.isFinite(costo) || costo <= 0) return mantener;
  // (a) lock roto. Con R'=0 no hay salto: lo decide el TWAP vs target.
  let lockRoto;
  if (salto != null && Number.isFinite(salto)) {
    lockRoto = lado === 'yes' ? salto > -MIN_REQ_MOVE_USD : salto < MIN_REQ_MOVE_USD;
  } else {
    lockRoto = lado === 'yes' ? twapBloqueado < targetPrice : twapBloqueado >= targetPrice;
  }
  if (lockRoto) return { accion: 'vender', motivo: 'lock_roto' };
  // (b) ganancia: neto ≥ costo + $0.02 por contrato.
  if (valorNeto >= costo + GANANCIA_MIN_USD) return { accion: 'vender', motivo: 'ganancia' };
  // (c) stop-loss: neto ≤ 50% del costo.
  if (valorNeto <= costo * STOP_FRACCION_COSTO) return { accion: 'vender', motivo: 'stop_loss' };
  // (d) fin de ventana (R ≤ 3): si va perdiendo, vende por lo que
  // queda en vez de esperar al $0; si va ganando, se mantiene hasta
  // liquidación (la ganancia ya se vendió en (b)).
  if (Number(segundosRestantes) <= R_FIN_VENTANA && valorNeto < costo) return { accion: 'vender', motivo: 'fin_ventana' };
  return mantener;
}

// P&L hipotético de haber mantenido la posición hasta liquidación:
// gana (+1 − costo) si el lado coincide con el resultado oficial,
// pierde (−costo) si no. null sin resultado oficial.
function calcularHoldPnl({ lado, costoTotal, resultadoOficial } = {}) {
  const res = String(resultadoOficial || '').toLowerCase();
  if (res !== 'yes' && res !== 'no') return null;
  const costo = Number(costoTotal);
  if (!Number.isFinite(costo)) return null;
  return lado === res ? +(1 - costo).toFixed(4) : +(-costo).toFixed(4);
}

// Stats sobre los trades guardados (máx. MAX_TRADES). pnlTotalUsd
// suma el P&L realizado de los cerrados; pnlConSalidasUsd suma solo
// los cerrados POR SALIDA (reglas a-d) y pnlManteniendoUsd suma el
// holdPnl conocido de esos mismos trades (parcial si hay
// holdPendientes > 0: aún no llegó la liquidación de su ventana).
function calcularStats(trades, entradasHoy = 0) {
  const list = Array.isArray(trades) ? trades : [];
  const cerrados = list.filter((t) => t && t.estado === 'cerrado');
  const ganados = cerrados.filter((t) => typeof t.pnlUsd === 'number' && t.pnlUsd > 0).length;
  const perdidos = cerrados.filter((t) => typeof t.pnlUsd === 'number' && t.pnlUsd < 0).length;
  const pnlTotalUsd = +cerrados.reduce((s, t) => s + (typeof t.pnlUsd === 'number' ? t.pnlUsd : 0), 0).toFixed(4);
  const porSalida = cerrados.filter((t) => t.motivoSalida && t.motivoSalida !== 'liquidacion');
  const pnlConSalidasUsd = +porSalida.reduce((s, t) => s + (typeof t.pnlUsd === 'number' ? t.pnlUsd : 0), 0).toFixed(4);
  const holdConocidos = porSalida.filter((t) => typeof t.holdPnlUsd === 'number');
  const pnlManteniendoUsd = +holdConocidos.reduce((s, t) => s + t.holdPnlUsd, 0).toFixed(4);
  return {
    trades: cerrados.length,
    ganados,
    perdidos,
    pnlTotalUsd,
    pnlConSalidasUsd,
    pnlManteniendoUsd,
    holdPendientes: porSalida.length - holdConocidos.length,
    pendientesLiquidacion: list.filter((t) => t && t.estado === 'pendiente-liquidacion').length,
    entradasHoy,
  };
}

// Día UTC en formato YYYY-MM-DD (para reiniciar el contador diario).
function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

module.exports = {
  QTY_POR_ORDEN, MAX_ENTRADAS_DIA, MAX_NOTIONAL_USD, MIN_EV_USD,
  MIN_MUESTRAS_SIGMA, SIGMA_MIN_USD, ANILLO_MAX,
  GANANCIA_MIN_USD, STOP_FRACCION_COSTO, R_FIN_VENTANA,
  QUOTE_FRESCA_MS, QUOTE_THROTTLE_MS, MAX_TRADES, MAX_TRADES_SNAPSHOT,
  normalCdf, erf, calcularSaltoRequerido, calcularProbabilidad,
  calcularSigmaAnillo, calcularEV, precioSalida, valorNetoSalida,
  evaluarEntrada, evaluarSalida, calcularHoldPnl, calcularStats, dayKey,
};
