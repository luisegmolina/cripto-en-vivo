// Estadística mínima para no sobrevender un backtest (v15.2).
// Intervalo de Wilson al 95% para una proporción: con pocas señales el margen
// es enorme, y un 55-60% de aciertos con ~100 muestras NO se distingue de lanzar
// una moneda. Devuelve porcentajes enteros {low, high} o null si no hay datos.
export function wilson95(wins, total) {
  if (!total || total <= 0) return null;
  const z = 1.96;
  const p = wins / total;
  const denom = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return { low: Math.round(Math.max(0, centre - half) * 100), high: Math.round(Math.min(1, centre + half) * 100) };
}
export function isCoinFlip(ci) {
  return Boolean(ci) && ci.low <= 50 && ci.high >= 50;
}
