// Actualización en vivo de la última vela con cada tick del ticker.
// Antes el gráfico solo cambiaba cuando el servidor traía velas nuevas
// (cada 6 s). Con esto, cada tick de precio (cada 1 s) mueve la última
// vela en pantalla: close = precio actual, high = max(high, precio),
// low = min(low, precio).
//
// OJO: la última vela que trae Coinbase va con RETRASO (comprobado
// 11-nov-2026: la última vela de 1m era de hace ~4-5 minutos, mientras
// Kraken sí trae la vela del minuto actual). Por eso aquí NO se exige
// que la última vela sea el bucket actual: si el tick cae en un bucket
// nuevo, se CREA la vela de ese bucket con open = high = low = close =
// precio del tick (volumen 0, es una vela viva, no histórica). Es lo que
// hace cualquier gráfico en vivo. El próximo fetch de /api/candles del
// servidor la reemplaza por la vela oficial de esa fuente, así que
// cualquier diferencia se corrige sola en segundos. Si el tick es más
// viejo que la última vela (reloj desfasado), se ignora.

export function intervalSeconds(interval) {
  const map = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 };
  return map[interval] || 60;
}

// Devuelve una copia nueva del array de velas con la última vela
// actualizada al precio dado (o con la vela nueva del bucket actual
// creada), o la misma referencia si no hubo cambio real, o null si no
// hay velas o el tick es más viejo que la última vela.
export function updateLastCandle(candles, price, interval, nowMs = Date.now()) {
  if (!candles || !candles.length) return null;
  if (price == null || Number.isNaN(price)) return null;
  const last = candles[candles.length - 1];
  const sec = intervalSeconds(interval);
  const bucket = Math.floor(nowMs / 1000 / sec) * sec;
  if (bucket < last.time) return null;
  if (bucket > last.time) {
    // Vela nueva del bucket actual, construida con el tick en vivo.
    const fresh = { time: bucket, open: price, high: price, low: price, close: price, volume: 0 };
    return [...candles, fresh];
  }
  const updated = {
    ...last,
    close: price,
    high: Math.max(last.high, price),
    low: Math.min(last.low, price),
  };
  // Sin cambio real, no devolver copia nueva (evita re-renders).
  if (updated.close === last.close && updated.high === last.high && updated.low === last.low) return candles;
  return [...candles.slice(0, -1), updated];
}

// Fusiona las velas del servidor con las velas vivas que ya creamos
// con ticks: el servidor puede venir con retraso (Coinbase, 1m) y su
// última vela puede ser más vieja que la vela viva actual. En ese caso
// se conservan las velas vivas más nuevas que la última del servidor;
// cuando el servidor se ponga al día, sus velas oficiales las
// reemplazan solas.
export function mergeServerCandles(serverCandles, liveCandles) {
  if (!serverCandles || !serverCandles.length) return liveCandles || [];
  if (!liveCandles || !liveCandles.length) return serverCandles;
  const lastServerTime = serverCandles[serverCandles.length - 1].time;
  const tail = liveCandles.filter((c) => c.time > lastServerTime);
  return tail.length ? [...serverCandles, ...tail] : serverCandles;
}

export function candlesSignature(candles) {
  if (!candles || !candles.length) return 'empty';
  const last = candles[candles.length - 1];
  return `${candles.length}:${last.time}:${last.open}:${last.high}:${last.low}:${last.close}:${last.volume}`;
}
