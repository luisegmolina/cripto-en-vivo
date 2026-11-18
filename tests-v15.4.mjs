// tests-v15.4.mjs — La recomendación sin posición ya no se veta por débil/conflictiva.
// Uso: node tests-v15.4.mjs (después de npm --prefix client run build)
//
// CAUSA (Luis lo pidió dos veces): en v15.3 la caja existía, pero casi
// siempre decía ESPERAR: una señal débil (acierto <50% en las últimas
// 5 ventanas) o conflictiva VETABA el lado. Como el backtest 15m ronda
// el 43-45%, el veto estaba activo casi siempre: con la señal clara en
// SUBE (puntuación 29) y 1 acierto de 5, la app decía ESPERAR.
// CORRECCIÓN v15.4: la señal clara MANDA (SUBE/BAJA) y lo débil / lo
// conflictivo se muestra como AVISO junto al lado, no como veto.
// Solo se dice ESPERAR cuando la señal misma no es clara (wait).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { marketRecommendation } from './client/src/kalshi.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(ROOT, 'client/src/App.jsx'), 'utf8');
const decision = readFileSync(path.join(ROOT, 'client/src/components/Decision.jsx'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('v15.4 — marketRecommendation: la señal clara manda, lo débil es aviso');
check('señal clara alcista -> Apuesta a la SUBIDA',
  (() => { const r = marketRecommendation({ signalKey: 'up' }); return r.key === 'up' && r.label === 'Apuesta a la SUBIDA' && r.side === 'up'; })());
check('señal clara bajista -> Apuesta a la BAJADA',
  (() => { const r = marketRecommendation({ signalKey: 'down' }); return r.key === 'down' && r.label === 'Apuesta a la BAJADA' && r.side === 'down'; })());
// Caso real que Luis veía: señal SUBE clara (29) con 1/5 recientes -> antes ESPERAR, ahora SUBIDA + aviso.
check('señal alcista + DÉBIL (1/5) -> SUBIDA con aviso, NO ESPERAR',
  (() => { const r = marketRecommendation({ signalKey: 'up', weakSignal: true, conflict: false, recent: { wins: 1, total: 5, rate: 0.2 } });
    return r.key === 'up' && r.side === 'up' && r.warnings.length === 1 && r.warnings[0].includes('1 de 5'); })());
check('señal bajista + DÉBIL -> BAJADA con aviso',
  (() => { const r = marketRecommendation({ signalKey: 'down', weakSignal: true, conflict: false, recent: { wins: 2, total: 5, rate: 0.4 } });
    return r.key === 'down' && r.warnings.length === 1 && /débil/i.test(r.warnings[0]); })());
check('señal alcista + CONFLICTIVA -> SUBIDA con aviso de plazos en contra',
  (() => { const r = marketRecommendation({ signalKey: 'up', weakSignal: false, conflict: true });
    return r.key === 'up' && r.warnings.length === 1 && /plazos/i.test(r.warnings[0]); })());
check('señal alcista + débil Y conflictiva -> SUBIDA con dos avisos',
  (() => { const r = marketRecommendation({ signalKey: 'up', weakSignal: true, conflict: true, recent: { wins: 1, total: 5, rate: 0.2 } });
    return r.key === 'up' && r.warnings.length === 2; })());
check('señal no clara (wait) -> ESPERAR, sin lado (único caso de ESPERAR)',
  (() => { const r = marketRecommendation({ signalKey: 'wait' }); return r.key === 'wait' && r.label === 'ESPERAR' && r.side === null; })());
check('wait + débil -> ESPERAR y el aviso sigue presente',
  (() => { const r = marketRecommendation({ signalKey: 'wait', weakSignal: true, conflict: false, recent: { wins: 1, total: 5, rate: 0.2 } });
    return r.key === 'wait' && r.warnings.length === 1; })());
check('sin flags ni recent, no hay avisos',
  marketRecommendation({ signalKey: 'up' }).warnings.length === 0);

console.log('v15.4 — cableado: App.jsx pasa el historial reciente a la recomendación');
check('App.jsx calcula marketRec con señal, débil, conflicto y recent',
  app.includes('marketRecommendation({ signalKey: kalshiVerdict.key, weakSignal: kalshiWeakSignal, conflict: marketConflict, recent: kalshiRecent })'));
check('App.jsx pasa marketRec a Decision', app.includes('marketRec={marketRec}'));

console.log('v15.4 — Decision.jsx: la caja va PRIMERO en §2, grande y con avisos');
check('la caja dice "A qué apostar en esta ventana" en grande',
  decision.includes('A qué apostar en esta ventana') && decision.includes('fontSize: 30'));
check('la caja muestra los avisos (⚠️) junto al lado',
  decision.includes('marketRec.warnings') && decision.includes('⚠️'));
check('la caja va ANTES del texto "Sin sesión" / "Sin posición abierta"',
  decision.indexOf('<MarketRecBox') < decision.indexOf('Sin sesión') && decision.indexOf('<MarketRecBox') < decision.indexOf('Sin posición abierta en Kalshi'));
check('la caja NO aparece en la rama con posición (solo liveDecision)',
  (() => { const withPos = decision.slice(decision.indexOf('liveDecisionNow ?')); return !withPos.includes('<MarketRecBox'); })());
check('sigue el aviso educativo (no es orden ni garantía)',
  decision.includes('Sugerencia educativa, no es una orden ni una garantía'));

console.log('v15.4 — bundle compilado');
const distHtml = existsSync(path.join(ROOT, 'client/dist/index.html')) ? readFileSync(path.join(ROOT, 'client/dist/index.html'), 'utf8') : '';
const bundleMatch = distHtml.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/);
check('dist/index.html existe y referencia un bundle', Boolean(bundleMatch));
if (bundleMatch) {
  const bundle = readFileSync(path.join(ROOT, 'client/dist/assets', bundleMatch[1]), 'utf8');
  check('bundle distinto al de v15.3.1 (index-CrCcB5Si.js)', bundleMatch[1] !== 'index-CrCcB5Si.js');
  check('bundle trae "A qué apostar en esta ventana"', bundle.includes('A qué apostar en esta ventana'));
  check('bundle trae "Apuesta a la SUBIDA" y "Apuesta a la BAJADA"',
    bundle.includes('Apuesta a la SUBIDA') && bundle.includes('Apuesta a la BAJADA'));
}

console.log('v15.4 — versión y documentación');
const versionTxt = readFileSync(path.join(ROOT, 'VERSION.txt'), 'utf8');
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
check('VERSION.txt empieza por v15.4', versionTxt.startsWith('v15.4'));
check('VERSION.txt explica por qué casi siempre decía ESPERAR', versionTxt.includes('ESPERAR') && versionTxt.includes('veto'));
check('README menciona v15.4', readme.includes('v15.4'));

console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
