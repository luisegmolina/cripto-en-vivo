// Veredicto de trading — PRUEBA EDUCATIVA, no es recomendación de
// inversión ni garantía de ganancias. Resume indicadores clásicos
// (RSI, MACD, EMA, Bollinger, patrones) en un veredicto claro:
// COMPRAR / VENDER / ESPERAR. El pasado no predice el futuro.

import { analyze } from './analysis.js';

export const VERDICT_TFS = ['1m', '5m', '15m', '1h'];
const TF_WEIGHT = { '1m': 1, '5m': 2, '15m': 3, '1h': 4 };

// Veredicto a partir de una puntuación -100..+100 (misma escala que analyze()).
export function verdictForScore(score) {
  if (score >= 25) return { key: 'buy', label: 'COMPRAR', short: 'Comprar', icon: '▲' };
  if (score <= -25) return { key: 'sell', label: 'VENDER', short: 'Vender', icon: '▼' };
  return { key: 'wait', label: 'ESPERAR', short: 'Esperar', icon: '●' };
}

export function strengthForScore(score) {
  const a = Math.abs(score);
  if (a >= 60) return 'Muy fuerte';
  if (a >= 40) return 'Fuerte';
  if (a >= 25) return 'Moderada';
  return 'Débil';
}

// Confluencia entre temporalidades: media ponderada (1h pesa más que 1m).
// Devuelve el veredicto final, la puntuación ponderada, el acuerdo y si
// hay conflicto (hay señales claras de compra Y de venta a la vez).
export function multiTfVerdict(perTf) {
  const rows = VERDICT_TFS.map((tf) => {
    const a = perTf[tf];
    if (!a) return { tf, score: null, label: 'Sin datos', key: 'nodata', verdict: null };
    const v = verdictForScore(a.score);
    return { tf, score: a.score, label: v.label, key: v.key, verdict: v, analysis: a };
  });
  const clear = rows.filter((r) => r.key === 'buy' || r.key === 'sell');
  const buys = clear.filter((r) => r.key === 'buy').length;
  const sells = clear.filter((r) => r.key === 'sell').length;
  const conflict = buys > 0 && sells > 0;
  let wSum = 0, wTot = 0;
  for (const r of rows) {
    if (r.score == null) continue;
    wSum += r.score * TF_WEIGHT[r.tf];
    wTot += TF_WEIGHT[r.tf];
  }
  const score = wTot ? Math.round(wSum / wTot) : 0;
  const verdict = conflict ? verdictForScore(0) : verdictForScore(score);
  // Confianza = índice de confluencia (0-95), NO una probabilidad de
  // acierto: combina la fuerza de la puntuación y cuántos timeframes
  // coinciden. Un 90% no significa "90% de probabilidad de ganar".
  const agreeing = verdict.key === 'buy' ? buys : verdict.key === 'sell' ? sells : 0;
  const agreement = clear.length ? agreeing / clear.length : 0;
  const confidence = conflict
    ? Math.max(5, Math.round(35 - Math.abs(score) * 0.2))
    : Math.min(95, Math.round(40 + Math.abs(score) * 0.35 + agreement * 25));
  return { rows, score, verdict, conflict, buys, sells, clear: clear.length, confidence, agreement };
}

// Razones en lenguaje simple, ordenadas por impacto. Cada una lleva
// dirección (up/down/neutral) para pintarla verde/roja/gris.
export function reasonsFor(analysis) {
  const out = [];
  if (!analysis || analysis.rsi == null) return out;
  const r = analysis.rsi;
  if (r < 30) out.push({ dir: 'up', icon: '▲', text: `RSI ${r.toFixed(0)}: sobreventa, el precio cayó mucho y rápido`, impact: 15 });
  else if (r > 70) out.push({ dir: 'down', icon: '▼', text: `RSI ${r.toFixed(0)}: sobrecompra, el precio subió mucho y rápido`, impact: 15 });
  else if (r < 40) out.push({ dir: 'up', icon: '▲', text: `RSI ${r.toFixed(0)}: cerca de sobreventa, presión vendedora perdiendo fuerza`, impact: 8 });
  else if (r > 60) out.push({ dir: 'down', icon: '▼', text: `RSI ${r.toFixed(0)}: cerca de sobrecompra, presión compradora perdiendo fuerza`, impact: 8 });
  else out.push({ dir: 'neutral', icon: '●', text: `RSI ${r.toFixed(0)}: zona neutra, sin exceso en ningún lado`, impact: 2 });
  if (analysis.macd) {
    const h = analysis.macd.histogram;
    out.push(h > 0
      ? { dir: 'up', icon: '▲', text: 'MACD cruzó al alza: el impulso de corto plazo supera al de largo plazo', impact: 10 }
      : { dir: 'down', icon: '▼', text: 'MACD cruzó a la baja: el impulso de corto plazo está por debajo del de largo plazo', impact: 10 });
  }
  if (analysis.ema20 != null && analysis.ema50 != null) {
    out.push(analysis.ema20 > analysis.ema50
      ? { dir: 'up', icon: '▲', text: 'Precio por encima de EMA 50: la tendencia de fondo es alcista', impact: 20 }
      : { dir: 'down', icon: '▼', text: 'Precio por debajo de EMA 50: la tendencia de fondo es bajista', impact: 20 });
  }
  if (analysis.bollinger) {
    const b = analysis.bollinger.pctB;
    if (b < 0.2) out.push({ dir: 'up', icon: '▲', text: 'Precio pegado a la banda inferior de Bollinger: posible rebote', impact: 5 });
    else if (b > 0.8) out.push({ dir: 'down', icon: '▼', text: 'Precio pegado a la banda superior de Bollinger: posible freno', impact: 5 });
  }
  for (const p of analysis.patterns || []) {
    out.push({
      dir: p.dir, icon: p.dir === 'up' ? '▲' : p.dir === 'down' ? '▼' : '●',
      text: `${p.name}: ${p.dir === 'up' ? 'patrón alcista' : p.dir === 'down' ? 'patrón bajista' : 'indecisión'} en la última vela`,
      impact: 12,
    });
  }
  return out.sort((a, b) => b.impact - a.impact).slice(0, 4);
}

// ATR aproximado: media del rango real de las últimas 14 velas.
// Sirve para poner el stop y el objetivo a una distancia que respete
// lo que el precio se mueve de verdad, no un % inventado.
export function atr(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const tail = candles.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < tail.length; i++) {
    const c = tail[i], p = tail[i - 1];
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / period;
}

// Plan de operación EDUCATIVO y sugerido: entrada = precio actual,
// stop a 1 ATR en contra, objetivo a 2 ATR a favor (ratio 1:2).
// Si el veredicto es ESPERAR, el plan se muestra como "sin entrada"
// con los niveles que habría que romper para que cambie la señal.
export function tradePlan(price, candles, verdictKey) {
  if (!price || price <= 0) return null;
  const a = atr(candles);
  if (!a || a <= 0) return null;
  const slDist = a, tpDist = 2 * a;
  if (verdictKey === 'buy') {
    return { entry: price, stopLoss: price - slDist, takeProfit: price + tpDist, rr: 2, dir: 'buy', atr: a, note: 'Compra sugerida (educativo): stop 1 ATR abajo, objetivo 2 ATR arriba.' };
  }
  if (verdictKey === 'sell') {
    return { entry: price, stopLoss: price + slDist, takeProfit: price - tpDist, rr: 2, dir: 'sell', atr: a, note: 'Venta sugerida (educativo): stop 1 ATR arriba, objetivo 2 ATR abajo.' };
  }
  // ESPERAR: NO hay entrada, ni stop, ni objetivo. Solo los niveles de
  // activación (romper uno con señal clara activaría el plan). Mostrar
  // un stop/take profit con veredicto ESPERAR es confuso y engañoso.
  return {
    entry: null, stopLoss: null, takeProfit: null,
    activationUp: price + slDist, activationDown: price - slDist,
    rr: 2, dir: 'wait', atr: a,
    note: 'Sin entrada por ahora: el plan se activa si el precio rompe un nivel con señal clara.',
  };
}

// Historial de señales derivado de las velas: en cada ventana se
// calcula la señal y se mira si la vela siguiente fue en la dirección
// sugerida. Devuelve las últimas N señales con su resultado.
export function signalHistory(candles, maxItems = 10) {
  if (!candles || candles.length < 32) return [];
  const out = [];
  // Escanear las últimas ~150 velas para encontrar señales (las últimas
  // 10 ventanas casi nunca tienen una señal clara).
  const tail = candles.slice(-181);
  for (let i = 30; i < tail.length - 1; i++) {
    const a = analyze(tail.slice(0, i + 1));
    if (a.label === 'Sin señal clara') continue;
    const up = a.label === 'Posible subida';
    const next = tail[i + 1];
    const changePct = ((next.close - tail[i].close) / tail[i].close) * 100;
    const won = up ? next.close > tail[i].close : next.close < tail[i].close;
    out.push({
      time: tail[i].time, label: up ? 'COMPRAR' : 'VENDER', key: up ? 'buy' : 'sell',
      score: a.score, price: tail[i].close, nextPrice: next.close, changePct, won,
    });
  }
  return out.slice(-maxItems).reverse();
}
