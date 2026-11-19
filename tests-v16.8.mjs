// tests-v16.8.mjs — v16.8: regla 1 de liveDecision con tiempo restante.
// Pedido de Luis (18-nov ~21:20, su NO a 13¢ con 9 min por delante):
// la regla 1 — "contrato a ≤15¢ -> SAL AHORA" — disparaba igual con
// 9 minutos por delante que con 30 segundos. Ahora la regla 1 solo
// dispara si quedan 5 minutos o menos (remainingMs <= 300000) o si el
// tiempo restante es desconocido (fallback al comportamiento viejo).
// Las reglas 2-6 y su orden NO cambian.
// Uso: node tests-v16.8.mjs (después de npm --prefix client run build)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { liveDecision } from './client/src/kalshi.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const app = src('client/src/App.jsx');
const kalshi = src('client/src/kalshi.js');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

// Caso real de Luis: NO a 13¢, BRTI en contra (winning:false), señal
// a favor (SUBE, puntuación 45). Sin la regla 1, cae a AGUANTA CON
// CUIDADO (regla 6): la señal sigue a tu favor, pero vas perdiendo.
const casoLuis = { winning: false, signalKey: 'up', signalScore: 45, dir: 'up', contractCents: 13 };

console.log('v16.8 — (a) 13¢ con 9 min por delante (540000 ms): la regla 1 NO dispara');
check('13¢ + 9 min -> AGUANTA CON CUIDADO, no SAL AHORA',
  liveDecision({ ...casoLuis, remainingMs: 540000 }).label === 'AGUANTA CON CUIDADO');
check('13¢ + 9 min -> key hold-careful (regla 6), no exit',
  liveDecision({ ...casoLuis, remainingMs: 540000 }).key === 'hold-careful');

console.log('v16.8 — (b) 13¢ con 3 min por delante (180000 ms): la regla 1 SÍ dispara');
check('13¢ + 3 min -> SAL AHORA por regla 1',
  liveDecision({ ...casoLuis, remainingMs: 180000 }).label === 'SAL AHORA');
check('13¢ + 3 min -> key exit',
  liveDecision({ ...casoLuis, remainingMs: 180000 }).key === 'exit');

console.log('v16.8 — (c) borde: exactamente 5 min (300000 ms) dispara, 1 ms más ya no');
check('13¢ + exactamente 300000 ms -> SAL AHORA',
  liveDecision({ ...casoLuis, remainingMs: 300000 }).label === 'SAL AHORA');
check('13¢ + 300001 ms -> NO dispara la regla 1 (cae a las demás reglas)',
  liveDecision({ ...casoLuis, remainingMs: 300001 }).label === 'AGUANTA CON CUIDADO');
check('15¢ (borde de precio) + 300000 ms -> SAL AHORA',
  liveDecision({ ...casoLuis, contractCents: 15, remainingMs: 300000 }).label === 'SAL AHORA');
check('16¢ + 300000 ms -> NO dispara la regla 1 (el precio ya no es ≤15¢)',
  liveDecision({ ...casoLuis, contractCents: 16, remainingMs: 300000 }).label === 'AGUANTA CON CUIDADO');

console.log('v16.8 — (d) tiempo desconocido: comportamiento viejo (la regla 1 dispara)');
check('13¢ sin remainingMs -> SAL AHORA (fallback)',
  liveDecision({ ...casoLuis }).label === 'SAL AHORA');
check('13¢ con remainingMs: null -> SAL AHORA (fallback)',
  liveDecision({ ...casoLuis, remainingMs: null }).label === 'SAL AHORA');
check('13¢ con remainingMs: NaN -> SAL AHORA (fallback)',
  liveDecision({ ...casoLuis, remainingMs: NaN }).label === 'SAL AHORA');
check("13¢ con remainingMs no numérico ('abc') -> SAL AHORA (fallback)",
  liveDecision({ ...casoLuis, remainingMs: 'abc' }).label === 'SAL AHORA');

console.log('v16.8 — (e) contrato >15¢ sin cambios: la regla 2 manda, no la 1');
check('50¢ + perdiendo + señal en contra -> SAL AHORA por regla 2',
  (() => { const d = liveDecision({ winning: false, signalKey: 'down', signalScore: -40, dir: 'up', contractCents: 50, remainingMs: 540000 }); return d.label === 'SAL AHORA' && d.key === 'exit'; })());
check('el reason de la regla 2 menciona el BRTI, no el precio del contrato',
  (() => { const d = liveDecision({ winning: false, signalKey: 'down', signalScore: -40, dir: 'up', contractCents: 50, remainingMs: 540000 }); return d.reason.includes('BRTI') && !d.reason.includes('¢'); })());

console.log('v16.8 — (f) reglas 2-6 intactas (casos de tests-v15.mjs)');
check('regla 2: perdiendo + señal en contra -> SAL AHORA',
  liveDecision({ winning: false, signalKey: 'down', signalScore: -40, dir: 'up', contractCents: 60, remainingMs: 540000 }).label === 'SAL AHORA');
check('regla 3: ganando + señal en contra -> SAL AHORA con la ganancia',
  liveDecision({ winning: true, signalKey: 'down', signalScore: -40, dir: 'up', contractCents: 60, remainingMs: 540000 }).label === 'SAL AHORA');
check('regla 4: ganando + señal FUERTE a favor + contrato ≤40¢ -> INVIERTE MÁS',
  liveDecision({ winning: true, signalKey: 'up', signalScore: 45, dir: 'up', contractCents: 35, remainingMs: 540000 }).label === 'INVIERTE MÁS');
check('regla 4 exige contrato barato: a 50¢ es AGUANTA, no INVIERTE MÁS',
  liveDecision({ winning: true, signalKey: 'up', signalScore: 45, dir: 'up', contractCents: 50, remainingMs: 540000 }).label === 'AGUANTA');
check('regla 5: ganando + señal a favor -> AGUANTA',
  liveDecision({ winning: true, signalKey: 'up', signalScore: 30, dir: 'up', contractCents: 60, remainingMs: 540000 }).label === 'AGUANTA');
check('regla 6: sin promedio (winning null) -> AGUANTA CON CUIDADO y lo dice por el promedio de 60 s',
  (() => { const d = liveDecision({ winning: null, signalKey: 'up', signalScore: 45, dir: 'up', contractCents: 50, remainingMs: 540000 }); return d.label === 'AGUANTA CON CUIDADO' && d.reason.includes('promedio de 60 s'); })());
check('regla 6: perdiendo + señal a favor -> AGUANTA CON CUIDADO (mixto)',
  liveDecision({ winning: false, signalKey: 'up', signalScore: 45, dir: 'up', contractCents: 50, remainingMs: 540000 }).label === 'AGUANTA CON CUIDADO');

console.log('v16.8 — (g) App.jsx pasa el tiempo restante a liveDecision');
check('la llamada a liveDecision en App.jsx pasa remainingMs: kalshiWin.remainingMs',
  (() => { const i = app.indexOf('liveDecision({'); if (i < 0) return false; return app.slice(i, i + 800).includes('remainingMs: kalshiWin.remainingMs'); })());

console.log('v16.8 — (h) el reason de la regla 1 con tiempo conocido menciona el tiempo restante');
check('13¢ + 3 min: el reason menciona el tiempo que queda ("quedan 03:00 para el cierre")',
  (() => { const d = liveDecision({ ...casoLuis, remainingMs: 180000 }); return d.reason.includes('quedan 03:00 para el cierre'); })());
check('13¢ + 3 min: el reason con tiempo difiere del reason sin tiempo',
  liveDecision({ ...casoLuis, remainingMs: 180000 }).reason !== liveDecision({ ...casoLuis }).reason);

console.log('v16.8 — firma: liveDecision acepta remainingMs');
check('kalshi.js: liveDecision desestructura remainingMs',
  kalshi.includes('remainingMs') && /export function liveDecision\(\{[^}]*remainingMs/.test(kalshi));

console.log(`\ntests-v16.8.mjs: ${pass} pasaron, ${fail} fallaron.`);
process.exit(fail ? 1 : 0);
