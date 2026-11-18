// tests-v15.mjs — v15: referencia en vivo primero (§1-§5) + CORRECCIÓN:
// ganar/perder y la decisión SOLO con el promedio de 60 s del BRTI,
// nunca con el tick instantáneo.
// Uso: node tests-v15.mjs (después de npm --prefix client run build)
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { brtiWinning, brtiPositionOutcome, estimateSettlementPnl, liveDecision } from './client/src/kalshi.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const app = src('client/src/App.jsx');
const kc = src('client/src/KalshiConnect.jsx');
const kalshi = src('client/src/kalshi.js');
const routes = src('server/routes.js');
const brtiServer = src('server/brti.js');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const TARGET = 70487.89;

console.log('CORRECCIÓN v15 — solo el promedio de 60 s liquida (nunca el tick instantáneo)');
check('sin avg60s = null aunque el valor instantáneo esté por encima (CORRECCIÓN)',
  brtiWinning({ dir: 'up', targetPrice: TARGET, avg60s: null, value: 70500 }) === null);
check('sin avg60s = null aunque el valor instantáneo esté por debajo',
  brtiWinning({ dir: 'down', targetPrice: TARGET, avg60s: null, value: 70400 }) === null);
check('con avg60s manda el promedio, no el valor: SUBE + avg 70500 >= objetivo = GANANDO aunque el tick esté por debajo',
  (() => { const r = brtiWinning({ dir: 'up', targetPrice: TARGET, avg60s: 70500, value: 70400 }); return r && r.winning === true && r.refLabel === 'avg60s'; })());
check('con avg60s manda el promedio: SUBE + avg 70400 < objetivo = PERDIENDO aunque el tick esté por encima',
  brtiWinning({ dir: 'up', targetPrice: TARGET, avg60s: 70400, value: 70500 }).winning === false);
check('BAJA + avg 70400 < objetivo = GANANDO', brtiWinning({ dir: 'down', targetPrice: TARGET, avg60s: 70400, value: 70500 }).winning === true);
check('SUBE + avg == objetivo exacto = GANANDO (>= liquida SÍ)',
  brtiWinning({ dir: 'up', targetPrice: TARGET, avg60s: TARGET, value: TARGET }).winning === true);
check('diff se calcula con el promedio (avg 70500 vs 70487.89 = +12.11)',
  (() => { const r = brtiWinning({ dir: 'up', targetPrice: TARGET, avg60s: 70500, value: 70500 }); return r && Math.abs(r.diff - 12.11) < 0.01; })());
check('brtiPositionOutcome sin avg60s = null (no se inventa)',
  brtiPositionOutcome({ dir: 'up', targetPrice: TARGET, avg60s: null, value: 70500 }) === null);
check('brtiPositionOutcome: cerca de la línea si |diff| <= 30 $',
  (() => { const r = brtiPositionOutcome({ dir: 'up', targetPrice: TARGET, avg60s: TARGET + 20, value: TARGET + 20 }); return r && r.nearLine === true && r.winning === true; })());
check('brtiPositionOutcome: lejos de la línea si |diff| > 30 $',
  (() => { const r = brtiPositionOutcome({ dir: 'up', targetPrice: TARGET, avg60s: TARGET + 100, value: TARGET + 100 }); return r && r.nearLine === false; })());
check('estimateSettlementPnl sin avg60s = null (el tick no liquida)',
  estimateSettlementPnl({ dir: 'up', targetPrice: TARGET, avg60s: null, value: 70500, avgPriceCents: 40, count: 10 }) === null);
check('estimateSettlementPnl ganando: vale $1 -> (100-40)*10/100 = +$6.00',
  (() => { const r = estimateSettlementPnl({ dir: 'up', targetPrice: TARGET, avg60s: 70500, value: 70500, avgPriceCents: 40, count: 10 }); return r && r.estValueCents === 100 && Math.abs(r.pnlUsd - 6) < 0.001; })());
check('estimateSettlementPnl perdiendo: vale $0 -> (0-40)*10/100 = -$4.00',
  (() => { const r = estimateSettlementPnl({ dir: 'up', targetPrice: TARGET, avg60s: 70400, value: 70400, avgPriceCents: 40, count: 10 }); return r && r.estValueCents === 0 && Math.abs(r.pnlUsd + 4) < 0.001; })());

console.log('v15 — DECISIÓN: SAL AHORA / AGUANTA / INVIERTE MÁS (liveDecision)');
check('contrato ≤15¢ -> SAL AHORA aunque el BRTI vaya a favor',
  liveDecision({ winning: true, signalKey: 'up', signalScore: 50, dir: 'up', contractCents: 12 }).label === 'SAL AHORA');
check('perdiendo + señal en contra -> SAL AHORA',
  liveDecision({ winning: false, signalKey: 'down', signalScore: -40, dir: 'up', contractCents: 50 }).label === 'SAL AHORA');
check('ganando + señal en contra -> SAL AHORA con la ganancia',
  liveDecision({ winning: true, signalKey: 'down', signalScore: -40, dir: 'up', contractCents: 60 }).label === 'SAL AHORA');
check('ganando + señal fuerte a favor + contrato ≤40¢ -> INVIERTE MÁS',
  liveDecision({ winning: true, signalKey: 'up', signalScore: 45, dir: 'up', contractCents: 35 }).label === 'INVIERTE MÁS');
check('INVIERTE MÁS exige contrato barato: a 50¢ es AGUANTA, no INVIERTE MÁS',
  liveDecision({ winning: true, signalKey: 'up', signalScore: 45, dir: 'up', contractCents: 50 }).label === 'AGUANTA');
check('INVIERTE MÁS exige señal fuerte: score 30 es AGUANTA',
  liveDecision({ winning: true, signalKey: 'up', signalScore: 30, dir: 'up', contractCents: 35 }).label === 'AGUANTA');
check('ganando + señal a favor -> AGUANTA',
  liveDecision({ winning: true, signalKey: 'up', signalScore: 30, dir: 'up', contractCents: 60 }).label === 'AGUANTA');
check('perdiendo + señal a favor -> AGUANTA CON CUIDADO (mixto)',
  liveDecision({ winning: false, signalKey: 'up', signalScore: 45, dir: 'up', contractCents: 50 }).label === 'AGUANTA CON CUIDADO');
check('sin promedio (winning null) -> AGUANTA CON CUIDADO y lo dice por el promedio de 60 s',
  (() => { const d = liveDecision({ winning: null, signalKey: 'up', signalScore: 45, dir: 'up', contractCents: 50 }); return d.label === 'AGUANTA CON CUIDADO' && d.reason.includes('promedio de 60 s'); })());
check('sin señal clara + perdiendo -> AGUANTA CON CUIDADO, no SAL inventado',
  liveDecision({ winning: false, signalKey: 'wait', signalScore: 0, dir: 'up', contractCents: 50 }).label === 'AGUANTA CON CUIDADO');

console.log('v15 — pantalla en orden §1-§5, lo primero arriba');
const mainReturn = app.slice(app.lastIndexOf('  return (\n    <div className="app">'));
const i1 = mainReturn.indexOf('1 · Referencia en tiempo real');
const i2 = mainReturn.indexOf('2 · Mi posición en vivo');
const i3 = mainReturn.indexOf('3 · Decisión');
const i4 = mainReturn.indexOf('4 · Señales del mercado');
const i5 = mainReturn.indexOf('5 · Gráfica · BTC 15m');
check('orden §1 < §2 < §3 < §4 < §5', i1 > 0 && i1 < i2 && i2 < i3 && i3 < i4 && i4 < i5);
check('§1: etiquetas claras "BRTI ahora" y "Promedio de 60 s (el que liquida)"',
  mainReturn.includes('BRTI ahora') && mainReturn.includes('Promedio de 60 s (el que liquida)'));
check('§1: explica que el objetivo es el promedio de 60 s antes de la apertura y el cierre se compara con el promedio antes del cierre',
  mainReturn.includes('el objetivo es el promedio de 60 s antes de la apertura') && mainReturn.includes('el cierre se compara contra ese objetivo con el promedio de 60 s antes del cierre'));
check('§1: NUNCA se usa el valor instantáneo como liquidación (sin fallback en el código)',
  !app.includes('avg60s != null ? brti.avg60s : brti.value') && !app.includes('se usa el valor en vivo'));
check('§1: referencia solo con promedio (brtiRefPrice = avg60s o null)',
  app.includes("brti.avg60s != null ? brti.avg60s : null"));
check('§1: si no hay promedio, lo dice (sin diferencia ni ganar/perder inventados)',
  mainReturn.includes('Promedio de 60 s no disponible'));
check('§1: cuenta atrás, objetivo y SÍ/NO en la referencia',
  mainReturn.includes('Cierra en') && mainReturn.includes('Precio objetivo (Kalshi)') && mainReturn.includes('Precio SÍ / NO (Kalshi)'));
check('§2: posición real con lado, apuesta, medio, cantidad y P&L estimado según BRTI',
  mainReturn.includes('Mi posición en vivo') && mainReturn.includes('P&L estimado si la ventana cerrara ahora según BRTI') && mainReturn.includes('Precio medio') && mainReturn.includes('Apuesta:'));
check('§2: avisos VAS GANANDO / VAS PERDIENDO / PUEDES PERDER',
  mainReturn.includes('VAS GANANDO según BRTI') && mainReturn.includes('VAS PERDIENDO según BRTI') && mainReturn.includes('PUEDES PERDER'));
check('§2: sin posición abierta, lo dice y no inventa',
  mainReturn.includes('Sin posición abierta en Kalshi ahora mismo'));
check('§3: SAL AHORA / AGUANTA / INVIERTE MÁS + aviso de más riesgo + sugerencia educativa',
  mainReturn.includes('SAL AHORA') && mainReturn.includes('AGUANTA') && mainReturn.includes('INVIERTE MÁS') && mainReturn.includes('Invertir más aumenta el riesgo') && mainReturn.includes('Sugerencia educativa, nunca una orden'));
check('§3: sin posición no hay decisión inventada',
  mainReturn.includes('Sin posición abierta en Kalshi ahora mismo: no hay decisión que tomar'));
check('§4: veredicto SUBE/BAJA/ESPERAR con fuerza, confianza y porqué',
  mainReturn.includes('verdict-main') && mainReturn.includes('Fuerza:') && mainReturn.includes('Confianza (confluencia)'));
check('§5: gráfica BTC 15m al final, con chartRef',
  mainReturn.includes('5 · Gráfica · BTC 15m') && mainReturn.includes('<div ref={chartRef} className="chart" />'));

console.log('v15 — actualización rápida solo para §1-§2');
check('BRTI se sondea cada 2 s (no 3 s)', app.includes("setInterval(load, 2000)") && app.includes("apiAuth('/api/kalshi/brti')"));
check('mercado Kalshi (objetivo + SÍ/NO) cada 15 s (caché del servidor)', app.includes('setInterval(load, 15000)') && app.includes("api('/api/kalshi-market')"));
check('posiciones se refrescan cada 30 s (KalshiConnect) y el P&L se recalcula con cada tick BRTI',
  kc.includes('30000') && mainReturn.includes('el P&L se recalcula con cada tick BRTI (cada 2 s)'));
check('fallback: "Sin valor en vivo de Kalshi" + precio de Coinbase con aviso, nunca en blanco',
  mainReturn.includes('Sin valor en vivo de Kalshi') && mainReturn.includes('Precio de Coinbase ahora:'));
check('KalshiConnect sube precio medio (avgPriceCents) y admite decisión null',
  kc.includes('avgPriceCents: numOrNull(pos.avgPrice)') && kc.includes('d.decision ? d.decision.key : null'));

console.log('v15 — backend intacto, solo lectura');
check('/api/kalshi/brti sigue', routes.includes("router.get('/kalshi/brti'"));
check('/api/kalshi-market sigue', src('server/app.js').includes("app.get('/api/kalshi-market'"));
check('BRTI por WebSocket sigue (cfbenchmarks_value)', brtiServer.includes('cfbenchmarks_value'));
check('sin endpoint de órdenes', !/portfolio\/orders|trade\/orders/.test(routes + brtiServer));

console.log('v15 — bundle compilado');
const distHtml = existsSync(path.join(ROOT, 'client/dist/index.html')) ? readFileSync(path.join(ROOT, 'client/dist/index.html'), 'utf8') : '';
const bundleMatch = distHtml.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/);
check('dist/index.html existe y referencia un bundle', Boolean(bundleMatch));
if (bundleMatch) {
  const bundle = readFileSync(path.join(ROOT, 'client/dist/assets', bundleMatch[1]), 'utf8');
  check('bundle distinto al de v14 (index-Cy15LHh0.js)', bundleMatch[1] !== 'index-Cy15LHh0.js');
  check('bundle trae la etiqueta v15', bundle.includes('v15'));
  check('bundle trae "BRTI ahora" y "INVIERTE MÁS" y "PUEDES PERDER"',
    bundle.includes('BRTI ahora') && bundle.includes('INVIERTE MÁS') && bundle.includes('PUEDES PERDER'));
  check('bundle NO trae la etiqueta vieja "Valor actual Kalshi (BRTI)"',
    !bundle.includes('Valor actual Kalshi (BRTI)'));
  check('bundle NO trae "se usa el valor en vivo" (corrección)',
    !bundle.includes('se usa el valor en vivo'));
}

console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
