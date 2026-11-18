// tests-v14.mjs — Pantalla mínima v14: UNA sola pantalla con SOLO 4 elementos.
// No necesita servidor: lee el código fuente y el bundle compilado.
// Uso: node tests-v14.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mainReturnSrc } from './frontendSrc.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(ROOT, 'client/src/App.jsx'), 'utf8');
const kc = readFileSync(path.join(ROOT, 'client/src/KalshiConnect.jsx'), 'utf8');
const serverApp = readFileSync(path.join(ROOT, 'server/app.js'), 'utf8');
const routes = readFileSync(path.join(ROOT, 'server/routes.js'), 'utf8');
const brti = readFileSync(path.join(ROOT, 'server/brti.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

// La vista es el return principal de App (después del "return (" final
// del componente, que es el de la app pública, no el de la vista admin).
const mainReturn = mainReturnSrc();

console.log('v14 — pantalla mínima: los 4 elementos presentes');
check('1. Precio actual de Kalshi (BRTI en vivo)', mainReturn.includes('BRTI ahora'));
check('1b. BRTI: promedio 60 s y hora de actualización', mainReturn.includes('Promedio de 60 s') && mainReturn.includes('Actualizado:'));
check('2. Precio objetivo de Kalshi', mainReturn.includes('Precio objetivo (Kalshi)'));
check('3. Gráfica BTC 15m con el contenedor del gráfico', mainReturn.includes('Gráfica · BTC 15m') && mainReturn.includes('<div ref={chartRef} className="chart" />'));
check('3b. Gráfica sin botones de intervalo (siempre 15m)', !mainReturn.includes('INTERVALS.map'));
check('3c. Gráfica sin toggles EMA/Bollinger/RSI en la vista', !mainReturn.includes('EMA 20/50') && !mainReturn.includes('Bollinger') && !mainReturn.includes('RSI (panel)'));
check('4. Señales: veredicto SUBE/BAJA/ESPERAR', mainReturn.includes('verdict-main') && mainReturn.includes('kalshiVerdict'));
check('4b. Señales: ¿Cobro o me quedo?', mainReturn.includes('¿Cobro o me quedo?'));
check('4c. Señales: decisión real en §2 por precio del contrato (v15, v15.3: la decisión subió al segundo bloque)', mainReturn.includes('2 · Decisión') && mainReturn.includes('liveDecisionNow') && mainReturn.includes('Tu posición:'));

console.log('v14 — lo demás ELIMINADO de la vista');
const gone = [
  ['pestañas Mercados/Gráfico/Cartera/Liga', "activeTab === 'mercados'", "activeTab === 'grafico'", "activeTab === 'cartera'", "activeTab === 'liga'", 'app-tabs', 'TABS.map'],
  ['ticker tape', 'tape-track', 'tape-item'],
  ['grid de mercados', 'Mercados</h2>', 'Sparkline values={sparkHist'],
  ['panel PRO', 'Panel de mercado PRO'],
  ['screener / oportunidades', 'Oportunidades del día'],
  ['backtest', 'Backtest de señales'],
  ['historial de señales', 'Historial de señales'],
  ['historial de últimas ventanas', 'Últimas ventanas con señal clara'],
  ['análisis en vivo', 'Análisis en vivo · Prueba educativa'],
  ['cartera virtual', 'Cartera virtual — dinero de mentira'],
  ['liga semanal', 'Liga semanal —'],
  ['misiones y XP', 'Misiones diarias y XP'],
  ['logros', 'Logros y racha'],
  ['alertas de precio', 'Alertas de precio'],
  ['panel de mercado / ánimo', 'Panel de mercado PRO', 'Estado de ánimo'],
  ['estado del servidor', 'Estado del servidor'],
  ['perfil local (apodo de la liga)', 'Tu perfil local'],
  ['veredicto general multitemporal', 'mtfVerdict.verdict.label'],
];
for (const [name, ...needles] of gone) {
  check(name, !needles.some((n) => mainReturn.includes(n)));
}

console.log('v14 — lo mínimo que se queda (discreto, porque sin eso no funciona)');
check('encabezado pequeño con nombre + sesión', mainReturn.includes('₿ Cripto en Vivo') && mainReturn.includes('👤 {user.name || user.email}'));
check('enlace discreto a Mi cuenta Kalshi (details, no sección)', mainReturn.includes('account-details') && mainReturn.includes('Mi cuenta Kalshi — conectar / desconectar'));
check('enlace Admin discreto solo si es admin', mainReturn.includes("user.role === 'admin' && <button onClick={goAdmin}>"));
check('aviso único de solo lectura + liquidación BRTI en una línea', mainReturn.includes('solo lectura: la app nunca opera por ti. Kalshi liquida con el índice BRTI'));
check('sin pestañas: activeTab es constante', app.includes("const activeTab = 'kalshi';") && !app.includes('setActiveTab'));
check('intervalo de velas fijo en 15m', app.includes("useState('15m')") && !app.includes("setCandleInterval('1h')"));
check('KalshiConnect en modo mínimo (sin tabla ni historial)', mainReturn.includes('minimal') && kc.includes('minimal = false') && kc.includes('if (minimal)'));
check('KalshiConnect mínimo sigue subiendo la decisión real', kc.includes('onRealDecisionRef.current(openDecisions)'));
check('vista Admin intacta (#admin, AdminPanel)', app.includes("if (view === 'admin')") && app.includes('<AdminPanel token={token}'));

console.log('v14 — backend intacto (solo se limpió la vista)');
check('/api/kalshi-market sigue (precio objetivo)', routes.includes('/api/kalshi-market') || serverApp.includes('/api/kalshi-market'));
check('/api/kalshi/brti sigue (BRTI en vivo)', routes.includes("router.get('/kalshi/brti'"));
check('servidor BRTI por WebSocket sigue', brti.includes('cfbenchmarks_value') && brti.includes('BRTI'));
check('auth JWT sigue', serverApp.includes('/api/auth') || routes.includes('/api/auth') || serverApp.includes('login'));
check('Kalshi sigue solo lectura (sin endpoint de órdenes)', !/portfolio\/orders|trade\/orders|\/orders/.test(routes + serverApp) && !/method: 'POST'/.test(routes));
check('sin endpoint de compra/venta en el servidor', !/createOrder|placeOrder|submitOrder/.test(routes + serverApp));

console.log('v14 — bundle compilado');
const distHtml = existsSync(path.join(ROOT, 'client/dist/index.html')) ? readFileSync(path.join(ROOT, 'client/dist/index.html'), 'utf8') : '';
const bundleMatch = distHtml.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/);
check('dist/index.html existe y referencia un bundle', Boolean(bundleMatch));
if (bundleMatch) {
  const bundle = readFileSync(path.join(ROOT, 'client/dist/assets', bundleMatch[1]), 'utf8');
  check('bundle distinto al de v13.5 (index-BJtnnrQL.js)', bundleMatch[1] !== 'index-BJtnnrQL.js');
  check('bundle trae la etiqueta v16', bundle.includes('v16'));
  check('bundle trae el BRTI en vivo', bundle.includes('BRTI ahora'));
  check('bundle trae la gráfica 15m', bundle.includes('Gráfica'));
  check('bundle NO trae la navegación por pestañas', !bundle.includes('app-tabs') && !bundle.includes('Gráfico y señal'));
  check('bundle NO trae la liga ni la cartera virtual', !bundle.includes('Liga semanal') && !bundle.includes('Cartera virtual'));
}

console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
