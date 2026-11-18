// tests-v15.1.mjs — verificación punto por punto de la auditoría externa
// de v15 y corrección SOLO de lo verificado como real. NO se reemplazó
// ningún archivo con el código pegado (el kalshi.js pegado era una
// versión recortada y le faltaban funciones que App.jsx usa).
// Uso: node tests-v15.1.mjs (después de npm --prefix client run build)
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { cashOutDecision, cashOutDecisionReal, estimateSettlementPnl, liveDecision } from './client/src/kalshi.js';
import { frontendSrc } from './frontendSrc.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const app = src('client/src/App.jsx');
const frontend = frontendSrc();
const kc = src('client/src/KalshiConnect.jsx');
const kalshi = src('client/src/kalshi.js');
const brtiServer = src('server/brti.js');
const kalshiServer = src('server/kalshiServer.js');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

// --- FALLO 1: VERDADERO en sustancia (texto suelto), FALSO "rompe el build" ---
// Había texto duplicado fuera del comentario {/* */} tras §5 (App.jsx ~1511):
// el build pasaba con un aviso de esbuild ("}" no válido en JSX) y el
// texto se veía en pantalla. Corregido: texto duplicado eliminado.
console.log('FALLO 1 — texto suelto tras el comentario de §5 (VERDADERO, build solo avisaba)');
check('el texto "Sin botones de intervalo" aparece UNA sola vez (dentro del comentario)', (frontend.match(/Sin botones\s+de intervalo/g) || []).length === 1);
check('no queda el cierre suelto "llegaron. */}" seguido de texto duplicado', !/llegaron\. \*\/}\s*\n\s*Sin botones/.test(frontend));
check('el comentario de §5 sigue (no se borró de más)', frontend.includes('v15: §5 GRÁFICA'));

// --- FALLO 2: FALSO — el P&L del NO ya era correcto ---
// El precio actual es el precio DEL LADO que tienes: el servidor
// (kalshiServer.js) calcula curPrice = yes ? yesPrice : 100 - yesPrice,
// y avgPrice sale de los fills de ese mismo lado. (cur-avg)*count es
// correcto para SÍ y para NO. La auditoría asumía que cur era el precio SÍ.
console.log('FALLO 2 — P&L del NO (FALSO: ya era sensible al lado)');
check('el servidor convierte el precio NO como 100 - yesPrice', kalshiServer.includes("side === 'no' ? (yesPrice != null ? 100 - yesPrice : null)"));
check('la tabla documenta que currentPrice es el precio del lado que tienes', kc.includes('currentPrice es el precio del lado que tienes'));
check('NO: medio 80¢, actual 90¢ (lado NO), 10 contratos → P&L +$1.00',
  (() => { const d = cashOutDecisionReal({ dir: 'down', entryPriceCents: 80, currentPriceCents: 90, count: 10, signalKey: 'wait', signalScore: 0 }); return d && Math.abs(d.pnl - 1) < 0.001; })());
check('NO: medio 80¢, actual 60¢ (lado NO), 10 contratos → P&L −$2.00',
  (() => { const d = cashOutDecisionReal({ dir: 'down', entryPriceCents: 80, currentPriceCents: 60, count: 10, signalKey: 'wait', signalScore: 0 }); return d && Math.abs(d.pnl + 2) < 0.001; })());
check('SÍ: medio 20¢, actual 90¢, 10 contratos → P&L +$7.00 (no cambia)',
  (() => { const d = cashOutDecisionReal({ dir: 'up', entryPriceCents: 20, currentPriceCents: 90, count: 10, signalKey: 'wait', signalScore: 0 }); return d && Math.abs(d.pnl - 7) < 0.001; })());
check('P&L estimado de liquidación NO: avg60s bajo objetivo (gana NO), medio 80¢, 10 → +$2.00',
  (() => { const r = estimateSettlementPnl({ dir: 'down', targetPrice: 65000, avg60s: 64900, avgPriceCents: 80, count: 10 }); return r && Math.abs(r.pnlUsd - 2) < 0.001; })());
check('P&L estimado de liquidación NO: avg60s sobre objetivo (pierde NO), medio 80¢, 10 → −$8.00',
  (() => { const r = estimateSettlementPnl({ dir: 'down', targetPrice: 65000, avg60s: 65100, avgPriceCents: 80, count: 10 }); return r && Math.abs(r.pnlUsd + 8) < 0.001; })());

// --- FALLO 3: FALSO — entryPrice ya estaba validado ---
// Number('') = 0 y Number('abc') = NaN; cashOutDecision guarda
// (!entryPrice → SIN POSICIÓN) y el botón de guardar bloquea
// (!kalshiEntryNum || <= 0). fmt(NaN) = '—'. No hay comparación
// entryPrice vs objetivo de Kalshi en el código.
console.log('FALLO 3 — entryPrice "" / NaN (FALSO: ya validado)');
check('entryPrice "" → cashOutDecision SIN POSICIÓN (no NaN)',
  cashOutDecision({ dir: 'up', entryPrice: Number(''), currentPrice: 70000, amount: 100, signalKey: 'up', signalScore: 30 }).key === 'none');
check('entryPrice "abc" (NaN) → cashOutDecision SIN POSICIÓN',
  cashOutDecision({ dir: 'up', entryPrice: Number('abc'), currentPrice: 70000, amount: 100, signalKey: 'up', signalScore: 30 }).key === 'none');
check('el botón de guardar bloquea entrada 0/NaN', app.includes('if (!kalshiEntryNum || kalshiEntryNum <= 0'));
check('no hay comparación de entryPrice contra el objetivo de Kalshi', !/kalshiEntryNum\s*[<>]=?\s*kalshiTargetPrice|kalshiTargetPrice\s*[<>]=?\s*kalshiEntryNum/.test(app));

// --- FALLO 4: PARCIALMENTE VERDADERO — dos huecos reales, corregidos ---
// La reconexión en sí NO borraba el estado (connectWs no limpia
// value/avg60s). Los huecos eran: (a) un tick sin avg_60s_data
// sobrescribía avg60s con null; (b) un error del sondeo en el
// cliente borraba todo el brti con setBrti({source:'coinbase'...}).
console.log('FALLO 4 — retención del avg60s (PARCIAL: reconexión retenía, pero un tick sin avg y un error de sondeo lo borraban)');
const brti = require('./server/brti.js');
check('mergeBrtiTick existe y se exporta', typeof brti.mergeBrtiTick === 'function');
check('tick sin avg60s RETIENE el promedio anterior (64900) y actualiza el valor',
  (() => { const m = brti.mergeBrtiTick({ value: 65000, avg60s: 64900, avg15mFinal: null, updatedAt: '2026-01-01T00:00:00.000Z', status: 'live', error: null }, { value: 65100, avg60s: null, avg15mFinal: null, receivedAt: 1763420001000 }); return m.avg60s === 64900 && m.value === 65100; })());
check('tick CON avg60s nuevo lo reemplaza',
  (() => { const m = brti.mergeBrtiTick({ value: 65000, avg60s: 64900, avg15mFinal: null, updatedAt: null, status: 'live', error: null }, { value: 65200, avg60s: 65050, avg15mFinal: null, receivedAt: 1763420002000 }); return m.avg60s === 65050 && m.value === 65200; })());
check('el handler de mensajes usa mergeBrtiTick (no asignación directa)', brtiServer.includes('mergeBrtiTick(entry.state, tick)'));
check('el handler ya NO hace "entry.state.avg60s = tick.avg60s"', !brtiServer.includes('entry.state.avg60s = tick.avg60s'));
check('el sondeo del cliente retiene el último brti de Kalshi ante un error de fetch', app.includes("setBrti((prev) => (prev && prev.source === 'kalshi'"));
check('el sondeo retenido marca el dato como desactualizado (stale: true)', app.includes("stale: true, error: 'No se pudo leer el BRTI del servidor: se mantiene el último valor conocido.'"));

// --- FALLO 5: FALSO — no hay pestañas ni reconexión por clic/nombre ---
// activeTab es una constante 'kalshi' (v14: una sola pantalla), symbol
// es 'BTC' y user solo cambia en login/logout (/me no se sondea, el
// apodo vive en localStorage). Endurecido: la dependencia es user?.id.
console.log('FALLO 5 — re-renders por [activeTab, symbol, user] (FALSO: activeTab es constante)');
check("activeTab es una constante 'kalshi', no hay pestañas", app.includes("const activeTab = 'kalshi'"));
check('el efecto BRTI depende de user?.id (no del objeto user entero)', /visibleInterval\(load, 2000\)[\s\S]{0,200}\}, \[activeTab, symbol, user\?\.id\]\)/.test(app));
check('v15.3: perfil local eliminado con la liga (sin apodo, sin cev_profile_v1 ni liga privada)', !app.includes("cev_profile_v1") && !app.includes('cev_private_league_v1') && !frontend.includes('Tu perfil local'));

// --- Error extra del código pegado: SAL AHORA en verde ---
// liveDecision devolvía SAL AHORA con color #22c55e (verde) cuando
// vas ganando y la señal va en contra. Un SALIR nunca va en verde.
console.log('Extra — color de SAL AHORA en liveDecision');
check('vas ganando + señal en contra → SAL AHORA en rojo, no en verde',
  (() => { const d = liveDecision({ winning: true, signalKey: 'down', signalScore: -30, dir: 'up', contractCents: 50 }); return d.key === 'exit' && d.color === '#ef4444'; })());
check('ningún SAL AHORA de liveDecision usa verde', !/#22c55e', reason: 'Vas ganando, pero la señal/.test(kalshi));
check('kalshi.js completo sigue: windowOutcome/cashOutDecision presentes', kalshi.includes('export function cashOutDecision(') && kalshi.includes('export function liveDecision('));

console.log('v15.1 — bundle compilado');
const distHtml = existsSync(path.join(ROOT, 'client/dist/index.html')) ? readFileSync(path.join(ROOT, 'client/dist/index.html'), 'utf8') : '';
const bundleMatch = distHtml.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/);
check('dist/index.html existe y referencia un bundle', Boolean(bundleMatch));
if (bundleMatch) {
  const bundle = readFileSync(path.join(ROOT, 'client/dist/assets', bundleMatch[1]), 'utf8');
  check('bundle distinto al de v15 (index-CgQ8m2YP.js)', bundleMatch[1] !== 'index-CgQ8m2YP.js');
  check('bundle NO trae el texto suelto "Sin botones de intervalo"', !bundle.includes('Sin botones de intervalo'));
}

console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
