// tests-v16.5.mjs — PIN de acceso al sitio (site gate, SERVIDOR).
// NADA de esto toca la red de Kalshi para enviar órdenes ni enciende
// live: la única llamada externa es GET /api/kalshi-market (API
// pública, con timeout de 5 s) para comprobar que con cookie válida
// la puerta deja pasar. Sin credenciales reales en ningún test: el
// PIN ('1234', 'prueba-5678'), el admin y el usuario son de prueba,
// el JWT_SECRET es de prueba y la BD es el modo archivo local.
// El límite de intentos (5 por IP cada 15 min, compartido entre
// verify y recover) se aísla por sección con X-Forwarded-For
// distintos: el servidor tiene trust proxy 1, así que req.ip es la
// de ese encabezado. Uso: node tests-v16.5.mjs
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const siteGate = require('./server/siteGate.js');
const { hashPassword } = require('./server/auth.js');

const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const appJs = src('server/app.js');
const routesSrc = src('server/routes.js');
const dbSrc = src('server/db.js');
const schemaSql = src('server/schema.sql');
const siteGateSrc = src('server/siteGate.js');
const motor = ['client/src/kalshi.js', 'client/src/analysis.js', 'client/src/verdict.js', 'client/src/windowOutcome.js'].map(src);

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RECOVERY_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

console.log('v16.5 — 1. Módulo siteGate: constantes, PIN y código de recuperación');
check('cookie cev_gate_v1, 30 días (Max-Age 2592000 s)',
  siteGate.GATE_COOKIE_NAME === 'cev_gate_v1' && siteGate.GATE_MAX_AGE_SECONDS === 30 * 24 * 60 * 60);
check('PIN válido entre 4 y 32 caracteres (4 y 32 sí; 3 y 33 no)',
  siteGate.validPin('1234') === true && siteGate.validPin('a'.repeat(32)) === true
  && siteGate.validPin('123') === false && siteGate.validPin('a'.repeat(33)) === false
  && siteGate.validPin('') === false && siteGate.validPin(null) === false);
{
  const codes = new Set(Array.from({ length: 50 }, () => siteGate.generateRecoveryCode()));
  check('el código de recuperación es 3 grupos de 4 (A-Z, 2-9, sin 0/1/I/L/O) y no se repite en 50 generaciones',
    codes.size === 50 && [...codes].every((c) => RECOVERY_RE.test(c)));
}
check('signGateToken firma un JWT HS256 con {gate:true} y 30 días',
  (() => {
    const jwt = require('jsonwebtoken');
    const { jwtSecret } = require('./server/auth.js');
    const t = siteGate.signGateToken();
    const p = jwt.verify(t, jwtSecret(), { algorithms: ['HS256'] });
    return p.gate === true && (p.exp - p.iat) === 30 * 24 * 60 * 60;
  })());
check('gateCookieValid: sin cookie false; con el token firmado true; con firma mala false; con token caducado false',
  siteGate.gateCookieValid({ headers: {} }) === false
  && siteGate.gateCookieValid({ headers: { cookie: `cev_gate_v1=${siteGate.signGateToken()}` } }) === true
  && siteGate.gateCookieValid({ headers: { cookie: 'cev_gate_v1=eyJhbGciOiJIUzI1NiJ9.malo.firma' } }) === false
  && (() => {
    const jwt = require('jsonwebtoken');
    const { jwtSecret } = require('./server/auth.js');
    const viejo = jwt.sign({ gate: true }, jwtSecret(), { algorithm: 'HS256', expiresIn: '-10s' });
    return siteGate.gateCookieValid({ headers: { cookie: `cev_gate_v1=${viejo}` } }) === false;
  })());
check('parseCookies lee cev_gate_v1 entre otras cookies',
  siteGate.parseCookies('otra=1; cev_gate_v1=abc123; x=y').cev_gate_v1 === 'abc123'
  && siteGate.parseCookies(null).cev_gate_v1 === undefined);
check('setGateCookie pone HttpOnly, SameSite=Lax, Path=/, Max-Age 30 días y Secure solo en producción',
  siteGateSrc.includes('httpOnly: true') && siteGateSrc.includes("sameSite: 'Lax'")
  && siteGateSrc.includes("path: '/'") && siteGateSrc.includes('maxAge: GATE_MAX_AGE_SECONDS * 1000')
  && siteGateSrc.includes("secure: process.env.NODE_ENV === 'production'"));

console.log('v16.5 — 2. Cableado: db, schema, app.js y routes.js');
check('db.js y schema.sql crean cev_site_settings (key TEXT PRIMARY KEY, value TEXT)',
  dbSrc.includes('CREATE TABLE IF NOT EXISTS cev_site_settings') && schemaSql.includes('CREATE TABLE IF NOT EXISTS cev_site_settings')
  && dbSrc.includes('key TEXT PRIMARY KEY') && dbSrc.includes('value TEXT NOT NULL'));
check('db.js exporta getSiteSetting / setSiteSetting / deleteSiteSetting (ambos modos)',
  dbSrc.includes('async function getSiteSetting') && dbSrc.includes('async function setSiteSetting')
  && dbSrc.includes('async function deleteSiteSetting') && dbSrc.includes('getSiteSetting, setSiteSetting, deleteSiteSetting')
  && dbSrc.includes('db.settings'));
check('app.js monta el gate justo después de express.json() y antes de /api/health',
  appJs.indexOf('app.use(express.json())') < appJs.indexOf('gateMiddleware')
  && appJs.indexOf('gateMiddleware') < appJs.indexOf("app.get('/api/health'"));
check('app.js monta el gate antes del estático y del fallback SPA',
  appJs.indexOf('gateMiddleware') < appJs.indexOf('express.static(dist)')
  && appJs.indexOf('gateMiddleware') < appJs.indexOf("app.get('*'"));
check('routes.js tiene las 5 rutas del gate',
  routesSrc.includes("router.get('/site-gate/status'") && routesSrc.includes("router.post('/site-gate/verify'")
  && routesSrc.includes("router.post('/site-gate/pin'") && routesSrc.includes("router.post('/site-gate/pin/remove'")
  && routesSrc.includes("router.post('/site-gate/recover'"));
check('routes.js: verify y recover comparten el límite 5 intentos/IP/15 min (makeRateLimiter max: 5)',
  routesSrc.includes('siteGateRateLimit') && routesSrc.includes('max: 5, windowMs: 15 * 60 * 1000')
  && (routesSrc.match(/siteGateRateLimit/g) || []).length >= 3);
check('routes.js: /pin y /pin/remove exigen JWT (auth, sin requireAdmin: el PIN es ajuste del dueño; /admin/* sigue siendo solo admin)',
  routesSrc.includes("router.post('/site-gate/pin', auth, async")
  && routesSrc.includes("router.post('/site-gate/pin/remove', auth, async")
  && !routesSrc.includes("router.post('/site-gate/pin', auth, requireAdmin")
  && !routesSrc.includes("router.post('/site-gate/pin/remove', auth, requireAdmin")
  && routesSrc.includes("router.get('/admin/stats', auth, requireAdmin")
  && routesSrc.includes("router.post('/admin/users/:id/reset-password', auth, requireAdmin"));
check('routes.js: poner el PIN genera el código de recuperación, guarda su hash y lo devuelve una vez',
  routesSrc.includes('generateRecoveryCode()') && routesSrc.includes("setSiteSetting('gate_recovery_hash'")
  && routesSrc.includes('recoveryCode }') && routesSrc.includes("setSiteSetting('gate_pin_hash'"));
check('routes.js: verify y recover responden 401 genérico (mismo mensaje) y 400 sin PIN',
  routesSrc.includes("error: 'Código incorrecto.'") && routesSrc.includes("error: 'No hay código de acceso puesto.'"));
check('el PIN nunca se guarda en claro ni se loguea (sin console.log del PIN ni del código)',
  !/console\.log\([^)]*(pin|recoveryCode|currentPin)/i.test(routesSrc)
  && !/console\.log\([^)]*(pin|recoveryCode)/i.test(siteGateSrc));
check('siteGate.js no importa ni llama a Kalshi, al auditor o al trader (la puerta no toca nada de eso)',
  !/require\('\.\/(kalshi|kalshiServer|liveTrader|paperAuditor|brti)/.test(siteGateSrc)
  && !siteGateSrc.includes('LIVE_TRADING'));

console.log('v16.5 — 3. Motor intacto y live apagado');
check('el motor no menciona la puerta (kalshi.js, analysis.js, verdict.js, windowOutcome.js)',
  motor.every((m) => !m.includes('siteGate') && !m.includes('site-gate') && !m.includes('cev_gate') && !m.includes('LIVE_TRADING')));
check('LIVE_TRADING_ENABLED no está puesta en el entorno de este test',
  process.env.LIVE_TRADING_ENABLED !== 'true');

// --- HTTP real contra el servidor (modo archivo) ---
console.log('v16.5 — 4. HTTP real: puerta abierta sin PIN');
process.env.JWT_SECRET = 'test-v165-secreto-solo-para-tests';
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
  const rVerify0 = await post('/api/site-gate/verify', { pin: '1234' }, { ip: ip(2) });
  check('HTTP: sin PIN, POST /site-gate/verify → 400 (no hay código puesto)',
    rVerify0.status === 400 && (await jsonDe(rVerify0)).error === 'No hay código de acceso puesto.');
  const rRecover0 = await post('/api/site-gate/recover', { code: 'AAAA-AAAA-AAAA' }, { ip: ip(3) });
  check('HTTP: sin PIN, POST /site-gate/recover → 400 (no hay código puesto)',
    rRecover0.status === 400);
  const rMeSinToken = await get('/api/auth/me');
  check('HTTP: sin PIN, /api/auth/me sin token sigue dando 401 (la puerta abierta no quita el auth)',
    rMeSinToken.status === 401);
  const rRaiz = await get('/');
  check('HTTP: sin PIN, GET / sirve el estático (200, index.html)',
    rRaiz.status === 200 && (await rRaiz.text()).includes('<html'));

  console.log('v16.5 — 5. HTTP real: poner el PIN (cualquier usuario con sesión)');
  const rPinSinToken = await post('/api/site-gate/pin', { pin: '1234' }, { ip: ip(4) });
  check('HTTP: POST /site-gate/pin sin token → 401 (exige sesión)',
    rPinSinToken.status === 401);
  const rPinCorto = await post('/api/site-gate/pin', { pin: 'abc' }, { ip: ip(4), headers: { Authorization: `Bearer ${tokenAdmin}` } });
  check('HTTP: POST /site-gate/pin con PIN de 3 caracteres → 400',
    rPinCorto.status === 400);
  const rPinLargo = await post('/api/site-gate/pin', { pin: 'a'.repeat(33) }, { ip: ip(4), headers: { Authorization: `Bearer ${tokenAdmin}` } });
  check('HTTP: POST /site-gate/pin con PIN de 33 caracteres → 400',
    rPinLargo.status === 400);
  // v16.7 — el usuario (no admin) pone el PIN: ya hay PIN puesto, así
  // que el "poner con admin" posterior pasa a ser un cambio con
  // currentPin (mismo valor) y regenera el código de recuperación.
  const rPinUser = await post('/api/site-gate/pin', { pin: '1234' }, { ip: ip(4), headers: { Authorization: `Bearer ${tokenUser}` } });
  const pinUserJson = await jsonDe(rPinUser);
  const cookieUser = gateCookieDe(rPinUser);
  check('HTTP: POST /site-gate/pin con JWT de usuario (no admin) → 200 (el dueño pone el PIN): devuelve UN código de recuperación válido y pone la cookie de puerta',
    rPinUser.status === 200 && RECOVERY_RE.test(pinUserJson.recoveryCode || '') && typeof cookieUser === 'string' && cookieUser.length > 20);
  const rPin = await post('/api/site-gate/pin', { pin: '1234', currentPin: '1234' }, { ip: ip(4), cookie: cookieUser, headers: { Authorization: `Bearer ${tokenAdmin}` } });
  const pinJson = await jsonDe(rPin);
  const recovery1 = pinJson.recoveryCode;
  const cookieAdmin = gateCookieDe(rPin);
  check('HTTP: POST /site-gate/pin con admin y currentPin cambia el PIN (mismo valor, 200): devuelve UN código de recuperación NUEVO y pone la cookie de puerta',
    rPin.status === 200 && RECOVERY_RE.test(recovery1 || '') && recovery1 !== pinUserJson.recoveryCode && typeof cookieAdmin === 'string' && cookieAdmin.length > 20);
  const rStatus1 = await get('/api/site-gate/status');
  check('HTTP: tras poner el PIN, GET /api/site-gate/status → {locked:true}',
    rStatus1.status === 200 && (await jsonDe(rStatus1)).locked === true);
  check('HTTP: el PIN y el código solo viven como hash en la BD (ni el PIN ni el código en claro en db.json)',
    !readFileSync(dbFile, 'utf8').includes('"1234"') && !readFileSync(dbFile, 'utf8').includes(recovery1));

  console.log('v16.5 — 6. HTTP real: con PIN, sin cookie → 403 site_gate en API y estático');
  const rHealthL = await get('/api/health', { ip: ip(5) });
  check('HTTP: con PIN, GET /api/health sigue 200 (ruta pública)',
    rHealthL.status === 200 && (await jsonDe(rHealthL)).ok === true);
  const rStatusL = await get('/api/site-gate/status', { ip: ip(5) });
  check('HTTP: con PIN, GET /api/site-gate/status sigue 200 (ruta pública)',
    rStatusL.status === 200 && (await jsonDe(rStatusL)).locked === true);
  const rMarketL = await get('/api/kalshi-market', { ip: ip(5) });
  check('HTTP: con PIN y sin cookie, GET /api/kalshi-market → 403 {error:site_gate} (también las /api/* públicas)',
    rMarketL.status === 403 && (await jsonDe(rMarketL)).error === 'site_gate');
  const rMeL = await get('/api/auth/me', { ip: ip(5), headers: { Authorization: `Bearer ${tokenAdmin}` } });
  check('HTTP: con PIN y sin cookie, /api/auth/me con JWT válido → 403 site_gate (la puerta va antes que el auth)',
    rMeL.status === 403 && (await jsonDe(rMeL)).error === 'site_gate');
  const rRaizL = await get('/', { ip: ip(5) });
  check('HTTP: con PIN y sin cookie, GET / → 403 site_gate (el estático también se bloquea)',
    rRaizL.status === 403 && (await jsonDe(rRaizL)).error === 'site_gate');
  const rIndexL = await get('/index.html', { ip: ip(5) });
  check('HTTP: con PIN y sin cookie, GET /index.html → 403 site_gate',
    rIndexL.status === 403 && (await jsonDe(rIndexL)).error === 'site_gate');

  console.log('v16.5 — 7. HTTP real: verify (correcto/incorrecto) y límite de intentos');
  const rVerifyMal = await post('/api/site-gate/verify', { pin: '0000' }, { ip: ip(6) });
  check('HTTP: verify con PIN incorrecto → 401 genérico',
    rVerifyMal.status === 401 && (await jsonDe(rVerifyMal)).error === 'Código incorrecto.');
  for (let i = 0; i < 4; i++) await post('/api/site-gate/verify', { pin: '0000' }, { ip: ip(6) });
  const rVerify6 = await post('/api/site-gate/verify', { pin: '0000' }, { ip: ip(6) });
  check('HTTP: 6º intento incorrecto desde la misma IP → 429 (límite 5 cada 15 min)',
    rVerify6.status === 429);
  const rVerifyBienLimitado = await post('/api/site-gate/verify', { pin: '1234' }, { ip: ip(6) });
  check('HTTP: el PIN correcto desde la IP limitada también da 429 (el límite va antes)',
    rVerifyBienLimitado.status === 429);
  const rVerifyBien = await post('/api/site-gate/verify', { pin: '1234' }, { ip: ip(7) });
  const cookiePin = gateCookieDe(rVerifyBien);
  check('HTTP: verify con el PIN correcto desde otra IP → 200 {ok:true} y pone la cookie de puerta',
    rVerifyBien.status === 200 && (await jsonDe(rVerifyBien)).ok === true && typeof cookiePin === 'string' && cookiePin.length > 20);

  console.log('v16.5 — 8. HTTP real: con cookie válida, todo pasa (y Kalshi sigue exigiendo auth)');
  const rRaizC = await get('/', { ip: ip(8), cookie: cookiePin });
  check('HTTP: con cookie de puerta, GET / sirve el estático (200)',
    rRaizC.status === 200 && (await rRaizC.text()).includes('<html'));
  const rMeC = await get('/api/auth/me', { ip: ip(8), cookie: cookiePin, headers: { Authorization: `Bearer ${tokenAdmin}` } });
  check('HTTP: con cookie de puerta, /api/auth/me con JWT → 200',
    rMeC.status === 200 && (await jsonDe(rMeC)).user?.email === 'admin@ejemplo.com');
  const rLiveSinToken = await get('/api/kalshi/live/status', { ip: ip(8), cookie: cookiePin });
  check('HTTP: con cookie de puerta pero sin token, /api/kalshi/live/status → 401 (la puerta no sustituye al auth)',
    rLiveSinToken.status === 401);
  const rMarketC = await get('/api/kalshi-market', { ip: ip(8), cookie: cookiePin });
  check('HTTP: con cookie de puerta, GET /api/kalshi-market → 200 (la puerta deja pasar; no 403)',
    rMarketC.status === 200);
  const rCookieMala = await get('/', { ip: ip(8), headers: { Cookie: 'cev_gate_v1=eyJhbGciOiJIUzI1NiJ9.malo.firma' } });
  check('HTTP: con cookie de puerta FALSIFICADA, GET / → 403 site_gate (fail-closed)',
    rCookieMala.status === 403 && (await jsonDe(rCookieMala)).error === 'site_gate');

  console.log('v16.5 — 9. HTTP real: cambiar el PIN exige el actual; el código viejo caduca');
  const rCambioSinActual = await post('/api/site-gate/pin', { pin: 'prueba-5678' }, { ip: ip(9), cookie: cookiePin, headers: { Authorization: `Bearer ${tokenAdmin}` } });
  check('HTTP: cambiar el PIN sin currentPin → 401',
    rCambioSinActual.status === 401);
  const rCambioMal = await post('/api/site-gate/pin', { pin: 'prueba-5678', currentPin: '0000' }, { ip: ip(9), cookie: cookiePin, headers: { Authorization: `Bearer ${tokenAdmin}` } });
  check('HTTP: cambiar el PIN con currentPin incorrecto → 401',
    rCambioMal.status === 401);
  const rCambio = await post('/api/site-gate/pin', { pin: 'prueba-5678', currentPin: '1234' }, { ip: ip(9), cookie: cookiePin, headers: { Authorization: `Bearer ${tokenAdmin}` } });
  const cambioJson = await jsonDe(rCambio);
  const recovery2 = cambioJson.recoveryCode;
  check('HTTP: cambiar el PIN con currentPin correcto → 200 y UN código de recuperación NUEVO (distinto del anterior)',
    rCambio.status === 200 && RECOVERY_RE.test(recovery2 || '') && recovery2 !== recovery1);
  const rVerifyViejo = await post('/api/site-gate/verify', { pin: '1234' }, { ip: ip(10) });
  check('HTTP: tras el cambio, el PIN viejo ya no entra (401)',
    rVerifyViejo.status === 401);
  const rRecoverViejo = await post('/api/site-gate/recover', { code: recovery1 }, { ip: ip(11) });
  check('HTTP: tras el cambio, el código de recuperación viejo ya no vale (401)',
    rRecoverViejo.status === 401);
  const rVerifyNuevo = await post('/api/site-gate/verify', { pin: 'prueba-5678' }, { ip: ip(12) });
  const cookiePin2 = gateCookieDe(rVerifyNuevo);
  check('HTTP: el PIN nuevo sí entra (200 + cookie)',
    rVerifyNuevo.status === 200 && typeof cookiePin2 === 'string' && cookiePin2.length > 20);
  const rStatusConCookie = await get('/api/site-gate/status', { ip: ip(12), cookie: cookiePin2 });
  check('HTTP: con PIN y cookie válida, GET /api/site-gate/status → {locked:false} (status por navegador)',
    rStatusConCookie.status === 200 && (await jsonDe(rStatusConCookie)).locked === false);
  const rStatusSinCookie2 = await get('/api/site-gate/status', { ip: ip(12) });
  check('HTTP: con PIN y sin cookie, GET /api/site-gate/status → {locked:true}',
    rStatusSinCookie2.status === 200 && (await jsonDe(rStatusSinCookie2)).locked === true);

  console.log('v16.5 — 10. HTTP real: recover quita el PIN y la puerta queda abierta');
  const rRecoverMal = await post('/api/site-gate/recover', { code: 'AAAA-AAAA-AAAA' }, { ip: ip(13) });
  check('HTTP: recover con código incorrecto → 401 genérico',
    rRecoverMal.status === 401 && (await jsonDe(rRecoverMal)).error === 'Código incorrecto.');
  const rRecover = await post('/api/site-gate/recover', { code: recovery2 }, { ip: ip(14) });
  const recoverJson = await jsonDe(rRecover);
  check('HTTP: recover con el código correcto → 200 {ok:true} y NO pone cookie (ya no hay PIN)',
    rRecover.status === 200 && recoverJson.ok === true && gateCookieDe(rRecover) === null);
  const rStatus2 = await get('/api/site-gate/status', { ip: ip(15) });
  check('HTTP: tras recover, GET /api/site-gate/status → {locked:false}',
    rStatus2.status === 200 && (await jsonDe(rStatus2)).locked === false);
  const rMeAbierta = await get('/api/auth/me', { ip: ip(15) });
  check('HTTP: tras recover, /api/auth/me sin token → 401 (puerta abierta, auth intacto; no 403)',
    rMeAbierta.status === 401);
  const rVerifySinPin = await post('/api/site-gate/verify', { pin: 'prueba-5678' }, { ip: ip(15) });
  check('HTTP: tras recover, verify → 400 (ya no hay PIN)',
    rVerifySinPin.status === 400);

  console.log('v16.5 — 11. HTTP real: quitar el PIN con /pin/remove');
  const rPin2 = await post('/api/site-gate/pin', { pin: '7777' }, { ip: ip(16), headers: { Authorization: `Bearer ${tokenAdmin}` } });
  check('HTTP: poner el PIN de nuevo sin currentPin (no había PIN) → 200',
    rPin2.status === 200 && RECOVERY_RE.test((await jsonDe(rPin2)).recoveryCode || ''));
  const cookiePin3 = gateCookieDe(rPin2);
  const rRemoveSinActual = await post('/api/site-gate/pin/remove', {}, { ip: ip(16), cookie: cookiePin3, headers: { Authorization: `Bearer ${tokenAdmin}` } });
  check('HTTP: /pin/remove sin currentPin → 401',
    rRemoveSinActual.status === 401);
  const rRemoveMal = await post('/api/site-gate/pin/remove', { currentPin: '0000' }, { ip: ip(16), cookie: cookiePin3, headers: { Authorization: `Bearer ${tokenAdmin}` } });
  check('HTTP: /pin/remove con currentPin incorrecto → 401',
    rRemoveMal.status === 401);
  const rRemove = await post('/api/site-gate/pin/remove', { currentPin: '7777' }, { ip: ip(16), cookie: cookiePin3, headers: { Authorization: `Bearer ${tokenAdmin}` } });
  check('HTTP: /pin/remove con currentPin correcto → 200 {ok:true}',
    rRemove.status === 200 && (await jsonDe(rRemove)).ok === true);
  const rStatus3 = await get('/api/site-gate/status', { ip: ip(17) });
  check('HTTP: tras /pin/remove, status → {locked:false}',
    rStatus3.status === 200 && (await jsonDe(rStatus3)).locked === false);
  // v16.7 — el usuario (no admin) también puede quitar el PIN: se
  // vuelve a poner y lo quita él, con el mismo resultado final.
  const rPin3 = await post('/api/site-gate/pin', { pin: '7777' }, { ip: ip(16), headers: { Authorization: `Bearer ${tokenAdmin}` } });
  check('HTTP: poner el PIN otra vez (no había PIN) → 200',
    rPin3.status === 200 && RECOVERY_RE.test((await jsonDe(rPin3)).recoveryCode || ''));
  const cookiePin4 = gateCookieDe(rPin3);
  const rRemoveUser = await post('/api/site-gate/pin/remove', { currentPin: '7777' }, { ip: ip(16), cookie: cookiePin4, headers: { Authorization: `Bearer ${tokenUser}` } });
  check('HTTP: /pin/remove con JWT de usuario (no admin) y currentPin correcto → 200 (el dueño quita el PIN)',
    rRemoveUser.status === 200 && (await jsonDe(rRemoveUser)).ok === true);
  const rStatus3b = await get('/api/site-gate/status', { ip: ip(17) });
  check('HTTP: tras /pin/remove por el usuario, status → {locked:false}',
    rStatus3b.status === 200 && (await jsonDe(rStatus3b)).locked === false);
  const rRemoveSinPin = await post('/api/site-gate/pin/remove', { currentPin: '7777' }, { ip: ip(17), headers: { Authorization: `Bearer ${tokenAdmin}` } });
  check('HTTP: /pin/remove sin PIN puesto → 400',
    rRemoveSinPin.status === 400);
  const rRaizFinal = await get('/', { ip: ip(17) });
  check('HTTP: al final, sin PIN, GET / vuelve a servir el estático (200)',
    rRaizFinal.status === 200);
} finally {
  if (server) await new Promise((r) => server.close(r));
  if (bak) writeFileSync(dbFile, bak);
  else if (existsSync(dbFile)) unlinkSync(dbFile);
}

console.log(`\ntests-v16.5.mjs: ${pass} pasaron, ${fail} fallaron.`);
process.exit(fail ? 1 : 0);
