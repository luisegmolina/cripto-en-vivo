// tests-v18.mjs — Decisión compacta, solo §2 (v18).
// NADA de esto envía órdenes reales ni toca live: solo lee archivos
// y comprueba la vista compacta /decision. Uso: node tests-v18.mjs
// (después del build del cliente, para el check del bundle).
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDecisionSoloView, DECISION_SOLO_PATH, DECISION_SOLO_MANIFEST } from './client/src/soloView.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const app = src('client/src/App.jsx');
const css = src('client/src/index.css');
const versionTxt = src('VERSION.txt');
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

// 1. Detección de la vista solo §2 (pura, sin DOM).
check('ruta /decision es vista solo', isDecisionSoloView('/decision', '') === true);
check('ruta /decision/ (barra final) es vista solo', isDecisionSoloView('/decision/', '') === true);
check('ruta / no es vista solo', isDecisionSoloView('/', '') === false);
check('ruta /admin no es vista solo', isDecisionSoloView('/admin', '') === false);
check('?vista=decision es vista solo', isDecisionSoloView('/', '?vista=decision') === true);
check('?vista=otra no es vista solo', isDecisionSoloView('/', '?vista=otra') === false);
check('vacío no es vista solo', isDecisionSoloView('', '') === false);
check('constante de ruta es /decision', DECISION_SOLO_PATH === '/decision');
check('constante de manifiesto es /decision.webmanifest', DECISION_SOLO_MANIFEST === '/decision.webmanifest');

// 2. Manifiesto propio de la vista compacta.
const manifestPath = path.join(ROOT, 'client/public/decision.webmanifest');
check('existe decision.webmanifest', existsSync(manifestPath));
let manifest = null;
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch (e) { manifest = null; }
check('decision.webmanifest es JSON válido', manifest !== null);
if (manifest) {
  check('manifiesto abre en /decision', manifest.start_url === '/decision');
  check('manifiesto scope es /decision', manifest.scope === '/decision');
  check('manifiesto se llama Decisión Kalshi', manifest.name === 'Decisión Kalshi');
  check('manifiesto short_name es Decisión', manifest.short_name === 'Decisión');
  check('manifiesto display standalone', manifest.display === 'standalone');
  check('manifiesto tiene iconos', Array.isArray(manifest.icons) && manifest.icons.length > 0);
}

// 3. App.jsx: la vista solo existe y reutiliza §2 tal cual.
check('App.jsx importa soloView', app.includes("from './soloView.js'"));
check('VERSION_LABEL es v18', app.includes("VERSION_LABEL = 'v18 — Decisión compacta (solo §2)'"));
check('App.jsx detecta soloDecision', app.includes('isDecisionSoloView(window.location.pathname, window.location.search)'));
check('App.jsx tiene retorno temprano soloDecision', app.includes('if (soloDecision) {'));
check('vista solo usa clase solo-decision', app.includes('className="app solo-decision"'));
check('vista solo muestra la cuenta atrás', app.includes('fmtCountdown(kalshiWin.remainingMs)'));
check('vista solo renderiza Decision con las mismas props', app.includes('<Decision user={user} firstRealDecision={firstRealDecision} liveDecisionNow={liveDecisionNow} marketRec={marketRec} kalshiScore={kalshiScore} kalshiReasons={kalshiReasons} marketMovement={marketMovement} betPlan={betPlan} />'));
check('vista solo permite entrar (login)', app.includes("setShowAuth('login')"));
check('vista solo enlaza a la app completa', app.includes('<a href="/">Ver app completa</a>'));
check('vista solo cambia el título', app.includes("document.title = 'Decisión — Cripto en Vivo'"));
check('vista solo cambia el manifiesto', app.includes("link.setAttribute('href', DECISION_SOLO_MANIFEST)"));
check('vista principal intacta (terminal-grid)', app.includes('terminal-grid') && app.includes('<MyPosition') && app.includes('<LiveReference'));

// 4. CSS de la vista compacta.
check('CSS tiene .solo-decision', css.includes('.solo-decision'));
check('CSS agranda el titular en solo', css.includes('.solo-decision .hero-headline') && css.includes('34px !important'));
check('CSS fija la cabecera solo arriba', css.includes('.solo-decision .solo-topbar') && css.includes('position: sticky'));

// 5. VERSION.txt empieza en v18 y menciona /decision.
check('VERSION.txt empieza en v18', versionTxt.startsWith('v18 — Decisión compacta (solo §2)'));
check('VERSION.txt menciona /decision', versionTxt.includes('/decision'));

// 6. El motor del cliente no cambia (hash re-baseline v16.10).
check('kalshi.js intacto (hash v16.10)', sha256(src('client/src/kalshi.js')) === '82812817adee3cf71aba42090f4dc846b7a0a83230ec7b47df0e16f87c447f04');

// 7. Bundle compilado: contiene la vista solo y la etiqueta v18.
const assetsDir = path.join(ROOT, 'client/dist/assets');
let newestBundle = null;
try {
  const bundles = readdirSync(assetsDir).filter((f) => /^index-.*\.js$/.test(f));
  bundles.sort((a, b) => statSync(path.join(assetsDir, b)).mtimeMs - statSync(path.join(assetsDir, a)).mtimeMs);
  newestBundle = bundles[0] ? path.join(assetsDir, bundles[0]) : null;
} catch { newestBundle = null; }
check('existe bundle compilado', newestBundle !== null, newestBundle || 'sin dist/assets');
if (newestBundle) {
  const bundle = readFileSync(newestBundle, 'utf8');
  check('bundle contiene decision.webmanifest', bundle.includes('decision.webmanifest'));
  check('bundle contiene la etiqueta v18', bundle.includes('v18'));
  check('bundle contiene solo-decision', bundle.includes('solo-decision'));
  check('bundle contiene "Ver app completa"', bundle.includes('Ver app completa'));
}

console.log(`\ntests-v18: ${pass} pasados, ${fail} fallidos`);
process.exit(fail ? 1 : 0);
