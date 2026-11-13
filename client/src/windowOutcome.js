// Medición de acierto de la señal 15m COMO LIQUIDA KALSHI (v13.4).
// PRUEBA EDUCATIVA, no promete nada.
//
// FALLO QUE CORRIGE: signalHistory/backtestSignal (verdict.js y
// backtest.js) comparan el cierre de la vela SIGUIENTE con el cierre
// actual. Eso NO es lo que liquida Kalshi: una ventana 15m se
// resuelve contra su PRECIO OBJETIVO (el precio de referencia al
// abrir la ventana, aprox. la apertura de la vela 15m). La señal
// dice "SUBE/BAJA en esta ventana", así que acierta si el CIERRE de
// ESA MISMA ventana terminó por encima (SUBE) o por debajo (BAJA)
// de su APERTURA. Aquí se mide eso, vela por vela, sin mirar la
// vela siguiente.
//
// Reglas:
// - Solo cuentan las ventanas con señal clara (subida/bajada); las
//   de "Sin señal clara" no se cuentan ni como acierto ni como fallo.
// - La última vela es la ventana EN CURSO (aún no cerró): NO se
//   cuenta, porque no tiene cierre. Por eso el bucle llega hasta
//   la penúltima vela.
// - "Últimas ventanas con señal clara" son las últimas N ventanas
//   CON señal, no necesariamente consecutivas: la señal es rara
//   (~13 en ~45 h medidas el 12-nov-2026), así que pueden estar
//   separadas por horas. La etiqueta de la UI lo dice así.
// - Un empate exacto (cierre == apertura) cuenta como fallo: la
//   señal apostaba a un movimiento que no se dio.

import { analyze } from './analysis.js';

export function evaluateWindowSignal(candles, maxItems = 5) {
  if (!candles || candles.length < 32) return [];
  const out = [];
  // Últimas ~150 velas cerradas para encontrar señales (la última
  // vela, en curso, queda fuera: el bucle llega a length - 2).
  const tail = candles.slice(-181);
  for (let i = 30; i < tail.length - 1; i++) {
    const a = analyze(tail.slice(0, i + 1));
    if (a.label === 'Sin señal clara') continue;
    const up = a.label === 'Posible subida';
    const c = tail[i];
    const changePct = ((c.close - c.open) / c.open) * 100;
    // Acierto Kalshi: cierre de ESTA ventana vs SU apertura.
    const won = up ? c.close > c.open : c.close < c.open;
    out.push({
      time: c.time, label: up ? 'COMPRAR' : 'VENDER', key: up ? 'buy' : 'sell',
      score: a.score, open: c.open, price: c.close, close: c.close,
      nextPrice: null, changePct, won, basis: 'window-close-vs-open',
    });
  }
  return out.slice(-maxItems).reverse();
}

export function backtestWindowSignal(candles, maxWindows = 120) {
  if (!candles || candles.length < 32) {
    return { wins: 0, total: 0, pct: null, upWins: 0, upTotal: 0, downWins: 0, downTotal: 0, basis: 'window-close-vs-open', note: 'Faltan velas para el backtest (mínimo 32).' };
  }
  const tail = candles.slice(-(maxWindows + 31));
  let wins = 0, total = 0, upWins = 0, upTotal = 0, downWins = 0, downTotal = 0;
  for (let i = 30; i < tail.length - 1; i++) {
    const a = analyze(tail.slice(0, i + 1));
    if (a.label === 'Sin señal clara') continue;
    const predictedUp = a.label === 'Posible subida';
    const c = tail[i];
    const closedUp = c.close > c.open;
    total += 1;
    if (predictedUp) {
      upTotal += 1;
      if (closedUp) { wins += 1; upWins += 1; }
    } else {
      downTotal += 1;
      if (!closedUp) { wins += 1; downWins += 1; }
    }
  }
  return {
    wins, total,
    pct: total ? Math.round((wins / total) * 100) : null,
    upWins, upTotal, downWins, downTotal,
    basis: 'window-close-vs-open',
    note: total ? '' : 'No hubo señales claras en las velas analizadas.',
  };
}
