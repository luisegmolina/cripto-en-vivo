// Tests v10 — funciones puras + servidor local con datos reales.
// 1) Migración de alertas: las 4 viejas de $73.53 -> 1 sola, sonada.
// 2) Liga: ningún nombre de rival contiene "<span" ni código JSX.
// 3) Backtest/historial en 1h: con velas reales de 1h, aciertos coherentes.
// 4) Screener: AVAX +29 es oportunidad, XRP -19 no lo es.
// 5) Código: App.jsx no tiene el span literal, tiene auto-screener,
//    intervalo inicial '1h' y backtest/historial sobre candles1h.
import { dedupePriceAlerts } from './client/src/alerts.js';
import { RIVAL_NAMES } from './client/src/marketPro.js';
import { screenOpportunities } from './client/src/screener.js';
import { backtestSignal } from './client/src/backtest.js';
import { signalHistory } from './client/src/verdict.js';
import { analyze } from './client/src/analysis.js';
import fs from 'node:fs';

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
}

// --- 1) Migración de alertas (las 4 de Luis: 3 iguales above $73.53 + 1 below) ---
const old = [
  { id: 1, symbol: 'BTC', currency: 'USD', direction: 'above', target: 73.53, createdAt: '2026-11-10T19:56:34', triggered: true, triggeredAt: '2026-11-10T19:56:34' },
  { id: 2, symbol: 'BTC', currency: 'USD', direction: 'above', target: 73.53, createdAt: '2026-11-10T19:57:07', triggered: true, triggeredAt: '2026-11-10T19:57:07' },
  { id: 3, symbol: 'BTC', currency: 'USD', direction: 'above', target: 73.53, createdAt: '2026-11-10T19:57:24', triggered: true, triggeredAt: '2026-11-10T19:57:24' },
  { id: 4, symbol: 'BTC', currency: 'USD', direction: 'below', target: 73.53, createdAt: '2026-11-10T20:00:07', triggered: true, triggeredAt: '2026-11-10T20:00:07' },
];
const cleaned = dedupePriceAlerts(old);
check('Migración: 4 alertas viejas -> 2 (1 above + 1 below)', cleaned.length === 2, `quedaron ${cleaned.length}`);
const above = cleaned.find((a) => a.direction === 'above');
check('Migración: la above que queda es la más reciente (19:57:24)', above && above.triggeredAt === '2026-11-10T19:57:24', JSON.stringify(above));
check('Migración: la que queda está marcada como sonada', above && above.triggered === true);
check('Migración: una alerta distinta (otro precio) no se borra',
  dedupePriceAlerts([...old, { id: 5, symbol: 'BTC', currency: 'USD', direction: 'above', target: 75000, createdAt: '2026-11-10T20:01:00', triggered: false }]).length === 3);
check('Migración: lista vacía -> vacía', dedupePriceAlerts([]).length === 0);

// --- 2) Liga: nombres limpios ---
check('Liga: ningún rival contiene "<span"', RIVAL_NAMES.every((n) => !n.includes('<span')));
check('Liga: ningún rival contiene "className"', RIVAL_NAMES.every((n) => !n.includes('className')));

// --- 3) Código fuente: los 5 fallos están arreglados en App.jsx ---
const src = fs.readFileSync('./client/src/App.jsx', 'utf8');
check('Código: no queda el span literal en la liga', !src.includes("'<span className"));
check('Código: la liga usa JSX real <span className="muted"> (demo)', src.includes('{s.demo ? <span className="muted"> (demo)</span> : null}'));
check('Código: intervalo inicial es 1h', src.includes("useState('1h')"));
check('Código: reset a 1h al montar', src.includes("useEffect(() => { setCandleInterval('1h'); }, [])"));
check('Código: screener auto al cargar (screenAutoRanRef + markets.length)', src.includes('screenAutoRanRef') && src.includes('runScreener(markets)'));
check('Código: ya no dice "Todavía no hay screener: pulsa" (la frase solo queda en un comentario)', !src.includes('Todavía no hay screener: pulsa'));
check('Código: backtest/historial usan candles1h', src.includes('candles1h') && src.includes('backtestSignal(candles1h)') && src.includes('signalHistory(candles1h, 10)'));
check('Código: historial y backtest con título fijo (1h)', src.includes('Historial de señales — {symbol} (1h)') && src.includes('Backtest de señales — {symbol} (1h)'));
check('Código: aviso 1m solo junto al gráfico', src.includes('Velas de 1 minuto: 1m es ruido') && !src.includes('Estás viendo velas de 1 minuto'));
check('Código: panel PRO muestra fuente de respaldo y reintento', src.includes('CoinPaprika') && src.includes('globalRetrySec'));
check('Código: /api/global tiene respaldo CoinPaprika en el servidor',
  fs.readFileSync('./server/app.js', 'utf8').includes('coinpaprika.com/v1/global'));

// --- 4) Servidor local con datos reales ---
const BASE = 'http://localhost:3001';
const j = async (u) => { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => null) }; };
const health = await j(`${BASE}/api/health`);
check('Servidor local: /api/health OK', health.status === 200 && health.body && health.body.ok === true, JSON.stringify(health.body));
const tick = await j(`${BASE}/api/ticker?symbol=BTC&currency=USD`);
check('Servidor local: /api/ticker BTC real > 0', tick.status === 200 && tick.body && tick.body.price > 1000, `precio ${tick.body && tick.body.price}`);
console.log(`   BTC ahora: $${tick.body.price} vía ${tick.body.source}`);
const glob = await j(`${BASE}/api/global`);
check('Servidor local: /api/global responde con capitalización real', glob.body && glob.body.available === true && glob.body.totalMarketCapUsd > 1e12,
  JSON.stringify(glob.body).slice(0, 200));
console.log(`   Global: $${glob.body && (glob.body.totalMarketCapUsd / 1e12).toFixed(2)} billones, dominio BTC ${glob.body && glob.body.btcDominance}% — fuente: ${glob.body && glob.body.source}`);
const c1h = await j(`${BASE}/api/candles?symbol=BTC&currency=USD&interval=1h`);
check('Servidor local: /api/candles 1h con velas reales', c1h.status === 200 && c1h.body && Array.isArray(c1h.body.candles) && c1h.body.candles.length >= 100,
  `velas: ${c1h.body && c1h.body.candles && c1h.body.candles.length}`);
if (c1h.body && c1h.body.candles && c1h.body.candles.length >= 100) {
  const bt = backtestSignal(c1h.body.candles);
  check('Backtest 1h con velas reales: tiene ventanas con señal clara', bt.total > 0, `total ${bt.total}`);
  console.log(`   Backtest BTC 1h: acertó ${bt.wins} de ${bt.total} (${bt.pct}%)`);
  const hist = signalHistory(c1h.body.candles, 10);
  check('Historial 1h con velas reales: devuelve señales', Array.isArray(hist) && hist.length > 0, `n=${hist.length}`);
}

// --- 5) Screener con el caso del PDF (AVAX +29 oportunidad, XRP -19 no) ---
const mkts = [
  { symbol: 'AVAX', name: 'Avalanche', price: 8.4, change24h: 0.5, volume24h: 100 },
  { symbol: 'XRP', name: 'XRP', price: 1.05, change24h: -0.6, volume24h: 100 },
];
const an = { AVAX: { rsi: 56, score: 29, label: 'Posible subida' }, XRP: { rsi: 35, score: -19, label: 'Sin señal clara' } };
const scr = screenOpportunities(mkts, an);
check('Screener: AVAX (+29) es oportunidad', scr.opportunities.some((r) => r.symbol === 'AVAX'));
check('Screener: XRP (-19) NO es oportunidad', !scr.opportunities.some((r) => r.symbol === 'XRP') && scr.rest.some((r) => r.symbol === 'XRP'));

console.log(`\n${pass} pasaron, ${fail} fallaron.`);
process.exit(fail ? 1 : 0);
