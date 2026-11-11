// Anti-duplicados de alertas de precio — v9.
// En el PDF del 10-nov la misma alerta ("BTC por encima de $73.53")
// sonó 4 veces. Regla: una alerta suena UNA vez al cruzar y luego
// entra en cooldown de 1 h para ese mismo precio objetivo
// (símbolo|moneda|dirección|precio). Si el precio vuelve a cruzarse
// antes de 1 h, se marca como sonada pero NO vuelve a sonar ni a
// duplicarse en la lista. Función pura para poder probarla en Node.

export const ALERT_COOLDOWN_MS = 3600000; // 1 hora

export function alertKey(a) {
  return `${a.symbol}|${a.currency}|${a.direction}|${a.target}`;
}

// Devuelve { fire: bool, map: nuevo mapa de cooldown }.
// `map` es { clave: timestampMs del último disparo }.
export function shouldFireAlert(cooldownMap, alert, nowMs = Date.now()) {
  const map = cooldownMap || {};
  const last = map[alertKey(alert)] || 0;
  if (nowMs - last < ALERT_COOLDOWN_MS) return { fire: false, map };
  return { fire: true, map: { ...map, [alertKey(alert)]: nowMs } };
}
