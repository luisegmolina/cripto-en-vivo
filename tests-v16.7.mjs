// tests-v16.7.mjs — PIN del dueño (no solo admin) + §7 dinámico.
// (a) Un usuario no-admin puede poner/cambiar/quitar el PIN (ruta con
// JWT de usuario normal → 200, no 403); las rutas /admin/* siguen
// siendo solo admin (incluido reset-password). (b) verify sigue con
// rate limit (5 intentos/IP/15 min) y rechaza el PIN incorrecto con
// 401. (c) recover con el código válido quita el PIN. (d) SitePin se
// renderiza para un usuario no-admin. (e) §7: título y aviso final
// cambian según live/armed/killed. NADA de esto toca la red de Kalshi
// para enviar órdenes ni enciende live: sin credenciales reales, el
// PIN ('4321', '8765', '1111'), el admin y el usuario son de prueba,
// el JWT_SECRET es de prueba y la BD es el modo archivo local.
// Uso: node tests-v16.7.mjs
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { hashPassword } = require('./server/auth.js');

const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const routesSrc = src('server/routes.js');
const siteGateSrc = src('server/siteGate.js');
const accountBoxSrc = src('client/src/components/AccountBox.jsx');
const sitePinSrc = src('client/src/components/SitePin.jsx');
const liveTraderJsx = src('client/src/components/LiveTrader.jsx');
const appJsx = src('client/src/App.jsx');
const versionTxt = src('VERSION.txt');
const paperAuditorSrc = src('server/paperAuditor.js');
const motor = ['client/src/kalshi.js', 'client/src/analysis.js', 'client/src/verdict.js', 'client/src/windowOutcome.js'].map(src);

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RECOVERY_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

console.log('v16.7 — 1. PIN del dueño: rutas sin requireAdmin, /admin/* sigue solo admin');
check("routes.js: /site-gate/pin exige solo JWT (auth, sin requireAdmin)",
  routesSrc.includes("router.post('/site-gate/pin', auth, async")
  && !routesSrc.includes("router.post('/site-gate/pin', auth, requireAdmin"));
check("routes.js: /site-gate/pin/remove exige solo JWT (auth, sin requireAdmin)",
  routesSrc.includes("router.post('/site-gate/pin/remove', auth, async")
  && !routesSrc.includes("router.post('/site-gate/pin/remove', auth, requireAdmin"));
check('routes.js: /admin/* sigue exigiendo admin (stats, users, reset-password)',
  routesSrc.includes("router.get('/admin/stats', auth, requireAdmin")
  && routesSrc.includes("router.get('/admin/users', auth, requireAdmin")
  && routesSrc.includes("router.post('/admin/users/:id/reset-password', auth, requireAdmin"));
check('routes.js: verify y recover siguen con el límite 5 intentos/IP/15 min',
  routesSrc.includes('siteGateRateLimit')
  && routesSrc.includes("router.post('/site-gate/verify', siteGateRateLimit")
  && routesSrc.includes("router.post('/site-gate/recover', siteGateRateLimit"));
check('siteGate.js: el comentario ya no dice que /pin exija JWT de admin',
  !siteGateSrc.includes('JWT de admin') && siteGateSrc.includes('sin rol admin'));

console.log('v16.7 — 2. PIN del dueño: cliente (SitePin visible para cualquier usuario con sesión)');
check('AccountBox.jsx renderiza <SitePin /> sin condición de admin',
  accountBoxSrc.includes('<SitePin />') && !accountBoxSrc.includes("user.role === 'admin'"));
check('SitePin.jsx ya no dice "Solo el admin": el dueño lo pone/cambia/quita',
  !sitePinSrc.includes('Solo el admin') && sitePinSrc.includes('dueño de la cuenta'));
check('SitePin.jsx no depende de nada admin (solo apiAuth y siteGateVerify)',
  sitePinSrc.includes("from '../auth.js'") && sitePinSrc.includes("from '../siteGate.js'")
  && !sitePinSrc.includes('requireAdmin') && !sitePinSrc.includes("role === 'admin'"));

console.log('v16.7 — 3. §7 dinámico: título y aviso final según live/armed/killed');
check('LiveTrader.jsx: título dinámico tituloEstado con los 4 estados (misma precedencia que el badge)',
  liveTraderJsx.includes("const tituloEstado = !live ? 'APAGADO' : killed ? 'DETENIDO' : armed ? 'ARMADO' : 'ENCENDIDO SIN ARMAR'")
  && liveTraderJsx.includes('<h2>7 · Bot en vivo — {tituloEstado}</h2>'));
check('LiveTrader.jsx: ya no hay título fijo "7 · Bot en vivo — APAGADO"',
  !liveTraderJsx.includes('<h2>7 · Bot en vivo — APAGADO</h2>'));
check('LiveTrader.jsx: el badge estadoTxt sigue intacto (APAGADO / DETENIDO / ARMADO / sin armar)',
  liveTraderJsx.includes("const estadoTxt = !live ? '⛔ APAGADO — no envía órdenes'")
  && liveTraderJsx.includes("'● ARMADO — puede enviar órdenes'"));
check('LiveTrader.jsx: aviso ARMADO dice que la próxima entrada del trader (EV) enviará una orden REAL, con los límites vigentes interpolados',
  liveTraderJsx.includes('live && armed && !killed')
  && liveTraderJsx.includes('la próxima entrada del trader (EV) enviará una orden REAL')
  && liveTraderJsx.includes('máx. {limits.maxContractsPerOrder} contratos por orden')
  && liveTraderJsx.includes('máx. {limits.maxOrdersPerDay} órdenes/día')
  && liveTraderJsx.includes('pérdida potencial máx. ${fmtNum(limits.maxDailyLossUsd)}/día'));
check('LiveTrader.jsx: aviso DETENIDO (kill switch) y aviso ENCENDIDO SIN ARMAR existen',
  liveTraderJsx.includes('Bot DETENIDO por el kill switch')
  && liveTraderJsx.includes('Bot en vivo ENCENDIDO pero SIN ARMAR'));
check('LiveTrader.jsx: aviso APAGADO conserva el texto anterior (imposible enviar orden real, backtest ~46%)',
  liveTraderJsx.includes('Bot en vivo APAGADO: con la configuración actual es imposible que se envíe una orden real')
  && liveTraderJsx.includes('El backtest honesto del motor sigue en ~46%'));
check('LiveTrader.jsx: sondeo, botones y registro intactos (status cada 2 s, kill, Armar deshabilitado sin live)',
  liveTraderJsx.includes("apiAuth('/api/kalshi/live/status')") && liveTraderJsx.includes('2000')
  && liveTraderJsx.includes("'/api/kalshi/live/kill'") && liveTraderJsx.includes('Detener (kill switch)')
  && liveTraderJsx.includes('disabled={busy || !user || !live || armed}'));

console.log('v16.7 — 4. Versión, motor intacto, live apagado');
check("VERSION_LABEL es 'v18 — Decisión compacta (solo §2)' (actualizado por diseño en v18)",
  appJsx.includes("const VERSION_LABEL = 'v18 — Decisión compacta (solo §2)';"));
check('VERSION.txt empieza en v18 y la nota de v16.6 ya dice DESPLEGADA (no "solo en local")',
  versionTxt.startsWith('v18') && versionTxt.includes('DESPLEGADA en Render (commit b579569b)')
  && !versionTxt.includes('v16.6 — Trader continuo en papel (entrada y salida), solo en local, sin desplegar'));
check('el motor no menciona el trader ni la puerta (kalshi.js, analysis.js, verdict.js, windowOutcome.js)',
  motor.every((m) => !m.includes('paperTrader') && !m.includes('paper-trader')
    && !m.includes('liveTrader') && !m.includes('siteGate') && !m.includes('site-gate')
    && !m.includes('cev_gate') && !m.includes('LIVE_TRADING')));
check('fórmula totalMuestrasEfectivas intacta en paperAuditor.js (líneas 121 y 637)',
  paperAuditorSrc.includes('const totalMuestrasEfectivas = muestrasCapturadas + segundosRestantesReales;')
  && paperAuditorSrc.includes('const totalMuestrasEfectivas = n + segundosRestantesReales;'));
check('LIVE_TRADING_ENABLED no está puesta en el entorno de este test',
  process.env.LIVE_TRADING_ENABLED !== 'true');
check('live sigue APAGADO por defecto (isLiveEnabled false sin la env)',
  require('./server/liveTrader.js').isLiveEnabled() === false);

// --- HTTP real contra el servidor (modo archivo) ---
console.log('v16.7 — 5. HTTP real: puerta abierta sin PIN, auth intacto');
process.env.JWT_SECRET = 'test-v167-secreto-solo-para-tests';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.LIVE_TRADING_ENABLED;
process.env.ADMIN_EMAIL = 'admin@ejemplo.com';
process.env.ADMIN_PASSWORD = 'AdminPass123';
const dbFile = path.join(ROOT, 'server', 'data', 'db.json');
const bak = existsSync(dbFile) ? readFileSync(dbFile) : null;
if (existsSync(dbFile)) unlinkSync(dbFile);

let server = null;
let tokenAdmin = null;
let tokenUser = null;
try {
  const app = require('./server/app.js');
  const db = require('./server/db.js');
  await sleep(800); // init() de routes en segundo plano (db.init + admin por env)
  // Usuario sin rol admin (el registro por HTTP se cierra al haber
  // usuarios; se crea directo en la BD de prueba).
  await db.createUser({ email: 'user@ejemplo.com', passwordHash: await hashPassword('UserPass123'), name: 'User', role: 'user' });
  server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  // ip(n): cada sección usa una IP distinta para aislar el límite de
  // intentos (5 por IP cada 15 min, compartido verify/recover).
  const ip = (n) => `10.0.0.${n}`;
  const post = (p, body, extra = {}) => fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': extra.ip || ip(1), ...(extra.cookie ? { Cookie: `cev_gate_v1=${extra.cookie}` } : {}), ...(extra.headers || {}) },
    body: JSON.stringify(body),
  });
  const get = (p, extra = {}) => fetch(base + p, {
    headers: { 'X-Forwarded-For': extra.ip || ip(1), ...(extra.cookie ? { Cookie: `cev_gate_v1=${extra.cookie}` } : {}), ...(extra.headers || {}) },
  });
  const gateCookieDe = (res) => {
    const setCookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : []) || [];
    const c = setCookie.find((s) => s.startsWith('cev_gate_v1='));
    return c ? c.split(';')[0].split('=')[1] : null;
  };
  const jsonDe = async (r) => { try { return await r.json(); } catch { return {}; } };

  const rLoginAdmin = await post('/api/auth/login', { email: 'admin@ejemplo.com', password: 'AdminPass123' });
  tokenAdmin = (await jsonDe(rLoginAdmin)).token;
  check('HTTP: login del admin creado por variables de entorno (200 + token)',
    rLoginAdmin.status === 200 && typeof tokenAdmin === 'string');
  const rLoginUser = await post('/api/auth/login', { email: 'user@ejemplo.com', password: 'UserPass123' });
  tokenUser = (await jsonDe(rLoginUser)).token;
  check('HTTP: login del usuario sin admin (200 + token)',
    rLoginUser.status === 200 && typeof tokenUser === 'string');

  const rHealth = await get('/api/health');
  check('HTTP: sin PIN, GET /api/health 200',
    rHealth.status === 200 && (await jsonDe(rHealth)).ok === true);
  const rStatus0 = await get('/api/site-gate/status');
  check('HTTP: sin PIN, GET /api/site-gate/status → {locked:false}',
    rStatus0.status === 200 && (await jsonDe(rStatus0)).locked === false);
  const rLiveSinToken = await get('/api/kalshi/live/status');
  check('HTTP: sin PIN, GET /api/kalshi/live/status sin token → 401 (live sigue exigiendo auth)',
    rLiveSinToken.status === 401);
  const rTraderSinToken = await get('/api/kalshi/paper-trader');
  check('HTTP: sin PIN, GET /api/kalshi/paper-trader sin token → 401',
    rTraderSinToken.status === 401);

  console.log('v16.7 — 6. HTTP real: el usuario (no admin) pone el PIN');
  const rPinSinToken = await post('/api/site-gate/pin', { pin: '4321' }, { ip: ip(2) });
  check('HTTP: POST /site-gate/pin sin token → 401 (exige sesión)',
    rPinSinToken.status === 401);
  const rPin = await post('/api/site-gate/pin', { pin: '4321' }, { ip: ip(2), headers: { Authorization: `Bearer ${tokenUser}` } });
  const pinJson = await jsonDe(rPin);
  const recovery1 = pinJson.recoveryCode;
  const cookieUser = gateCookieDe(rPin);
  check('HTTP: POST /site-gate/pin con JWT de usuario (no admin) → 200: devuelve UN código de recuperación válido y pone la cookie de puerta',
    rPin.status === 200 && RECOVERY_RE.test(recovery1 || '') && typeof cookieUser === 'string' && cookieUser.length > 20);
  const rStatus1 = await get('/api/site-gate/status');
  check('HTTP: tras poner el PIN, GET /api/site-gate/status → {locked:true} (sin cookie)',
    rStatus1.status === 200 && (await jsonDe(rStatus1)).locked === true);
  const rStatusConCookie = await get('/api/site-gate/status', { cookie: cookieUser });
  check('HTTP: tras poner el PIN, GET /api/site-gate/status con cookie → {locked:false}',
    rStatusConCookie.status === 200 && (await jsonDe(rStatusConCookie)).locked === false);
  const rMarketL = await get('/api/kalshi-market', { ip: ip(3) });
  check('HTTP: con PIN y sin cookie, GET /api/kalshi-market → 403 {error:site_gate} (la puerta sigue bloqueando a todos)',
    rMarketL.status === 403 && (await jsonDe(rMarketL)).error === 'site_gate');
  check('HTTP: el PIN y el código solo viven como hash en la BD (ni el PIN ni el código en claro en db.json)',
    !readFileSync(dbFile, 'utf8').includes('"4321"') && !readFileSync(dbFile, 'utf8').includes(recovery1));

  console.log('v16.7 — 7. HTTP real: verify con PIN incorrecto y límite de intentos');
  const rVerifyMal = await post('/api/site-gate/verify', { pin: '0000' }, { ip: ip(4) });
  check('HTTP: verify con PIN incorrecto → 401 genérico',
    rVerifyMal.status === 401 && (await jsonDe(rVerifyMal)).error === 'Código incorrecto.');
  for (let i = 0; i < 4; i++) await post('/api/site-gate/verify', { pin: '0000' }, { ip: ip(4) });
  const rVerify6 = await post('/api/site-gate/verify', { pin: '0000' }, { ip: ip(4) });
  check('HTTP: 6º intento incorrecto desde la misma IP → 429 (límite 5 cada 15 min)',
    rVerify6.status === 429);
  const rVerifyBien = await post('/api/site-gate/verify', { pin: '4321' }, { ip: ip(5) });
  const cookiePin = gateCookieDe(rVerifyBien);
  check('HTTP: verify con el PIN correcto desde otra IP → 200 {ok:true} y pone la cookie de puerta',
    rVerifyBien.status === 200 && (await jsonDe(rVerifyBien)).ok === true && typeof cookiePin === 'string' && cookiePin.length > 20);

  console.log('v16.7 — 8. HTTP real: el usuario cambia el PIN (exige el actual)');
  const rCambioSinActual = await post('/api/site-gate/pin', { pin: '8765' }, { ip: ip(6), cookie: cookiePin, headers: { Authorization: `Bearer ${tokenUser}` } });
  check('HTTP: cambiar el PIN sin currentPin → 401',
    rCambioSinActual.status === 401);
  const rCambioMal = await post('/api/site-gate/pin', { pin: '8765', currentPin: '0000' }, { ip: ip(6), cookie: cookiePin, headers: { Authorization: `Bearer ${tokenUser}` } });
  check('HTTP: cambiar el PIN con currentPin incorrecto → 401',
    rCambioMal.status === 401);
  const rCambio = await post('/api/site-gate/pin', { pin: '8765', currentPin: '4321' }, { ip: ip(6), cookie: cookiePin, headers: { Authorization: `Bearer ${tokenUser}` } });
  const cambioJson = await jsonDe(rCambio);
  const recovery2 = cambioJson.recoveryCode;
  check('HTTP: cambiar el PIN con currentPin correcto → 200 y UN código de recuperación NUEVO (distinto del anterior)',
    rCambio.status === 200 && RECOVERY_RE.test(recovery2 || '') && recovery2 !== recovery1);
  const rVerifyViejo = await post('/api/site-gate/verify', { pin: '4321' }, { ip: ip(7) });
  check('HTTP: tras el cambio, el PIN viejo ya no entra (401)',
    rVerifyViejo.status === 401);
  const rVerifyNuevo = await post('/api/site-gate/verify', { pin: '8765' }, { ip: ip(8) });
  const cookiePin2 = gateCookieDe(rVerifyNuevo);
  check('HTTP: el PIN nuevo sí entra (200 + cookie)',
    rVerifyNuevo.status === 200 && typeof cookiePin2 === 'string' && cookiePin2.length > 20);

  console.log('v16.7 — 9. HTTP real: recover con el código válido quita el PIN');
  const rRecoverMal = await post('/api/site-gate/recover', { code: 'AAAA-AAAA-AAAA' }, { ip: ip(9) });
  check('HTTP: recover con código incorrecto → 401 genérico',
    rRecoverMal.status === 401 && (await jsonDe(rRecoverMal)).error === 'Código incorrecto.');
  const rRecover = await post('/api/site-gate/recover', { code: recovery2 }, { ip: ip(10) });
  check('HTTP: recover con el código correcto → 200 {ok:true}',
    rRecover.status === 200 && (await jsonDe(rRecover)).ok === true);
  const rStatus2 = await get('/api/site-gate/status', { ip: ip(11) });
  check('HTTP: tras recover, GET /api/site-gate/status → {locked:false}',
    rStatus2.status === 200 && (await jsonDe(rStatus2)).locked === false);

  console.log('v16.7 — 10. HTTP real: el usuario quita el PIN con /pin/remove');
  const rPin2 = await post('/api/site-gate/pin', { pin: '1111' }, { ip: ip(12), headers: { Authorization: `Bearer ${tokenUser}` } });
  check('HTTP: poner el PIN de nuevo sin currentPin (no había PIN) → 200',
    rPin2.status === 200 && RECOVERY_RE.test((await jsonDe(rPin2)).recoveryCode || ''));
  const cookiePin3 = gateCookieDe(rPin2);
  const rRemoveSinActual = await post('/api/site-gate/pin/remove', {}, { ip: ip(12), cookie: cookiePin3, headers: { Authorization: `Bearer ${tokenUser}` } });
  check('HTTP: /pin/remove sin currentPin → 401',
    rRemoveSinActual.status === 401);
  const rRemoveMal = await post('/api/site-gate/pin/remove', { currentPin: '0000' }, { ip: ip(12), cookie: cookiePin3, headers: { Authorization: `Bearer ${tokenUser}` } });
  check('HTTP: /pin/remove con currentPin incorrecto → 401',
    rRemoveMal.status === 401);
  const rRemove = await post('/api/site-gate/pin/remove', { currentPin: '1111' }, { ip: ip(12), cookie: cookiePin3, headers: { Authorization: `Bearer ${tokenUser}` } });
  check('HTTP: /pin/remove con JWT de usuario (no admin) y currentPin correcto → 200 {ok:true}',
    rRemove.status === 200 && (await jsonDe(rRemove)).ok === true);
  const rStatus3 = await get('/api/site-gate/status', { ip: ip(13) });
  check('HTTP: tras /pin/remove, status → {locked:false}',
    rStatus3.status === 200 && (await jsonDe(rStatus3)).locked === false);

  console.log('v16.7 — 11. HTTP real: /admin/* sigue siendo solo admin');
  const rAdminUsersUser = await get('/api/admin/users', { ip: ip(14), headers: { Authorization: `Bearer ${tokenUser}` } });
  check('HTTP: GET /admin/users con JWT de usuario (no admin) → 403',
    rAdminUsersUser.status === 403);
  const rAdminUsersAdmin = await get('/api/admin/users', { ip: ip(14), headers: { Authorization: `Bearer ${tokenAdmin}` } });
  check('HTTP: GET /admin/users con JWT de admin → 200',
    rAdminUsersAdmin.status === 200);
  const rResetUser = await post('/api/admin/users/:id/reset-password', { newPassword: 'NuevaPass123' }, { ip: ip(14), headers: { Authorization: `Bearer ${tokenUser}` } });
  check('HTTP: POST /admin/users/:id/reset-password con JWT de usuario (no admin) → 403',
    rResetUser.status === 403);
  const rResetAdminCorto = await post('/api/admin/users/xxx/reset-password', { newPassword: 'corto' }, { ip: ip(14), headers: { Authorization: `Bearer ${tokenAdmin}` } });
  check('HTTP: POST /admin/users/:id/reset-password con admin y contraseña corta → 400 (el admin pasa el filtro y llega a la validación)',
    rResetAdminCorto.status === 400);
} finally {
  if (server) await new Promise((r) => server.close(r));
  if (bak) writeFileSync(dbFile, bak);
  else if (existsSync(dbFile)) unlinkSync(dbFile);
}

console.log(`\ntests-v16.7.mjs: ${pass} pasaron, ${fail} fallaron.`);
process.exit(fail ? 1 : 0);
