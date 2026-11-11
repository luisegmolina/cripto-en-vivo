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

// --- Migración v10: alertas viejas duplicadas ---
// Antes de v9 no había cooldown ni anti-duplicados, y en el navegador
// de Luis quedaron 4 entradas de la misma alerta (BTC por encima de
// $73.53, 7:56–8:00 p.m.). Esta función pura elimina duplicados:
// misma clave símbolo|moneda|dirección|precio -> se queda solo la más
// reciente (por triggeredAt o createdAt) y, si alguna de las copias
// ya sonó, la que queda queda marcada como sonada. No borra alertas
// distintas (otro precio, otra dirección u otro activo).
export function dedupePriceAlerts(list) {
  if (!Array.isArray(list) || !list.length) return [];
  const byKey = new Map();
  for (const a of list) {
    if (!a || a.target == null) continue;
    const key = alertKey(a);
    const stamp = (x) => new Date(x.triggeredAt || x.createdAt || 0).getTime() || 0;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...a, id: a.id ?? Date.now() }); continue; }
    const keepNewer = stamp(a) >= stamp(prev);
    const merged = keepNewer ? { ...a, id: a.id ?? prev.id } : { ...prev };
    // Si alguna copia ya sonó, la que queda es sonada (con la hora más reciente).
    if (prev.triggered || a.triggered) {
      merged.triggered = true;
      merged.triggeredAt = (stamp(a) >= stamp(prev) ? a.triggeredAt : prev.triggeredAt)
        || a.triggeredAt || prev.triggeredAt || merged.createdAt;
    }
    byKey.set(key, merged);
  }
  return [...byKey.values()]
    .sort((x, y) => (new Date(y.createdAt || 0) - new Date(x.createdAt || 0)))
    .slice(0, 20);
}
export const migratePriceAlerts = dedupePriceAlerts;
export function shouldFireAlert(cooldownMap, alert, nowMs = Date.now()) {
  const map = cooldownMap || {};
  const last = map[alertKey(alert)] || 0;
  if (nowMs - last < ALERT_COOLDOWN_MS) return { fire: false, map };
  return { fire: true, map: { ...map, [alertKey(alert)]: nowMs } };
}
