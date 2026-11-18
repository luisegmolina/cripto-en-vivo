// Pruebas v13.3 — unificación de las dos pestañas de Kalshi en una.
// Se corre en Node, sin servidor: node tests-v13.3.mjs
// Comprueba: no queda pestaña "Mi cuenta Kalshi" duplicada, la pestaña
// Kalshi contiene las 5 secciones en orden (predicción, ¿cobro o salgo?,
// mis posiciones, mi cuenta, últimas ventanas), nada del contenido de la
// pestaña vieja se perdió (sesión, salir, perfil local, formulario de
// conexión, botones, saldo) y los avisos de solo lectura y BRTI salen
// una sola vez, no duplicados.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); pass++; console.log(`  ✓ ${name}`); }
function count(src, sub) { return src.split(sub).length - 1; }

const appSrc = readFileSync('./client/src/App.jsx', 'utf8');
const kcSrc = readFileSync('./client/src/KalshiConnect.jsx', 'utf8');
const versionTxt = readFileSync('./VERSION.txt', 'utf8');

// 1. La pestaña duplicada ya no existe.
console.log('— sin pestaña duplicada —');
ok('TABS ya no tiene id cuenta', !appSrc.includes("id: 'cuenta'"));
ok('ningún render con activeTab cuenta', !appSrc.includes("activeTab === 'cuenta'"));
ok('ningún salto a la pestaña cuenta', !appSrc.includes("setActiveTab('cuenta')"));
ok('sin modo compacto ni onGoAccount', !appSrc.includes('compact') && !kcSrc.includes('compact') && !appSrc.includes('onGoAccount') && !kcSrc.includes('onGoAccount'));
ok('v14: una sola pantalla, sin pestañas (las 5 eliminadas por diseño)', !['mercados', 'grafico', 'cartera', 'liga'].some((t) => appSrc.includes(`id: '${t}'`)) && !appSrc.includes('app-tabs'));
ok('v14: pantalla única Kalshi sin pestañas', appSrc.includes("const activeTab = 'kalshi'"));

// 2. Una sola instancia de KalshiConnect, completa, dentro de Kalshi.
console.log('— una sola instancia completa —');
ok('un solo <KalshiConnect en App.jsx', count(appSrc, '<KalshiConnect') === 1);
ok('sin la variante compacta', !appSrc.includes('<KalshiConnect compact'));
ok('KalshiConnect recibe user y onLogout', appSrc.includes('user={user}') && appSrc.includes('onLogout={handleLogout}'));
ok('v14: la instancia vive en el <details> de la pantalla única, tras ¿Cobro o me quedo?', appSrc.indexOf('account-details') < appSrc.indexOf('<KalshiConnect') && appSrc.indexOf('¿Cobro o me quedo?') < appSrc.indexOf('<KalshiConnect'));

// 3. Las 5 secciones en orden dentro de la pestaña Kalshi.
console.log('— 5 secciones en orden —');
const iPred = appSrc.indexOf('MODO KALSHI 15 MIN');
const iCobro = appSrc.indexOf('¿Cobro o me quedo?');
const iPos = appSrc.indexOf('<KalshiConnect');
ok('v14: §1 predicción, §2 cobro, §3+§4 KalshiConnect (sin §5: historial eliminado por diseño)', iPred > 0 && iPred < iCobro && iCobro < iPos && !appSrc.includes('Últimas ventanas con señal clara'));
const kPos = kcSrc.indexOf('Mis posiciones de Kalshi');
const kCerradas = kcSrc.indexOf('Posiciones cerradas / liquidadas');
const kCuenta = kcSrc.indexOf('Mi cuenta</h3>');
ok('§3 posiciones antes que §4 mi cuenta en KalshiConnect', kPos > 0 && kPos < kCerradas && kCerradas < kCuenta);
const kEstado = kcSrc.indexOf('<span>Estado</span>');
const kBalance = kcSrc.indexOf('<span>Balance</span>');
const kActualizar = kcSrc.indexOf('Actualizar posiciones');
// El formulario se define como const antes del return, así que el
// orden de RENDER se mide por su uso, no por su definición.
const kFormUse = kcSrc.indexOf('{!connected && !loading && connectForm}');
ok('§4 en orden: estado, balance, botones, formulario', kCuenta < kEstado && kEstado < kBalance && kBalance < kActualizar && kActualizar < kFormUse);
ok('el formulario de conexión pide Key ID + clave privada', kcSrc.includes('Kalshi API Key ID') && kcSrc.includes('Clave privada (.pem)'));
ok('tabla de abiertas con lado, apuesta, precio medio, actual, P&L y decisión', kcSrc.includes('<th>Mercado</th><th>Lado</th><th>Precio medio</th><th>Cantidad</th><th>Precio actual</th><th>P&amp;L estimado</th><th>¿Cobro o salgo?</th>'));

// 4. Nada del contenido de la pestaña vieja se perdió.
console.log('— contenido de Mi cuenta preservado —');
ok('sesión visible en Mi cuenta', kcSrc.includes('Sesión:'));
ok('botón Salir de mi cuenta', kcSrc.includes('Salir de mi cuenta'));
ok('botón Desconectar Kalshi', kcSrc.includes('Desconectar Kalshi'));
ok('formulario Key ID + clave privada', kcSrc.includes('Kalshi API Key ID') && kcSrc.includes('Clave privada (.pem)'));
ok('formulario colapsado si ya está conectado', kcSrc.includes('<details>') && kcSrc.includes('Conectar con otra clave de Kalshi'));
ok('valor de la cartera', kcSrc.includes('Valor de la cartera'));
ok('última sincronización y Key ID', kcSrc.includes('Última sincronización') && kcSrc.includes('Key ID'));
ok('v14: perfil local eliminado con la liga (por diseño)', !appSrc.includes('Tu perfil local'));
ok('sin cuenta: botones Entrar / Crear cuenta en Kalshi', appSrc.includes("setShowAuth('login')") && appSrc.includes('Entra o crea tu cuenta para conectar tu Kalshi'));

// 5. Avisos una sola vez, no duplicados.
console.log('— avisos sin duplicar —');
ok('aviso solo lectura una sola vez', count(kcSrc, 'SOLO LECTURA: esta app nunca compra') === 1);
ok('v14: aviso liquidación BRTI una sola vez, en la línea única', count(appSrc, 'liquida con el índice BRTI') === 1);
ok('sin segundo aviso BRTI en KalshiConnect', !kcSrc.includes('BRTI'));

// 6. Versión.
console.log('— versión —');
ok('VERSION.txt empieza por v14', versionTxt.startsWith('v14'));
ok('VERSION_LABEL v14 en App.jsx', appSrc.includes("VERSION_LABEL = 'v14"));

console.log(`\ntests-v13.3: ${pass} pasaron`);
