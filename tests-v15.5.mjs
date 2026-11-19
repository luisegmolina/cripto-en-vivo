// tests-v15.5.mjs — Movimientos del mercado en tiempo real + plan exacto de apuesta SÍ/NO con ventaja (v15.5)
// Uso: node tests-v15.5.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { analyze } from './client/src/analysis.js';
import { reasonsFor } from './client/src/verdict.js';
import { detectMarketMovement, buildBetPlan, marketRecommendation } from './client/src/kalshi.js';
import { frontendSrc, mainReturnSrc } from './frontendSrc.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(ROOT, 'client/src/App.jsx'), 'utf8');
const decision = readFileSync(path.join(ROOT, 'client/src/components/Decision.jsx'), 'utf8');
const signals = readFileSync(path.join(ROOT, 'client/src/components/Signals.jsx'), 'utf8');
const liveRef = readFileSync(path.join(ROOT, 'client/src/components/LiveReference.jsx'), 'utf8');
const mainReturn = mainReturnSrc();
const frontend = frontendSrc();

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('v15.5 — 1. Corrección del congelamiento en vivo (App.jsx)');
check('candles15m prioriza candles (que lleva el tick de 1 s) cuando candleInterval === 15m',
  app.includes("(candleInterval === '15m' && candles.length >= 32)\n    ? candles"));
check('last15mKey usa candlesSignature(candles15m) (incluye close/high/low, no solo length:time)',
  app.includes('const last15mKey = candlesSignature(candles15m);'));
check('setMtfCandles usa candlesSignature(o[tf]) para actualizar cierres intra-vela en 1m/5m/15m/1h',
  app.includes('const sig = (o) => VERDICT_TFS.map((tf) => candlesSignature(o[tf])).join(\'|\');'));
check('VERSION_LABEL actualizado a la versión actual (v16.3) en App.jsx',
  app.includes("const VERSION_LABEL = 'v16.3"));

console.log('v15.5 — 2. Calibración de analyze() (sin sesgo inverso en RSI medio + impulso corto EMA 9/20 + 3 velas)');
{
  // Serie alcista sostenida pero moderada (RSI entre 55 y 68): antes el RSI restaba y dejaba score < 25; ahora da subida clara.
  const bullCandles = Array.from({ length: 60 }, (_, i) => {
    const base = 70000 + i * 25 + (i % 3 === 0 ? -8 : 15);
    return { time: 1700000000 + i * 900, open: base - 10, high: base + 18, low: base - 14, close: base + 12, volume: 10 + i };
  });
  const aBull = analyze(bullCandles);
  check('serie alcista clara: score >= 25 (Posible subida) y expone ema9 y momentumPct',
    aBull.score >= 25 && aBull.label === 'Posible subida' && aBull.ema9 != null && aBull.momentumPct > 0,
    `score=${aBull.score} rsi=${aBull.rsi}`);

  // Serie bajista sostenida: da bajada clara (score <= -25).
  const bearCandles = Array.from({ length: 60 }, (_, i) => {
    const base = 72000 - i * 25 + (i % 3 === 0 ? 8 : -15);
    return { time: 1700000000 + i * 900, open: base + 10, high: base + 14, low: base - 18, close: base - 12, volume: 10 + i };
  });
  const aBear = analyze(bearCandles);
  check('serie bajista clara: score <= -25 (Posible bajada)',
    aBear.score <= -25 && aBear.label === 'Posible bajada' && aBear.momentumPct < 0,
    `score=${aBear.score}`);

  // Giro alcista reciente (últimas 10 velas subiendo fuerte tras caída previa): EMA 9 > EMA 20 y momentum positivo.
  const turnUpCandles = Array.from({ length: 60 }, (_, i) => {
    const base = i < 48 ? 71000 - i * 15 : 70280 + (i - 47) * 55;
    return { time: 1700000000 + i * 900, open: base - 15, high: base + 30, low: base - 20, close: base + 25, volume: 20 };
  });
  const aTurn = analyze(turnUpCandles);
  check('giro alcista reciente: detecta EMA 9 > EMA 20 y momentum positivo sin quedarse bloqueado en bajista',
    aTurn.ema9 > aTurn.ema20 && aTurn.momentumPct > 0 && aTurn.score > 0,
    `score=${aTurn.score} ema9=${aTurn.ema9} ema20=${aTurn.ema20}`);

  const reasons = reasonsFor(aBull);
  check('reasonsFor incluye explicaciones del impulso corto (EMA 9/20 o avance de 3 velas)',
    reasons.length > 0 && reasons.some((r) => /EMA 9|3 velas|MACD|RSI/i.test(r.text)));
}

console.log('v15.5 — 3. Detector de movimientos del mercado en tiempo real (detectMarketMovement)');
{
  const sampleCandles = [
    { time: 1000, open: 70000, high: 70050, low: 69980, close: 70020, volume: 10 },
    { time: 1900, open: 70020, high: 70090, low: 70010, close: 70070, volume: 12 },
    { time: 2800, open: 70070, high: 70140, low: 70060, close: 70120, volume: 15 },
    { time: 3700, open: 70120, high: 70240, low: 70110, close: 70220, volume: 20 },
  ];
  const mtfUp = {
    '1m': { score: 42 },
    '5m': { score: 38 },
    '15m': { score: 35 },
    '1h': { score: 28 },
  };
  const movUp = detectMarketMovement({
    candles15m: sampleCandles,
    mtfAnalysis: mtfUp,
    spotPrice: 70220,
    targetPrice: 70100,
    brtiAvg60s: 70210,
    atr15m: 150,
  });
  check('detectMarketMovement alcista: dir = up, impulseScore > 0, upTfs = 4',
    movUp.dir === 'up' && movUp.impulseScore > 25 && movUp.upTfs === 4 && movUp.downTfs === 0);
  check('detectMarketMovement calcula distancia al objetivo con promedio 60s (+110 $) y múltiplo ATR (+0.73 ATR)',
    Math.abs(movUp.windowDelta - 110) < 0.01 && Math.abs(movUp.atrMultiple - (110 / 150)) < 0.01);
  check('detectMarketMovement calcula vela 15m actual (+100 $) y avance de 3 velas',
    movUp.candleDelta === 100 && movUp.roc3Pct > 0 && movUp.summary.includes('AL ALZA'));

  const movDown = detectMarketMovement({
    candles15m: sampleCandles.map((c) => ({ ...c, open: 70200, close: 70050 })),
    mtfAnalysis: { '1m': { score: -45 }, '5m': { score: -40 }, '15m': { score: -32 }, '1h': { score: -20 } },
    spotPrice: 70050,
    targetPrice: 70180,
    brtiAvg60s: 70060,
    atr15m: 150,
  });
  check('detectMarketMovement bajista: dir = down, impulseScore < -25, summary incluye A LA BAJA',
    movDown.dir === 'down' && movDown.impulseScore < -25 && movDown.summary.includes('A LA BAJA'));
}

console.log('v15.5 — 4. Plan exacto de apuesta en Kalshi (buildBetPlan: contrato SÍ/NO, ventaja/EV y desempate táctico)');
{
  const recUp = marketRecommendation({ signalKey: 'up' });
  const planUp = buildBetPlan({
    marketRec: recUp,
    movement: { dir: 'up', impulseScore: 44 },
    kalshiScore: 38,
    kalshiProbAdj: 68,
    kalshiMarket: { source: 'kalshi', yesAskCents: 45, noAskCents: 56 },
    brtiDiff: 85,
    kalshiAtr: 140,
    remainingMs: 10 * 60 * 1000,
  });
  check('señal SUBE -> recomienda Contrato SÍ (YES), calcula coste 45¢, ganancia +55¢ (+122%) y ventaja +23 pts (EV +$0.23)',
    planUp.betSide === 'up' && planUp.contractCode === 'YES' && planUp.askCents === 45 &&
    planUp.profitCents === 55 && planUp.roiPct === 122 && planUp.edgePts === 23 && Math.abs(planUp.evPerContractUsd - 0.23) < 0.001);
  check('planUp clasifica 45¢ con ventaja positiva como "Buen precio"',
    planUp.priceVerdict.includes('Buen precio'));

  const recDown = marketRecommendation({ signalKey: 'down' });
  const planDown = buildBetPlan({
    marketRec: recDown,
    movement: { dir: 'down', impulseScore: -48 },
    kalshiScore: -42,
    kalshiProbAdj: 66,
    kalshiMarket: { source: 'kalshi', yesAskCents: 60, noAskCents: 42 },
    brtiDiff: -90,
    kalshiAtr: 140,
    remainingMs: 9 * 60 * 1000,
  });
  check('señal BAJA -> recomienda Contrato NO (BAJA) a 42¢ con ganancia +58¢',
    planDown.betSide === 'down' && planDown.contractCode === 'NO' && planDown.askCents === 42 && planDown.profitCents === 58);

  // Caso clave: señal 15m aún en zona neutra (score +18 -> wait), pero el movimiento en vivo empuja al alza (impulseScore +28)
  const recWait = marketRecommendation({ signalKey: 'wait' });
  const planTactical = buildBetPlan({
    marketRec: recWait,
    movement: { dir: 'up', impulseScore: 28 },
    kalshiScore: 18,
    kalshiProbAdj: 58,
    kalshiMarket: { source: 'kalshi', yesAskCents: 48, noAskCents: 53 },
    brtiDiff: 45,
    kalshiAtr: 130,
    remainingMs: 11 * 60 * 1000,
  });
  check('cuando la señal 15m es wait pero hay impulso en vivo, buildBetPlan da apuesta táctica SÍ (SUBE) sin dejar al usuario a ciegas',
    planTactical.betSide === 'up' && planTactical.isTactical === true && planTactical.contractCode === 'YES' && planTactical.actionHeadline.includes('entrada táctica'));

  // Contrato caro (>=85¢): avisa de mal retorno/riesgo
  const planExpensive = buildBetPlan({
    marketRec: recUp,
    movement: { dir: 'up', impulseScore: 50 },
    kalshiScore: 45,
    kalshiProbAdj: 72,
    kalshiMarket: { source: 'kalshi', yesAskCents: 90, noAskCents: 11 },
  });
  check('contrato a ≥85¢ avisa que está caro (arriesgas 90¢ para ganar 10¢)',
    planExpensive.priceVerdict.includes('Caro (90¢)'));
}

console.log('v15.5 — 5. Integración en componentes (Decision.jsx, Signals.jsx, LiveReference.jsx)');
check('Decision.jsx muestra "Cuál debería ser tu apuesta en Kalshi", "Precio y ventaja del contrato" y "Movimiento del mercado ahora"',
  decision.includes('Cuál debería ser tu apuesta en Kalshi:') &&
  decision.includes('Precio y ventaja del contrato:') &&
  decision.includes('Movimiento del mercado ahora:'));
check('Signals.jsx muestra "Impulso en vivo", "Vela 15m actual", "Avance 3 velas" y "Plazos (1m / 5m / 15m / 1h)"',
  signals.includes('Impulso en vivo') && signals.includes('Vela 15m actual') &&
  signals.includes('Avance 3 velas') && signals.includes('Plazos (1m / 5m / 15m / 1h)'));
check('LiveReference.jsx muestra distancia en ATR 15m frente al objetivo',
  liveRef.includes('ATR 15m'));
check('App.jsx mantiene menos de 900 líneas',
  app.split('\n').length < 900);
check('VERSION.txt documenta v15.5 y README documenta v15.5',
  readFileSync(path.join(ROOT, 'VERSION.txt'), 'utf8').includes('v15.5') && readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes('v15.5'));

console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
