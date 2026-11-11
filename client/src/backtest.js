// Backtest de señales — PRUEBA EDUCATIVA, no promete nada.
// Para el activo e intervalo seleccionados, recorre las velas históricas
// que ya trae el servidor con ventanas deslizantes: en cada ventana se
// calcula la señal con analyze() (la misma función del análisis en vivo)
// y se comprueba si la dirección que sugería se cumplió en la vela
// siguiente (cierre de la vela siguiente vs cierre de la vela actual).
// Solo cuentan las ventanas con señal clara (subida/bajada); las de
// "Sin señal clara" no se cuentan ni como acierto ni como fallo.
// Resultado: "acertó X de Y" con porcentaje. El pasado NO predice el
// futuro: una señal que acertó el 60% de las veces puede fallar mañana.

import { analyze } from './analysis.js';

export function backtestSignal(candles, maxWindows = 120) {
  if (!candles || candles.length < 32) {
    return { wins: 0, total: 0, pct: null, upWins: 0, upTotal: 0, downWins: 0, downTotal: 0, note: 'Faltan velas para el backtest (mínimo 32).' };
  }
  // Ventana de trabajo: las últimas (maxWindows + 31) velas como mucho,
  // para que el cálculo sea rápido en el navegador.
  const tail = candles.slice(-(maxWindows + 31));
  let wins = 0, total = 0, upWins = 0, upTotal = 0, downWins = 0, downTotal = 0;
  for (let i = 30; i < tail.length - 1; i++) {
    const a = analyze(tail.slice(0, i + 1));
    if (a.label === 'Sin señal clara') continue;
    const nextUp = tail[i + 1].close > tail[i].close;
    const predictedUp = a.label === 'Posible subida';
    total += 1;
    if (predictedUp) {
      upTotal += 1;
      if (nextUp) { wins += 1; upWins += 1; }
    } else {
      downTotal += 1;
      if (!nextUp) { wins += 1; downWins += 1; }
    }
  }
  return {
    wins, total,
    pct: total ? Math.round((wins / total) * 100) : null,
    upWins, upTotal, downWins, downTotal,
    note: total ? '' : 'No hubo señales claras en las velas analizadas.',
  };
}
