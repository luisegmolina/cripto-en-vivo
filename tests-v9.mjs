// Tests v9 (Node, datos reales del servidor local).
// 1) Con ESPERAR no hay entrada sugerida (ni stop, ni objetivo).
// 2) Una alerta no se dispara dos veces seguidas (cooldown 1 h).
// 3) El screener no pone una señal débil (-19) como oportunidad #2.
// 4) Historial/backtest con velas reales de 1h (intervalo por defecto).
// Uso: arrancar el servidor local y correr: node tests-v9.mjs
import { tradePlan } from './client/src/verdict.js';
import { shouldFireAlert, ALERT_COOLDOWN_MS } from './client/src/alerts.js';
import { screenOpportunities } from './client/src/screener.js';
import { backtestSignal } from './client/src/backtest.js';
import { signalHistory } from './client/src/verdict.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}
const BASE = process.env.SERVER_URL || 'http://localhost:3001';
async function get(path) {
  const r = await fetch(BASE + path);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${path}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

// --- 1) tradePlan con ESPERAR ---
console.log('1) Plan con ESPERAR:');
const candles1h = (await get('/api/candles?symbol=BTC&currency=USD&interval=1h')).candles;
const price = (await get('/api/ticker?symbol=BTC&currency=USD')).price;
const wait = tradePlan(price, candles1h, 'wait');
check('ESPERAR: entry es null', wait.entry === null, JSON.stringify(wait));
check('ESPERAR: stopLoss es null', wait.stopLoss === null);
check('ESPERAR: takeProfit es null', wait.takeProfit === null);
check('ESPERAR: hay niveles de activación', wait.activationUp > price && wait.activationDown < price, `${wait.activationUp} / ${wait.activationDown}`);
const buy = tradePlan(price, candles1h, 'buy');
check('COMPRAR: sí hay entrada', buy.entry === price);
check('COMPRAR: stop < entrada < objetivo', buy.stopLoss < buy.entry && buy.entry < buy.takeProfit);
const sell = tradePlan(price, candles1h, 'sell');
check('VENDER: sí hay entrada', sell.entry === price);
check('VENDER: objetivo < entrada < stop', sell.takeProfit < sell.entry && sell.entry < sell.stopLoss);

// --- 2) Cooldown de alertas ---
console.log('2) Cooldown de alertas (1 h):');
const alert = { symbol: 'BTC', currency: 'USD', direction: 'above', target: 73530 };
const t0 = Date.now();
const r1 = shouldFireAlert({}, alert, t0);
check('1ª vez: suena', r1.fire === true);
const r2 = shouldFireAlert(r1.map, alert, t0 + 1000);
check('1 s después: NO vuelve a sonar', r2.fire === false);
const r3 = shouldFireAlert(r1.map, alert, t0 + 30 * 60000);
check('30 min después: NO vuelve a sonar', r3.fire === false);
const r4 = shouldFireAlert(r1.map, alert, t0 + ALERT_COOLDOWN_MS + 1000);
check('1 h + 1 s después: sí puede sonar de nuevo', r4.fire === true);
const other = { ...alert, target: 74000 };
check('Otro precio distinto: sí suena', shouldFireAlert(r1.map, other, t0 + 1000).fire === true);

// --- 3) Screener: señal débil -19 NO es oportunidad ---
console.log('3) Screener con el caso del PDF (XRP -19, AVAX +29):');
const markets = [
  { symbol: 'AVAX', name: 'Avalanche', price: 8.41, change24h: 0.57, volume24h: 1000000 },
  { symbol: 'XRP', name: 'XRP', price: 1.048, change24h: -0.65, volume24h: 2000000 },
  { symbol: 'ADA', name: 'Cardano', price: 0.174, change24h: 0.25, volume24h: 1500000 },
];
const analyses = {
  AVAX: { rsi: 56, score: 29, label: 'Posible subida' },
  XRP: { rsi: 35, score: -19, label: 'Sin señal clara' },
  ADA: { rsi: 37, score: -19, label: 'Sin señal clara' },
};
const scr = screenOpportunities(markets, analyses);
check('AVAX (+29) es oportunidad', scr.opportunities.some((r) => r.symbol === 'AVAX'));
check('XRP (-19) NO es oportunidad', !scr.opportunities.some((r) => r.symbol === 'XRP'));
check('XRP (-19) está en "sin oportunidad clara"', scr.rest.some((r) => r.symbol === 'XRP'));
check('La oportunidad #1 es AVAX, no XRP', scr.opportunities[0] && scr.opportunities[0].symbol === 'AVAX');

// --- 4) Historial/backtest en 1h (intervalo por defecto) ---
console.log('4) Historial y backtest en 1h (datos reales):');
const bt = backtestSignal(candles1h);
console.log(`   Backtest BTC 1h: ${bt.wins} de ${bt.total} (${bt.pct}%)`);
check('Backtest 1h tiene ventanas con señal clara', bt.total > 0, JSON.stringify(bt));
const hist = signalHistory(candles1h, 10);
console.log(`   Historial BTC 1h: ${hist.length} señales, ${hist.filter((h) => h.won).length} aciertos`);
check('Historial 1h tiene señales', hist.length > 0);

// --- 5) /api/global (capitalización real) ---
console.log('5) /api/global:');
try {
  const g = await get('/api/global');
  console.log(`   Capitalización total: $${(g.totalMarketCapUsd / 1e12).toFixed(2)} billones · Dominio BTC: ${g.btcDominance}% · fuente ${g.source}`);
  check('Capitalización total es realista (> $1 billón)', g.totalMarketCapUsd > 1e12, String(g.totalMarketCapUsd));
  check('Dominio BTC entre 40% y 80%', g.btcDominance > 40 && g.btcDominance < 80, String(g.btcDominance));
} catch (e) {
  console.log(`   /api/global no disponible ahora: ${e.message}`);
  check('Si /api/global falla, devuelve 503 (no un número inventado)', /503/.test(e.message), e.message);
}

console.log(`\nResultado: ${pass} pasaron, ${fail} fallaron.`);
process.exit(fail ? 1 : 0);
