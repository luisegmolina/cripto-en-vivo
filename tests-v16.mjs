// tests-v16.mjs — Verificación de la reestructuración y rediseño v16.0 (Terminal Táctica Kalshi 15m)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { analyze } from './client/src/analysis.js';
import { detectMarketMovement, buildBetPlan, marketRecommendation, liveDecision } from './client/src/kalshi.js';
import { frontendSrc, mainReturnSrc } from './frontendSrc.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(ROOT, 'client/src/App.jsx'), 'utf8');
const css = readFileSync(path.join(ROOT, 'client/src/index.css'), 'utf8');
const decision = readFileSync(path.join(ROOT, 'client/src/components/Decision.jsx'), 'utf8');
const signals = readFileSync(path.join(ROOT, 'client/src/components/Signals.jsx'), 'utf8');
const liveRef = readFileSync(path.join(ROOT, 'client/src/components/LiveReference.jsx'), 'utf8');
const mainReturn = mainReturnSrc();

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('v16.0 — 1. Limpieza de CSS y nueva arquitectura visual (Terminal Táctica)');
check('index.css define las variables del tema oscuro táctico (--bg-main, --up, --down) y clases .hero-decision, .bet-grid, .tf-matrix',
  css.includes('--bg-main') && css.includes('.hero-decision') && css.includes('.bet-grid') && css.includes('.tf-matrix'));
check('index.css eliminó las clases muertas (.tape, .heatmap, .achievements, .mood-bar, .screener)',
  !css.includes('.tape-track') && !css.includes('.heatmap') && !css.includes('.achievements') && !css.includes('.mood-bar') && !css.includes('.screener'));

console.log('v16.0 — 2. Hero de Decisión y Apuesta con KPIs de contrato SÍ/NO, ventaja EV y plan operativo');
check('Decision.jsx renderiza .bet-grid con las 3 tarjetas KPI (apuesta, precio/ventaja y plan operativo)',
  decision.includes('className="bet-grid"') && decision.includes('Cuál debería ser tu apuesta en Kalshi:') && decision.includes('Precio y ventaja del contrato:'));
check('Signals.jsx presenta la matriz visual de 4 temporalidades (.tf-matrix) y pliega el simulador manual en <details>',
  signals.includes('className="tf-matrix"') && signals.includes('<details className="account-details">'));
check('App.jsx incluye serie EMA 9 rápida en el gráfico junto a EMA 20, EMA 50 y Bollinger',
  app.includes('ema9Series') && app.includes("emaSeries(closes, 9)"));
check('Orden de bloques principales intacto y limpio',
  mainReturn.indexOf('1 · Mi posición en vivo') < mainReturn.indexOf('2 · Decisión') &&
  mainReturn.indexOf('2 · Decisión') < mainReturn.indexOf('3 · Referencia en tiempo real') &&
  mainReturn.indexOf('3 · Referencia en tiempo real') < mainReturn.indexOf('4 · Radar de Señales'));

console.log('v16.0 — 3. Precisión del motor de movimientos y apuestas');
const bull = Array.from({ length: 60 }, (_, i) => ({
  time: 1700000000 + i * 900,
  open: 70000 + i * 22,
  high: 70025 + i * 22,
  low: 69990 + i * 22,
  close: 70018 + i * 22,
  volume: 15,
}));
const aBull = analyze(bull);
const mov = detectMarketMovement({
  candles15m: bull,
  mtfAnalysis: { '1m': { score: 45 }, '5m': { score: 40 }, '15m': aBull, '1h': { score: 30 } },
  spotPrice: 71350,
  targetPrice: 71250,
  brtiAvg60s: 71340,
  atr15m: 140,
});
const plan = buildBetPlan({
  marketRec: marketRecommendation({ signalKey: 'up' }),
  movement: mov,
  kalshiScore: aBull.score,
  kalshiProbAdj: 70,
  kalshiMarket: { source: 'kalshi', yesAskCents: 44, noAskCents: 57 },
  brtiDiff: 90,
  kalshiAtr: 140,
});
check('Motor detecta impulso alcista y construye plan SÍ a 44¢ con ganancia +56¢ (+127% ROI) y EV +$0.26',
  mov.dir === 'up' && plan.contractCode === 'YES' && plan.profitCents === 56 && plan.roiPct === 127 && Math.abs(plan.evPerContractUsd - 0.26) < 0.01);
check('liveDecision funciona para posición abierta ganadora y perdedora',
  liveDecision({ winning: true, signalKey: 'up', signalScore: 45, dir: 'up', contractCents: 35 }).key === 'add' &&
  liveDecision({ winning: false, signalKey: 'down', signalScore: -40, dir: 'up', contractCents: 50 }).key === 'exit');

console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
