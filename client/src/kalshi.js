// Modo Kalshi 15 minutos — PRUEBA EDUCATIVA, no es recomendación de
// inversión ni de apuesta. Desde v12 la app SÍ se conecta a la cuenta
// de Kalshi en SOLO LECTURA (ver posiciones reales, saldo e historial
// con la API Key del usuario, clave cifrada AES-256-GCM en el servidor)
// y desde v13.2 SÍ muestra los precios oficiales del contrato de
// Kalshi en centavos (precio SÍ/NO del mercado actual, vía
// /api/kalshi-market). La app nunca compra, vende ni cierra posiciones:
// todo lo que hace es leer y sugerir. La "probabilidad estimada" de
// la señal es propia, calculada de la señal (puntuación +
// confluencia), NO es la probabilidad oficial de Kalshi.
// Kalshi vende predicciones por ventanas (aquí, 15 minutos): al
// cerrar la ventana se decide si la predicción acertó. Esta capa
// ayuda a leer el mercado en esa ventana: ¿SUBE o BAJA en los
// próximos 15 minutos? ¿Y si ya tengo una posición virtual, cobro
// o me quedo? Todo con dinero VIRTUAL y solo en este navegador.
// La "probabilidad estimada" es propia, calculada de la señal
// (puntuación + confluencia), NO es la probabilidad oficial de Kalshi.

export const KALSHI_WINDOW_MS = 15 * 60 * 1000;

// Ventana de 15 minutos en la que cae `nowMs` (hora local del
// usuario). Las ventanas empiezan a :00, :15, :30 y :45 de cada hora.
// Devuelve inicio, fin, ms que faltan para el cierre y % transcurrido.
export function window15m(nowMs = Date.now()) {
  const startMs = Math.floor(nowMs / KALSHI_WINDOW_MS) * KALSHI_WINDOW_MS;
  const endMs = startMs + KALSHI_WINDOW_MS;
  const remainingMs = Math.max(0, endMs - nowMs);
  const elapsedPct = Math.min(100, Math.max(0, ((nowMs - startMs) / KALSHI_WINDOW_MS) * 100));
  return { startMs, endMs, remainingMs, elapsedPct };
}

export function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString('es-US', { hour: '2-digit', minute: '2-digit' });
}

export function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// Veredicto de la ventana 15m a partir de la puntuación -100..+100
// del análisis de las velas de 15m (misma escala que analyze()).
export function kalshiVerdictForScore(score) {
  if (score >= 25) return { key: 'up', label: 'SUBE', short: 'Sube', icon: '▲' };
  if (score <= -25) return { key: 'down', label: 'BAJA', short: 'Baja', icon: '▼' };
  return { key: 'wait', label: 'ESPERAR', short: 'Esperar', icon: '●' };
}

export function strengthForScore(score) {
  const a = Math.abs(score);
  if (a >= 60) return 'Muy fuerte';
  if (a >= 40) return 'Fuerte';
  if (a >= 25) return 'Moderada';
  return 'Débil';
}

// Probabilidad ESTIMADA propia (NO oficial de Kalshi): parte de 50%
// (moneda al aire) y sube con la fuerza de la señal y con cuántos
// timeframes coinciden. Un 70% estimado NO significa "70% real de
// ganar": la señal acertó ~56% en 1h en el backtest medido.
export function estimatedProb(score, agreement = 0) {
  const p = 50 + Math.abs(score) * 0.35 + agreement * 10;
  return Math.round(Math.min(85, Math.max(50, p)));
}

// v13: rendimiento reciente de la señal 15m y ajuste de confianza.
// Si en las últimas ventanas la señal acierta menos del 50%, no se
// esconde: se avisa y la confianza estimada se baja (tope 60%).
// Función pura, probada en Node.
export function recentWinRate(hist) {
  if (!hist || hist.length < 3) return null;
  const wins = hist.filter((h) => h.won).length;
  return { wins, total: hist.length, rate: wins / hist.length };
}
export function adjustProbForRecent(prob, hist) {
  const r = recentWinRate(hist);
  if (r && r.rate < 0.5) return Math.min(prob, 60);
  return prob;
}

// ¿La señal favorece a la posición? dir 'up' = aposté a que SUBE,
// 'down' = aposté a que BAJA. signalKey: 'up' | 'down' | 'wait'.
export function signalFavorsPosition(dir, signalKey) {
  if (!dir || !signalKey || signalKey === 'wait') return 'neutral';
  return dir === signalKey ? 'favors' : 'against';
}

// Decisión COBRO / AGUANTO / SALGO / ESPERO para una posición
// virtual de Kalshi. Entradas: dirección, precio de entrada,
// precio actual, cantidad virtual, señal de la ventana 15m
// (key + score) y si la señal se debilitó respecto a cuando se entró
// (score al entrar, opcional).
// Reglas, en claro:
// - Sin posición -> ESPERA (no hay nada que cobrar).
// - Ganando + señal a favor -> AGUANTA.
// - Ganando + señal en contra o debilitada -> COBRA AHORA.
// - Perdiendo + señal en contra -> SAL ANTES DE PERDER MÁS.
// - Perdiendo + señal a favor -> AGUANTA CON CUIDADO (la señal
//   sigue a tu favor, pero vas perdiendo: no es momento de cobrar).
// - Sin señal clara -> ESPERA.
export function cashOutDecision({ dir, entryPrice, currentPrice, amount, signalKey, signalScore, entryScore = null }) {
  if (!dir || !entryPrice || entryPrice <= 0 || !currentPrice || currentPrice <= 0 || !amount || amount <= 0) {
    return { key: 'none', label: 'SIN POSICIÓN', title: 'Sin posición virtual', text: 'Pon tu precio de entrada, dirección y cantidad virtual para que la app te diga si cobrar o salir.', pnl: null, pnlPct: null, color: '#94a3b8' };
  }
  const signed = dir === 'up' ? 1 : -1;
  const movePct = ((currentPrice - entryPrice) / entryPrice) * 100 * signed;
  const pnl = (amount * movePct) / 100;
  const pnlPct = movePct;
  const winning = pnl > 0;
  const losing = pnl < 0;
  const favors = signalFavorsPosition(dir, signalKey);
  const weakened = entryScore != null && signalScore != null
    ? Math.abs(signalScore) < Math.abs(entryScore) - 10 || (signalKey !== 'wait' && signalKey !== dir && entryScore != null && Math.sign(entryScore) === signed)
    : false;
  const flipped = favors === 'against';
  if (signalKey === 'wait' || favors === 'neutral') {
    return { key: 'wait', label: 'ESPERA', title: 'Espera: sin señal clara', text: 'La ventana no tiene señal clara. No hay razón para cobrar ni para salir por la señal: espera a que se defina o a que cierre la ventana.', pnl, pnlPct, color: '#94a3b8' };
  }
  if (winning && favors === 'favors' && !weakened) {
    return { key: 'hold', label: 'AGUANTA', title: 'Aguanta: vas ganando y la señal sigue a tu favor', text: 'La señal de 15 minutos sigue en tu dirección. Cobrar ahora dejaría ganancia en la mesa si la ventana sigue así. Vigila el cierre de la ventana.', pnl, pnlPct, color: '#22c55e' };
  }
  if (winning && (flipped || weakened)) {
    return { key: 'cash', label: 'COBRA AHORA', title: 'Cobra ahora: vas ganando y la señal se dio la vuelta o se debilitó', text: 'Vas en verde, pero la señal ya no está a tu favor. En una ventana de 15 minutos el giro puede comerse la ganancia en segundos: cobrar asegura lo ganado.', pnl, pnlPct, color: '#22c55e' };
  }
  if (losing && flipped) {
    return { key: 'exit', label: 'SAL ANTES DE PERDER MÁS', title: 'Sal antes de perder más', text: 'Vas perdiendo y la señal va en tu contra. La ventana juega en contra: salir ahora limita la pérdida en vez de esperar a que cierre peor.', pnl, pnlPct, color: '#ef4444' };
  }
  if (losing && favors === 'favors') {
    return { key: 'hold-careful', label: 'AGUANTA CON CUIDADO', title: 'Aguanta con cuidado: la señal sigue a tu favor, pero vas perdiendo', text: 'El precio va en tu contra de momento, pero la señal de 15 minutos sigue en tu dirección. No es momento de cobrar (no hay ganancia), pero pon un límite: si la señal se da la vuelta, sal.', pnl, pnlPct, color: '#f59e0b' };
  }
  return { key: 'wait', label: 'ESPERA', title: 'Espera', text: 'No hay una decisión clara por la señal. Espera a que se defina la ventana.', pnl, pnlPct, color: '#94a3b8' };
}

// Decisión COBRO / AGUANTO / SALGO para una posición REAL de Kalshi
// (v13.4). La regla por SEÑAL sola no basta: en Kalshi lo que manda
// es el PRECIO DEL CONTRATO en centavos (el contrato paga $1 si
// aciertas y $0 si no). Por eso esta función mira PRIMERO el precio:
// - Contrato a ≥85¢: casi ganado. COBRA AHORA y asegura: quedan
//   como mucho 15¢ por ganar y puedes perder 85¢ si se da la vuelta.
// - Contrato a ≤15¢: casi perdido. SAL ANTES DE PERDER MÁS, salvo
//   que la señal esté MUY a tu favor (puntuación ≥40 en tu dirección)
//   Y quede más de la mitad de la ventana (>7,5 min): entonces
//   AGUANTA CON CUIDADO, porque aún hay tiempo de que se dé la vuelta.
// - Entre 15¢ y 85¢: manda la regla por señal de cashOutDecision
//   (la misma que la posición virtual), con el P&L real en $
//   ((precio actual − precio medio) × cantidad / 100).
// Entradas en CENTAVOS (1–99): entryPriceCents = precio medio,
// currentPriceCents = precio actual del lado que tienes, count =
// número de contratos. windowRemainingMs opcional (ms hasta el
// cierre de la ventana). Devuelve lo mismo que cashOutDecision más
// priceRule: 'high' | 'low' | 'low-but-signal' | 'signal', y
// reason: 'contract-price' | 'signal'.
export function cashOutDecisionReal({ dir, entryPriceCents, currentPriceCents, count, signalKey, signalScore, entryScore = null, windowRemainingMs = null }) {
  const entry = Number(entryPriceCents);
  const cur = Number(currentPriceCents);
  const n = Number(count);
  if (!dir || !Number.isFinite(entry) || entry <= 0 || entry > 100 || !Number.isFinite(cur) || cur < 0 || cur > 100 || !Number.isFinite(n) || n <= 0) {
    return { key: 'none', label: 'SIN DATO', title: 'Sin precio del contrato', text: 'Falta el precio medio o el precio actual del contrato en centavos para decidir. Comprueba la posición en Kalshi.', pnl: null, pnlPct: null, priceRule: 'signal', reason: 'signal', color: '#94a3b8' };
  }
  // P&L real en $: cada centavo de movimiento vale $0,01 por contrato.
  const pnl = ((cur - entry) * n) / 100;
  const favors = signalFavorsPosition(dir, signalKey);
  const strongFavor = favors === 'favors' && signalScore != null && Math.abs(signalScore) >= 40;
  const lotsOfTimeLeft = windowRemainingMs != null && windowRemainingMs > (7.5 * 60 * 1000);
  if (cur >= 85) {
    return { key: 'cash', label: 'COBRA AHORA', title: 'Cobra ahora: tu contrato vale 85¢ o más — casi ganado', text: `El lado que tienes vale ${cur}¢ de $1: está casi ganado. Quedan como mucho ${100 - cur}¢ por ganar y puedes perder ${cur}¢ si la ventana se da la vuelta en los últimos minutos. Cobrar asegura casi todo.`, pnl, pnlPct: null, priceRule: 'high', reason: 'contract-price', color: '#22c55e' };
  }
  if (cur <= 15) {
    if (strongFavor && lotsOfTimeLeft) {
      return { key: 'hold-careful', label: 'AGUANTA CON CUIDADO', title: 'Aguanta con cuidado: vale 15¢ o menos, pero la señal está muy a tu favor y queda más de la mitad de la ventana', text: `El contrato vale solo ${cur}¢, casi perdido, pero la señal 15m está muy a tu favor (puntuación ${signalScore}) y quedan más de 7 minutos y medio. Hay tiempo de que se dé la vuelta, pero si la señal se debilita o el precio baja más, sal sin esperar al cierre.`, pnl, pnlPct: null, priceRule: 'low-but-signal', reason: 'contract-price', color: '#f59e0b' };
    }
    return { key: 'exit', label: 'SAL ANTES DE PERDER MÁS', title: 'Sal antes de perder más: tu contrato vale 15¢ o menos — casi perdido', text: `El lado que tienes vale solo ${cur}¢ de $1: está casi perdido. Quedan como mucho ${cur}¢ por recuperar y la ventana se está acabando. Salir ahora limita la pérdida en vez de esperar a que cierre en $0.`, pnl, pnlPct: null, priceRule: 'low', reason: 'contract-price', color: '#ef4444' };
  }
  // Entre 15¢ y 85¢: manda la señal, como en la posición virtual.
  // cashOutDecision trabaja con precios en las mismas unidades para
  // el signo del movimiento; el P&L se sobrescribe con el real en $.
  const bySignal = cashOutDecision({ dir, entryPrice: entry, currentPrice: cur, amount: (entry * n) / 100, signalKey, signalScore, entryScore });
  return { ...bySignal, pnl, pnlPct: null, priceRule: 'signal', reason: 'signal' };
}

// Precio sugerido para cobrar (educativo): si la decisión es COBRA
// o SAL, es el precio actual; si es AGUANTA, es el objetivo a 1 ATR
// de 15m en la dirección de la posición; si no hay posición, null.
export function suggestedExitPrice({ decisionKey, currentPrice, entryPrice, dir, atr15m }) {
  if (!currentPrice || currentPrice <= 0) return null;
  if (decisionKey === 'cash' || decisionKey === 'exit') return currentPrice;
  if ((decisionKey === 'hold' || decisionKey === 'hold-careful') && atr15m && atr15m > 0 && dir) {
    return dir === 'up' ? entryPrice + atr15m : entryPrice - atr15m;
  }
  return null;
}
