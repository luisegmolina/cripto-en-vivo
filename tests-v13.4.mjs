// Pruebas v13.4 — Medición Kalshi real + decisión por precio del contrato.
// Uso: con el servidor local en marcha (PORT=3001 node server/server.js):
//   node tests-v13.4.mjs
// Las secciones marcadas [vivo] necesitan el servidor; sin él se saltan
// con aviso y el resto sigue corriendo. Las puras no necesitan nada.
//
// Qué se comprueba:
//  1. Medición 15m COMO LIQUIDA KALSHI (windowOutcome.js): cierre de la
//     MISMA ventana vs su apertura, no la vela siguiente. Con velas
//     reales 15m de BTC: cada fila cumple won = (SUBE ? close>open :
//     close<open), el backtest recontado a mano coincide, y la medida
//     vieja (signalHistory) discrepa en al menos una ventana — es la
//     prueba de que la corrección cambia el resultado (medido
//     13-nov-2026 ~03:10 UTC: vieja 4/10 = 40%, nueva 7/10 = 70%,
//     8 de 13 ventanas claras discrepan).
//  2. Decisión REAL por precio del contrato (cashOutDecisionReal):
//     ≥85¢ cobra, ≤15¢ sal, ≤15¢ + señal muy a favor + mucho tiempo
//     aguanta con cuidado, entre 15 y 85 manda la señal, P&L real en $.
//     La virtual (cashOutDecision, precio USD) no cambia.
//  3. Cambio 24h unificado [vivo]: ticker y grid de Mercados dan el
//     mismo cambio 24h para BTC (misma fuente, Coinbase; antes Kraken
//     daba −1,70% frente a −4,84% de Coinbase el 12-nov-2026).
//  4. Estáticos: etiqueta "Últimas ventanas con señal clara", SEÑAL
//     DÉBIL en el veredicto, banner de decisión real, auto-refresco
//     30 s + aviso >2 min, historial con realizedPnl y "sin dato",
//     comentario de kalshi.js actualizado, markets primaria Coinbase.
//  5. Versión v13.4.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze } from './client/src/analysis.js';
import { signalHistory } from './client/src/verdict.js';
import { backtestSignal } from './client/src/backtest.js';
import { evaluateWindowSignal, backtestWindowSignal } from './client/src/windowOutcome.js';
import { cashOutDecision, cashOutDecisionReal } from './client/src/kalshi.js';

let pass = 0, fail = 0, skipped = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
function skip(name) { skipped++; console.log(`  ○ SALTADO: ${name}`); }
function count(src, sub) { return src.split(sub).length - 1; }

const appSrc = readFileSync('./client/src/App.jsx', 'utf8');
const kcSrc = readFileSync('./client/src/KalshiConnect.jsx', 'utf8');
const kalshiSrc = readFileSync('./client/src/kalshi.js', 'utf8');
const serverAppSrc = readFileSync('./server/app.js', 'utf8');
const kalshiServerSrc = readFileSync('./server/kalshiServer.js', 'utf8');
const versionTxt = readFileSync('./VERSION.txt', 'utf8');
const BASE = 'http://localhost:3001';

async function serverUp() {
  try { const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(5000) }); return r.ok; }
  catch { return false; }
}

// ---------- 1. Medición de ventanas como liquida Kalshi ----------
console.log('— medición 15m: cierre de la ventana vs su apertura —');
{
  // Serie sintética corta: sin 32 velas no hay medición.
  ok('sin 32 velas, historial vacío', evaluateWindowSignal([], 5).length === 0);
  ok('sin 32 velas, backtest total 0', backtestWindowSignal([]).total === 0);
  ok('backtest trae basis window-close-vs-open', backtestWindowSignal([]).basis === 'window-close-vs-open');
}

// ---------- 2. Decisión real por precio del contrato (pura) ----------
console.log('— cashOutDecisionReal: precio del contrato en centavos —');
{
  const base = { dir: 'up', entryPriceCents: 40, currentPriceCents: 50, count: 10, signalKey: 'up', signalScore: 40 };
  // P&L real: (50−40)¢ × 10 contratos / 100 = +$1,00.
  const mid = cashOutDecisionReal(base);
  ok('entre 15 y 85 manda la señal: ganando + a favor -> AGUANTA', mid.key === 'hold' && mid.priceRule === 'signal' && mid.reason === 'signal', JSON.stringify(mid));
  ok('P&L real en $: (50−40)¢ × 10 / 100 = +$1,00', Math.abs(mid.pnl - 1) < 1e-9, `pnl=${mid.pnl}`);
  const high = cashOutDecisionReal({ ...base, currentPriceCents: 90, signalKey: 'down', signalScore: -60 });
  ok('≥85¢ cobra aunque la señal vaya en contra', high.key === 'cash' && high.priceRule === 'high' && high.reason === 'contract-price', JSON.stringify(high));
  ok('≥85¢: P&L real (90−40)¢ × 10 / 100 = +$5,00', Math.abs(high.pnl - 5) < 1e-9, `pnl=${high.pnl}`);
  const edge85 = cashOutDecisionReal({ ...base, currentPriceCents: 85 });
  ok('justo 85¢ ya es COBRA AHORA', edge85.key === 'cash' && edge85.priceRule === 'high');
  const low = cashOutDecisionReal({ ...base, currentPriceCents: 10, signalKey: 'up', signalScore: 20 });
  ok('≤15¢ sale aunque la señal esté a favor pero floja', low.key === 'exit' && low.priceRule === 'low', JSON.stringify(low));
  const lowStrongTime = cashOutDecisionReal({ ...base, currentPriceCents: 10, signalKey: 'up', signalScore: 50, windowRemainingMs: 9 * 60 * 1000 });
  ok('≤15¢ + señal muy a favor (≥40) + >7,5 min -> AGUANTA CON CUIDADO', lowStrongTime.key === 'hold-careful' && lowStrongTime.priceRule === 'low-but-signal', JSON.stringify(lowStrongTime));
  const lowStrongNoTime = cashOutDecisionReal({ ...base, currentPriceCents: 10, signalKey: 'up', signalScore: 50, windowRemainingMs: 2 * 60 * 1000 });
  ok('≤15¢ + señal muy a favor pero quedan 2 min -> SAL igual', lowStrongNoTime.key === 'exit', JSON.stringify(lowStrongNoTime));
  const lowNoTime = cashOutDecisionReal({ ...base, currentPriceCents: 12, signalKey: 'up', signalScore: 60 });
  ok('≤15¢ + señal muy a favor pero sin dato de tiempo -> SAL (no se asume tiempo)', lowNoTime.key === 'exit', JSON.stringify(lowNoTime));
  const edge15 = cashOutDecisionReal({ ...base, currentPriceCents: 15 });
  ok('justo 15¢ ya es SAL', edge15.key === 'exit' && edge15.priceRule === 'low');
  const midLose = cashOutDecisionReal({ ...base, entryPriceCents: 60, currentPriceCents: 50, signalKey: 'down', signalScore: -40 });
  ok('entre 15 y 85, perdiendo + señal en contra -> SAL (regla por señal)', midLose.key === 'exit' && midLose.priceRule === 'signal', JSON.stringify(midLose));
  ok('P&L real negativo: (50−60)¢ × 10 / 100 = −$1,00', Math.abs(midLose.pnl - (-1)) < 1e-9, `pnl=${midLose.pnl}`);
  const noData = cashOutDecisionReal({ dir: 'up', entryPriceCents: null, currentPriceCents: 50, count: 10, signalKey: 'up', signalScore: 40 });
  ok('sin precio medio no se inventa decisión', noData.key === 'none');
  const badPrice = cashOutDecisionReal({ ...base, currentPriceCents: 150 });
  ok('precio fuera de 0–100¢ no se acepta', badPrice.key === 'none');
  // La virtual NO cambia: sigue con precio USD y cashOutDecision.
  const virt = cashOutDecision({ dir: 'up', entryPrice: 70000, currentPrice: 71000, amount: 100, signalKey: 'up', signalScore: 40 });
  ok('virtual intacta: ganando + a favor -> AGUANTA', virt.key === 'hold');
}

// ---------- 4. Estáticos: UI, auto-refresco, historial, textos ----------
console.log('— estáticos: UI y textos v13.4 —');
ok('App.jsx usa la medición Kalshi para el backtest 15m', appSrc.includes('backtestWindowSignal(candles15m)'));
ok('App.jsx usa la medición Kalshi para últimas ventanas', appSrc.includes('evaluateWindowSignal(candles15m, 5)'));
ok('la señal general 1h sigue con la medida de vela siguiente', appSrc.includes('backtestSignal(candles1h)') && appSrc.includes('signalHistory(candles1h, 10)'));
ok('etiqueta honesta: Últimas ventanas con señal clara', appSrc.includes('Últimas ventanas con señal clara'));
ok('ya no dice "Últimas ventanas de 15 min" a secas', !appSrc.includes('Últimas ventanas de 15 min —'));
ok('nota que no son ventanas seguidas', appSrc.includes('No son las últimas 5 ventanas seguidas'));
ok('tabla con Apertura y Cierre (no solo "Precio" y "Después")', appSrc.includes('<th>Apertura</th><th>Cierre</th>'));
ok('SEÑAL DÉBIL junto al veredicto', appSrc.includes('SEÑAL DÉBIL'));
ok('aviso de señal débil cita la medida Kalshi', appSrc.includes('Medido como liquida Kalshi'));
ok('banner de decisión real debajo del veredicto, antes del formulario virtual',
  appSrc.indexOf('Tu posición real en Kalshi') > appSrc.indexOf('MODO KALSHI 15 MIN') &&
  appSrc.indexOf('Tu posición real en Kalshi') < appSrc.indexOf('<h3>¿Cobro o me quedo?</h3>'));
ok('App.jsx pasa active y onRealDecision a KalshiConnect', appSrc.includes("active={activeTab === 'kalshi'}") && appSrc.includes('onRealDecision={handleRealDecisions}'));
ok('KalshiConnect usa cashOutDecisionReal para la tabla real', kcSrc.includes('cashOutDecisionReal') && kcSrc.includes('realDecisionFor(pos)'));
ok('KalshiConnect ya no decide la real con cashOutDecision', !kcSrc.includes('cashOutDecision({ dir'));
ok('regla por precio documentada en la UI (≥85¢ / ≤15¢)', kcSrc.includes('≥85¢') && kcSrc.includes('≤15¢'));
ok('auto-refresco cada 30 s solo con pestaña activa y conectado', kcSrc.includes('setInterval(() => { loadPositionsQuiet(); }, 30000)') && kcSrc.includes("if (!active || !status || !status.connected) return undefined;"));
ok('aviso si la última sincronización tiene más de 2 min', kcSrc.includes('más de 2 minutos') && kcSrc.includes('2 * 60 * 1000'));
ok('historial de apuestas reales en §3', kcSrc.includes('Historial de mis apuestas'));
ok('resultado por realizedPnl, y "sin dato" si Kalshi no lo devuelve', kcSrc.includes('realizedPnl') && kcSrc.includes('Sin dato: Kalshi no devolvió el P&amp;L realizado'));
ok('historial muestra los fills', kcSrc.includes('Operaciones (fills) más recientes'));
ok('sin historial, lo dice en vez de inventar', kcSrc.includes('Sin historial: Kalshi no devolvió posiciones cerradas ni operaciones'));
ok('kalshi.js ya no dice "sin conexión a la cuenta de Kalshi"', !kalshiSrc.includes('sin conexión a la cuenta'));
ok('kalshi.js dice que desde v12 sí hay conexión solo lectura', kalshiSrc.includes('Desde v12 la app SÍ se conecta'));
ok('kalshi.js dice que desde v13.2 sí hay precios oficiales en centavos', kalshiSrc.includes('desde v13.2 SÍ muestra los precios oficiales'));
const marketsHandler = serverAppSrc.slice(serverAppSrc.indexOf("app.get('/api/markets'"));
ok('servidor: markets primaria Coinbase en paralelo', marketsHandler.indexOf('marketsCoinbaseParallel(cur)') < marketsHandler.indexOf('marketsKrakenBatch(cur)'));
ok('servidor: comentario v13.4 de una sola fuente 24h', serverAppSrc.includes('UNA SOLA FUENTE para el cambio 24h'));
ok('servidor Kalshi devuelve los fills normalizados', kalshiServerSrc.includes('fills: fillsOut') && kalshiServerSrc.includes('fillsOut'));

// ---------- 5. Versión ----------
console.log('— versión —');
ok('VERSION.txt empieza por v13.4', versionTxt.startsWith('v13.4'));
ok('VERSION_LABEL v13.4 en App.jsx', appSrc.includes("VERSION_LABEL = 'v13.4"));

// ---------- 1 y 3 [vivo]: velas reales + cambio 24h unificado ----------
console.log('— [vivo] velas reales 15m y cambio 24h unificado —');
if (!(await serverUp())) {
  skip('servidor local en 3001 no responde: velas reales y cambio 24h');
} else {
  const c15 = await (await fetch(BASE + '/api/candles?symbol=BTC&currency=USD&interval=15m')).json();
  const candles = c15.candles || [];
  ok('velas 15m reales del servidor (≥100)', candles.length >= 100, `n=${candles.length}`);
  const newHist = evaluateWindowSignal(candles, 10);
  const oldHist = signalHistory(candles, 10);
  ok('hay ventanas con señal clara para medir', newHist.length > 0, `n=${newHist.length}`);
  // Cada fila nueva: won = cierre vs apertura de ESA ventana.
  const rowsOk = newHist.every((h) => {
    const expectWon = h.key === 'buy' ? h.close > h.open : h.close < h.open;
    const expectPct = ((h.close - h.open) / h.open) * 100;
    return h.won === expectWon && Math.abs(h.changePct - expectPct) < 1e-9 && h.basis === 'window-close-vs-open' && h.nextPrice === null;
  });
  ok('cada fila nueva cumple won = cierre vs apertura de su ventana', rowsOk, JSON.stringify(newHist.slice(0, 2)));
  // La última vela (ventana en curso) no se cuenta.
  const lastTime = candles[candles.length - 1].time;
  ok('la ventana en curso (última vela) no entra en el historial', newHist.every((h) => h.time < lastTime));
  // Backtest recontado a mano sobre la misma cola que usa la función.
  const tail = candles.slice(-(120 + 31));
  let wins = 0, total = 0;
  for (let i = 30; i < tail.length - 1; i++) {
    const a = analyze(tail.slice(0, i + 1));
    if (a.label === 'Sin señal clara') continue;
    total++;
    const up = a.label === 'Posible subida';
    if (up ? tail[i].close > tail[i].open : tail[i].close < tail[i].open) wins++;
  }
  const bt = backtestWindowSignal(candles);
  ok('backtest 15m recontado a mano coincide', bt.total === total && bt.wins === wins, `función ${bt.wins}/${bt.total} vs manual ${wins}/${total}`);
  // La medida vieja discrepa de la nueva en al menos una ventana:
  // es la evidencia de que el fallo metodológico cambiaba el resultado.
  let disagree = 0, clear = 0;
  const tail181 = candles.slice(-181);
  for (let i = 30; i < tail181.length - 1; i++) {
    const a = analyze(tail181.slice(0, i + 1));
    if (a.label === 'Sin señal clara') continue;
    clear++;
    const up = a.label === 'Posible subida';
    const wonOld = up ? tail181[i + 1].close > tail181[i].close : tail181[i + 1].close < tail181[i].close;
    const wonNew = up ? tail181[i].close > tail181[i].open : tail181[i].close < tail181[i].open;
    if (wonOld !== wonNew) disagree++;
  }
  ok('la medida vieja (vela siguiente) discrepa de la nueva en ≥1 ventana', clear > 0 && disagree >= 1, `claras=${clear} discrepancias=${disagree}`);
  console.log(`    (medición 13-nov-2026: vieja ${backtestSignal(candles).wins}/${backtestSignal(candles).total} = ${backtestSignal(candles).pct}% · nueva ${bt.wins}/${bt.total} = ${bt.pct}%)`);
  // Cambio 24h unificado: ticker y markets, mismo BTC, misma fuente.
  const [t, m] = await Promise.all([
    (await fetch(BASE + '/api/ticker?symbol=BTC&currency=USD')).json(),
    (await fetch(BASE + '/api/markets?currency=USD')).json(),
  ]);
  const mb = (m.markets || []).find((x) => x.symbol === 'BTC');
  ok('ticker BTC viene de Coinbase', t.source === 'Coinbase', `source=${t.source}`);
  ok('grid Mercados BTC viene de Coinbase', mb && mb.source === 'Coinbase', `source=${mb && mb.source}`);
  ok('ticker y Mercados usan la misma apertura 24h', t.open24h != null && mb && t.open24h === mb.open24h, `ticker open=${t.open24h} markets open=${mb && mb.open24h}`);
  const diff = Math.abs((t.change24h ?? 0) - (mb.change24h ?? 0));
  ok('cambio 24h BTC coincide (diferencia < 0,5 puntos)', diff < 0.5, `ticker=${t.change24h} markets=${mb && mb.change24h} diff=${diff}`);
  console.log(`    (BTC ticker ${t.change24h?.toFixed(2)}% · Mercados ${mb.change24h?.toFixed(2)}% · diff ${diff.toFixed(3)} puntos)`);
}

console.log(`\ntests-v13.4: ${pass} pasaron, ${fail} fallaron${skipped ? `, ${skipped} saltados (sin servidor)` : ''}`);
if (fail > 0) process.exit(1);
