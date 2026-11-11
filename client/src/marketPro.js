// Panel de mercado PRO — todo calculado en el navegador con los datos
// que ya trae /api/markets, SALVO la capitalización total y el dominio
// de BTC, que ahora vienen de /api/global (CoinGecko, dato real).
// El proxy precio × volumen 24h SE ELIMINÓ en v9: no es capitalización
// (sería precio × oferta en circulación) y daba cifras absurdas
// ("$0.4 mil M"). Si CoinGecko falla (429), la app muestra
// "no disponible" en vez de inventar un número.
// - Índice de miedo y codicia: ESTIMADO PROPIO a partir de las 10
//   criptos (amplitud, impulso medio y RSI del activo seleccionado).
//   NO es el índice oficial de alternative.me. Solo orienta el ánimo.

// Índice de miedo y codicia ESTIMADO (0-100) con las 10 criptos.
// Componentes: amplitud (% que suben), impulso medio 24h y RSI.
// Ponderación: 40% amplitud + 30% impulso + 30% RSI.
export function fearGreedEstimate(markets, rsiSelected) {
  if (!markets || !markets.length) return null;
  const ups = markets.filter((m) => (m.change24h ?? 0) >= 0).length;
  const breadth = (ups / markets.length) * 100;
  const avg = markets.reduce((s, m) => s + (m.change24h ?? 0), 0) / markets.length;
  const momentum = Math.max(0, Math.min(100, ((avg + 5) / 10) * 100));
  const rsi = rsiSelected != null ? Math.max(0, Math.min(100, rsiSelected)) : 50;
  const value = Math.round(0.4 * breadth + 0.3 * momentum + 0.3 * rsi);
  const label = value <= 24 ? 'Miedo extremo'
    : value <= 44 ? 'Miedo'
    : value <= 55 ? 'Neutral'
    : value <= 75 ? 'Codicia'
    : 'Codicia extrema';
  return { value, label, breadth, avgChange: avg, rsi };
}

// Qué está caliente hoy: las 10 ordenadas por cambio 24h.
export function heatToday(markets) {
  if (!markets || !markets.length) return [];
  return [...markets]
    .filter((m) => m.change24h != null)
    .sort((a, b) => b.change24h - a.change24h);
}

// Clave de semana ISO: "2026-W46". La liga semanal se reinicia cada lunes.
export function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7; // lunes=1 ... domingo=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // jueves de esa semana
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Rivales DEMO de la liga semanal: nombres fijos, rendimiento simulado
// determinista por semana (misma semana = mismos rivales y resultados).
// Son jugadores locales de ejemplo, NO personas reales ni cuentas.
// Etiquetado claramente como DEMO en la UI.
export const RIVAL_NAMES = ['Satoshi Jr.', 'La Ballena', 'Hodler99', 'Doña Vela', 'El Toro', 'La Osa', 'CriptoManía'];
export function rivalsForWeek(weekKey) {
  const rng = mulberry32(hashString(`liga-${weekKey}`));
  return RIVAL_NAMES.map((name) => {
    // Rendimiento semanal simulado entre -8% y +11%, determinista.
    const weeklyReturn = Math.round(((rng() * 19) - 8) * 100) / 100;
    return { name, weeklyReturn, demo: true };
  });
}
