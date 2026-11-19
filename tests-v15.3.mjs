// tests-v15.3.mjs — Reorganización v15.3 + recomendación del mercado sin posición.
// Uso: node tests-v15.3.mjs (después de npm --prefix client run build)
//
// 1. marketRecommendation (kalshi.js, pura): sin posición abierta, la
//    señal 15m se traduce a "Apuesta a la SUBIDA" / "Apuesta a la BAJADA"
//    / "ESPERAR". v15.4 CAMBIÓ esta regla (ver tests-v15.4.mjs): la señal
//    débil o conflictiva ya NO veta el lado, se muestra como AVISO junto
//    al lado; solo sin señal clara se dice ESPERAR. Los checks de abajo
//    se actualizaron a la regla v15.4 (el veto era el motivo de que Luis
//    pidiera el cambio dos veces: la caja casi siempre decía ESPERAR).
// 2. Cableado: App.jsx calcula la recomendación y Decision.jsx la muestra
//    SOLO en la rama sin posición (§2 sigue diciendo "sin posición
//    abierta" y no inventa decisión de posición). Con posición abierta
//    manda liveDecision (SAL/AGUANTA/INVIERTE MÁS).
// 3. Reorganización: 5 bloques en orden urgente-primero, App.jsx partida
//    en componentes, código muerto eliminado (ver README).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { marketRecommendation } from './client/src/kalshi.js';
import { frontendSrc, mainReturnSrc } from './frontendSrc.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(ROOT, 'client/src/App.jsx'), 'utf8');
const frontend = frontendSrc();
const mainReturn = mainReturnSrc();
const decision = readFileSync(path.join(ROOT, 'client/src/components/Decision.jsx'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('v15.3 — marketRecommendation: señal clara -> lado directo');
check('sin posición + señal clara alcista -> Apuesta a la SUBIDA',
  (() => { const r = marketRecommendation({ signalKey: 'up', weakSignal: false, conflict: false }); return r.key === 'up' && r.label === 'Apuesta a la SUBIDA' && r.side === 'up'; })());
check('sin posición + señal clara bajista -> Apuesta a la BAJADA',
  (() => { const r = marketRecommendation({ signalKey: 'down', weakSignal: false, conflict: false }); return r.key === 'down' && r.label === 'Apuesta a la BAJADA' && r.side === 'down'; })());
check('sin posición + señal no clara (wait) -> ESPERAR, sin lado',
  (() => { const r = marketRecommendation({ signalKey: 'wait', weakSignal: false, conflict: false }); return r.key === 'wait' && r.label === 'ESPERAR' && r.side === null; })());
check('sin posición + señal alcista pero DÉBIL -> SUBIDA con aviso (v15.4: lo débil ya no veta)',
  (() => { const r = marketRecommendation({ signalKey: 'up', weakSignal: true, conflict: false }); return r.key === 'up' && r.side === 'up' && r.warnings.length === 1; })());
check('sin posición + señal bajista pero DÉBIL -> BAJADA con aviso (v15.4)',
  (() => { const r = marketRecommendation({ signalKey: 'down', weakSignal: true, conflict: false }); return r.key === 'down' && r.warnings.length === 1; })());
check('sin posición + señal alcista pero CONFLICTIVA -> SUBIDA con aviso (v15.4: el conflicto ya no veta)',
  (() => { const r = marketRecommendation({ signalKey: 'up', weakSignal: false, conflict: true }); return r.key === 'up' && r.warnings.length === 1; })());
check('sin posición + señal bajista pero CONFLICTIVA -> BAJADA con aviso (v15.4)',
  (() => { const r = marketRecommendation({ signalKey: 'down', weakSignal: false, conflict: true }); return r.key === 'down' && r.warnings.length === 1; })());
check('débil + conflicto ya no fuerzan ESPERAR si hay señal clara (v15.4)',
  marketRecommendation({ signalKey: 'up', weakSignal: true, conflict: true }).key === 'up');
check('sin flags, los valores por defecto no bloquean (up -> SUBIDA)',
  marketRecommendation({ signalKey: 'up' }).key === 'up');

console.log('v15.3 — cableado: la recomendación solo vive en la rama sin posición');
check('App.jsx calcula marketRec con la señal, lo débil, el conflicto y el historial reciente',
  app.includes('marketRecommendation({ signalKey: kalshiVerdict.key, weakSignal: kalshiWeakSignal, conflict: marketConflict, recent: kalshiRecent })'));
check('App.jsx calcula el conflicto con los timeframes claros (mayoría en contra)',
  app.includes('marketConflict') && app.includes("mtfClearRows.filter((r) => r.key === marketWantKey)"));
check('App.jsx pasa marketRec a Decision', app.includes('marketRec={marketRec}'));
const kalshiSrc = readFileSync(path.join(ROOT, 'client/src/kalshi.js'), 'utf8');
check('la etiqueta SUBIDA/BAJADA se define una sola vez en kalshi.js (sin duplicar)',
  (kalshiSrc.match(/label: 'Apuesta a la SUBIDA'/g) || []).length === 1 && (kalshiSrc.match(/label: 'Apuesta a la BAJADA'/g) || []).length === 1);
check('Decision.jsx pinta la etiqueta por prop, no hardcodeada en la vista', decision.includes('{marketRec.label}'));
{
  // Dos usos de la caja: rama sin sesión y rama sin posición; con posición
  // abierta no aparece (la decisión real va después y no hay caja tras ella).
  const usages = [...decision.matchAll(/<MarketRecBox marketRec=\{marketRec\}/g)].map((m) => m.index);
  const noPosIdx = decision.indexOf('Sin posición abierta en Kalshi ahora mismo: no hay decisión que tomar sobre una posición');
  const noUserIdx = decision.indexOf('arriba tienes la apuesta recomendada ahora mismo');
  const liveIdx = decision.indexOf('liveDecisionNow ? (');
  // v15.4: la caja va PRIMERO en cada rama sin posición (antes del texto
  // explicativo), por eso los usos quedan ANTES de noUserIdx/noPosIdx.
  check('Decision.jsx muestra la recomendación SOLO en las ramas sin posición (sin sesión y sin posición abierta; nunca con posición)',
    usages.length === 2 && usages[0] < noUserIdx && usages[1] < noPosIdx && usages[1] < liveIdx);
}
check('la caja de recomendación lleva fuerza y razones de la señal',
  decision.includes('Fuerza 15m:') && decision.includes('kalshiReasons'));
check('§2 sigue diciendo "sin posición abierta" y no inventa decisión de posición',
  mainReturn.includes('Sin posición abierta en Kalshi ahora mismo: no hay decisión que tomar'));
check('la recomendación dice que es sugerencia educativa, no orden ni garantía',
  mainReturn.includes('Sugerencia educativa, no es una orden ni una garantía'));
check('el aviso del backtest 15m (no se distingue de una moneda) sigue en §4',
  mainReturn.includes('no se distingue de lanzar una moneda'));

console.log('v15.3 — reorganización: orden urgente-primero y componentes');
{
  const i1 = mainReturn.indexOf('1 · Mi posición en vivo');
  const i2 = mainReturn.indexOf('2 · Decisión');
  const i3 = mainReturn.indexOf('3 · Referencia en tiempo real');
  const i4 = mainReturn.indexOf('4 · Radar de Señales');
  const i5 = mainReturn.indexOf('5 · Gráfica · BTC 15m');
  check('orden §1 posición < §2 decisión < §3 referencia < §4 señales < §5 gráfica', i1 > 0 && i1 < i2 && i2 < i3 && i3 < i4 && i4 < i5);
}
for (const c of ['LiveReference', 'MyPosition', 'Decision', 'Signals', 'ChartSection', 'AccountBox', 'AuthModal']) {
  check(`componente client/src/components/${c}.jsx existe`, existsSync(path.join(ROOT, 'client/src/components', `${c}.jsx`)));
  check(`App.jsx importa ${c}`, app.includes(`import ${c} from './components/${c}.jsx';`));
}
check('App.jsx adelgazó: menos de 900 líneas (era 1.555 en v15.2)', app.split('\n').length < 900, `${app.split('\n').length} líneas`);

console.log('v15.3 — código muerto eliminado de App.jsx (grep)');
const dead = ['screenOpportunities', 'doTrade', 'resetPortfolio', 'addPriceAlert', 'saveNickname',
  'createPrivateLeague', 'joinPrivateLeague', 'leavePrivateLeague', 'doShareText', 'downloadCard',
  'runScreener', 'MISSIONS', 'levelForXp', 'fearGreedEstimate', 'heatToday', 'isoWeekKey',
  'rivalsForWeek', 'backtestSignal', 'tradePlan', 'signalHistory', 'shareText', 'drawShareCard',
  'whatsappUrl', 'Sparkline', 'genCode', 'testServer', 'askNotif', 'localDay', 'fmtNum',
  'ASSETS', 'INTERVALS', 'ACHIEVEMENTS', 'showEma', 'showBoll', 'showRsi', 'compareBtc',
  'chartFull', 'btcCandles', 'relSeries', 'rsiChartRef', 'screenAutoRanRef', 'completeMission',
  'cev_profile_v1', 'cev_private_league_v1', 'cev_streak_v1', 'cev_missions_v1', 'cev_xp_v1',
  'cev_league_week_v1', 'backtestSignal(candles1h)', 'signalHistory(candles1h'];
const stillThere = dead.filter((d) => app.includes(d));
check('nada de lo eliminado sigue referenciado en App.jsx', stillThere.length === 0, stillThere.join(', '));

console.log('v15.3 — lo que se conserva a propósito (no se borró)');
check('sincronización cartera/alertas con el servidor sigue (pullOrPushServerData)',
  app.includes('pullOrPushServerData') && app.includes("apiAuth('/api/me/portfolio'") && app.includes("apiAuth('/api/me/alerts'"));
check('alertas de precio guardadas siguen sonando con cada tick',
  app.includes('shouldFireAlert(alertCooldownRef.current'));
check('alerta de cambio de veredicto sigue (refs v13.1)',
  app.includes('const prevVerdictKey') && app.includes('shouldSignalAlert(lastSignalAlertRef.current'));
check('vista Admin intacta (#admin, AdminPanel)', app.includes("if (view === 'admin')") && app.includes('<AdminPanel token={token}'));
check('KalshiConnect mínimo sigue (vía AccountBox)', frontend.includes('minimal />') && frontend.includes('<KalshiConnect token='));

console.log('v15.3 — bundle compilado');
const distHtml = existsSync(path.join(ROOT, 'client/dist/index.html')) ? readFileSync(path.join(ROOT, 'client/dist/index.html'), 'utf8') : '';
const bundleMatch = distHtml.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/);
check('dist/index.html existe y referencia un bundle', Boolean(bundleMatch));
if (bundleMatch) {
  const bundle = readFileSync(path.join(ROOT, 'client/dist/assets', bundleMatch[1]), 'utf8');
  check('bundle distinto al de v15.2 (index-DxgRBFRC.js)', bundleMatch[1] !== 'index-DxgRBFRC.js');
  // v16.1: la etiqueta de versión del bundle avanzó a v16.1 (antes v16.0); el check
  // busca la etiqueta actual, no la vieja.
  check('bundle trae la etiqueta de versión actual (v16.5)', bundle.includes('v16.5'));
  check('bundle trae "Apuesta a la SUBIDA" y "Apuesta a la BAJADA"',
    bundle.includes('Apuesta a la SUBIDA') && bundle.includes('Apuesta a la BAJADA'));
  check('bundle trae el orden nuevo (1 · Mi posición)', bundle.includes('1 · Mi posición en vivo'));
  check('bundle NO trae la liga ni la cartera virtual', !bundle.includes('Liga semanal') && !bundle.includes('Cartera virtual'));
  check('bundle NO trae "Misiones diarias"', !bundle.includes('Misiones diarias'));
}

console.log('v15.3 — versión y documentación');
const versionTxt = readFileSync(path.join(ROOT, 'VERSION.txt'), 'utf8');
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
check('VERSION.txt documenta v15.3 (la versión actual es v15.4)', versionTxt.includes('v15.3'));
check('VERSION.txt documenta la recomendación sin posición', versionTxt.includes('Apuesta a la SUBIDA'));
check('README menciona v15.3 y la recomendación', readme.includes('v15.3') && readme.includes('Apuesta a la SUBIDA'));
check('README documenta qué se eliminó', readme.includes('qué se eliminó') || readme.includes('Eliminado'));

console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
