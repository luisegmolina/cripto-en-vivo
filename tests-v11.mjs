// Tests v11 — Modo Kalshi 15 min: funciones puras + servidor local.
// 1) Ventana de 15 min: inicio/fin/cuenta atrás correctos.
// 2) Veredicto 15m y probabilidad estimada (propia, no oficial).
// 3) Decisión cobrar/aguantar/salir según precio y señal.
// 4) Servidor local: /api/candles 15m con datos reales + veredicto 15m.
import { window15m, fmtCountdown, kalshiVerdictForScore, estimatedProb, cashOutDecision, suggestedExitPrice } from './client/src/kalshi.js';
import { analyze } from './client/src/analysis.js';
import { backtestSignal } from './client/src/backtest.js';
import fs from 'node:fs';

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
}

// --- 1) Ventana de 15 min ---
const t1 = new Date('2026-11-12T18:47:30').getTime();
const w1 = window15m(t1);
check('Ventana 18:47 -> empieza 18:45', new Date(w1.startMs).getMinutes() === 45 && new Date(w1.startMs).getHours() === 18);
check('Ventana 18:47 -> termina 19:00', new Date(w1.endMs).getMinutes() === 0 && new Date(w1.endMs).getHours() === 19);
check('Ventana 18:47:30 -> faltan 12:30', w1.remainingMs === 12 * 60 * 1000 + 30 * 1000, `${w1.remainingMs} ms`);
check('Cuenta atrás 750000 ms -> 12:30', fmtCountdown(750000) === '12:30');
check('Ventana 18:47:30 -> 16,67% transcurrida (2,5 de 15 min)', Math.abs(w1.elapsedPct - 16.6667) < 0.01, `${w1.elapsedPct}%`);
const w2 = window15m(new Date('2026-11-12T19:00:00').getTime());
check('Ventana en punto 19:00 -> empieza 19:00, faltan 15:00', new Date(w2.startMs).getMinutes() === 0 && w2.remainingMs === 900000);
const w3 = window15m(new Date('2026-11-12T18:59:59').getTime());
check('Ventana 18:59:59 -> falta 1 s', w3.remainingMs === 1000, `${w3.remainingMs} ms`);

// --- 2) Veredicto 15m + probabilidad estimada ---
check('Score +40 -> SUBE', kalshiVerdictForScore(40).key === 'up' && kalshiVerdictForScore(40).label === 'SUBE');
check('Score -40 -> BAJA', kalshiVerdictForScore(-40).key === 'down' && kalshiVerdictForScore(-40).label === 'BAJA');
check('Score 0 -> ESPERAR', kalshiVerdictForScore(0).key === 'wait');
check('Prob. estimada: score 0 -> 50%', estimatedProb(0, 0) === 50);
check('Prob. estimada: score fuerte -> entre 50% y 85%, nunca 100%', estimatedProb(80, 1) > 50 && estimatedProb(80, 1) <= 85, `${estimatedProb(80, 1)}%`);
check('Prob. estimada crece con la fuerza', estimatedProb(60, 1) > estimatedProb(20, 0));

// --- 3) Decisión cobrar / aguantar / salir ---
const base = { dir: 'up', entryPrice: 73000, currentPrice: 73500, amount: 100, signalKey: 'up', signalScore: 40, entryScore: 30 };
check('Ganando + señal a favor -> AGUANTA', cashOutDecision(base).key === 'hold', cashOutDecision(base).label);
check('Ganando + señal en contra -> COBRA AHORA',
  cashOutDecision({ ...base, signalKey: 'down', signalScore: -40 }).key === 'cash');
check('Ganando + señal debilitada (40 -> 10) -> COBRA AHORA',
  cashOutDecision({ ...base, signalScore: 10, entryScore: 40 }).key === 'cash');
check('Perdiendo + señal en contra -> SAL ANTES DE PERDER MÁS',
  cashOutDecision({ ...base, currentPrice: 72500, signalKey: 'down', signalScore: -40 }).key === 'exit');
check('Perdiendo + señal a favor -> AGUANTA CON CUIDADO',
  cashOutDecision({ ...base, currentPrice: 72500 }).key === 'hold-careful');
check('Sin señal clara -> ESPERA',
  cashOutDecision({ ...base, signalKey: 'wait', signalScore: 0 }).key === 'wait');
check('Sin posición -> SIN POSICIÓN',
  cashOutDecision({ dir: 'up', entryPrice: null, currentPrice: 73500, amount: 100, signalKey: 'up', signalScore: 40 }).key === 'none');
check('Ganando: P&L virtual +$0.68 con $100 (+0.68%)',
  Math.abs(cashOutDecision(base).pnl - 0.6849) < 0.01 && Math.abs(cashOutDecision(base).pnlPct - 0.6849) < 0.01,
  JSON.stringify(cashOutDecision(base)));
check('Apuesta a la baja ganando: precio baja -> P&L positivo',
  cashOutDecision({ dir: 'down', entryPrice: 73000, currentPrice: 72500, amount: 100, signalKey: 'down', signalScore: -40 }).pnl > 0);
check('Precio sugerido: COBRA -> precio actual',
  suggestedExitPrice({ decisionKey: 'cash', currentPrice: 73500, entryPrice: 73000, dir: 'up', atr15m: 50 }) === 73500);
check('Precio sugerido: AGUANTA -> entrada + 1 ATR',
  suggestedExitPrice({ decisionKey: 'hold', currentPrice: 73500, entryPrice: 73000, dir: 'up', atr15m: 50 }) === 73050);

// --- 4) Código: modo Kalshi presente en App.jsx ---
const src = fs.readFileSync('./client/src/App.jsx', 'utf8');
check('Código: interruptor Modo Kalshi 15 min', src.includes('Modo Kalshi 15 min'));
check('Código: la app NO dice que sea la probabilidad oficial de Kalshi', src.includes('NO es la probabilidad oficial de Kalshi'));
check('Código: sin integración con la API real de Kalshi', !src.includes('api.kalshi') && !src.includes('kalshi.com'));
check('Código: modo pone 15m como principal', src.includes("setCandleInterval(kalshiMode ? '15m' : '1h')"));
check('Código: sección ¿Cobro o me quedo?', src.includes('¿Cobro o me quedo?'));

// --- 5) Servidor local con datos reales ---
const BASE = 'http://localhost:3001';
const j = async (u) => { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => null) }; };
const health = await j(`${BASE}/api/health`);
check('Servidor local: /api/health OK', health.status === 200 && health.body && health.body.ok === true);
const tick = await j(`${BASE}/api/ticker?symbol=BTC&currency=USD`);
check('Servidor local: /api/ticker BTC real > 0', tick.status === 200 && tick.body && tick.body.price > 1000, `precio ${tick.body && tick.body.price}`);
console.log(`   BTC ahora: $${tick.body.price} vía ${tick.body.source}`);
const c15 = await j(`${BASE}/api/candles?symbol=BTC&currency=USD&interval=15m`);
check('Servidor local: /api/candles 15m con velas reales', c15.status === 200 && c15.body && Array.isArray(c15.body.candles) && c15.body.candles.length >= 100,
  `velas: ${c15.body && c15.body.candles && c15.body.candles.length}`);
if (c15.body && c15.body.candles && c15.body.candles.length >= 100) {
  const a15 = analyze(c15.body.candles);
  const v15 = kalshiVerdictForScore(a15.score);
  console.log(`   Veredicto 15m BTC: ${v15.label} (score ${a15.score}, RSI ${a15.rsi ? a15.rsi.toFixed(1) : '—'})`);
  check('Veredicto 15m con velas reales: score en -100..100', a15.score >= -100 && a15.score <= 100);
  const bt15 = backtestSignal(c15.body.candles);
  check('Backtest 15m con velas reales: tiene ventanas con señal clara', bt15.total > 0, `total ${bt15.total}`);
  console.log(`   Backtest BTC 15m: acertó ${bt15.wins} de ${bt15.total} (${bt15.pct}%)`);
}

console.log(`\n${pass} pasaron, ${fail} fallaron.`);
process.exit(fail ? 1 : 0);
