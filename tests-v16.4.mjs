// tests-v16.4.mjs — Entrada biométrica (WebAuthn/passkeys, Parte 1).
// NADA de esto toca la red de Kalshi ni envía órdenes reales. El
// autenticador es SIMULADO con criptografía real: clave ES256 (P-256)
// generada en el test, attestation 'none' y assertion firmada a mano
// (CBOR con @levischuck/tiny-cbor, dependencia transitiva de
// @simplewebauthn/server). Sin credenciales reales en ningún test:
// el usuario, la clave y el reto son todos de prueba.
// Uso: node tests-v16.4.mjs
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { generateKeyPairSync, createHash, sign, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const webauthn = require('./server/webauthn.js');
const routes = require('./server/routes.js');
const trader = require('./server/liveTrader.js');
const { encodeCBOR } = require('./server/node_modules/@levischuck/tiny-cbor');

const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const appJsx = src('client/src/App.jsx');
const authModalJsx = src('client/src/components/AuthModal.jsx');
const webRegJsx = src('client/src/components/WebauthnRegister.jsx');
const accountBoxJsx = src('client/src/components/AccountBox.jsx');
const clientWebauthn = src('client/src/webauthn.js');
const clientAuth = src('client/src/auth.js');
const routesSrc = src('server/routes.js');
const dbSrc = src('server/db.js');
const schemaSql = src('server/schema.sql');
const auditorSrc = src('server/paperAuditor.js');
const versionTxt = src('VERSION.txt');
const motor = ['client/src/kalshi.js', 'client/src/analysis.js', 'client/src/verdict.js', 'client/src/windowOutcome.js'].map(src);

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(String(s), 'base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Autenticador simulado (ES256 real) ---
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' });
const CRED_ID = randomBytes(16);
const RP_ID = webauthn.RP_ID;
const ORIGIN = webauthn.PROD_ORIGIN;

function cosePublicKey() {
  return Buffer.from(encodeCBOR(new Map([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, fromB64url(jwk.x)],
    [-3, fromB64url(jwk.y)],
  ])));
}
function clientDataJSON(type, challenge) {
  return Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }), 'utf8');
}
function authDataRegistro() {
  const rpIdHash = createHash('sha256').update(RP_ID).digest();
  const flags = Buffer.from([0x45]); // UP | UV | AT
  const counter = Buffer.alloc(4); // 0
  const aaguid = Buffer.alloc(16);
  const credIdLen = Buffer.alloc(2);
  credIdLen.writeUInt16BE(CRED_ID.length, 0);
  return Buffer.concat([rpIdHash, flags, counter, aaguid, credIdLen, CRED_ID, cosePublicKey()]);
}
function respuestaRegistro(challenge) {
  const attestationObject = Buffer.from(encodeCBOR(new Map([
    ['fmt', 'none'],
    ['attStmt', new Map()],
    ['authData', authDataRegistro()],
  ])));
  return {
    id: b64url(CRED_ID),
    rawId: b64url(CRED_ID),
    response: {
      clientDataJSON: b64url(clientDataJSON('webauthn.create', challenge)),
      attestationObject: b64url(attestationObject),
      transports: ['internal'],
    },
    type: 'public-key',
    clientExtensionResults: {},
  };
}
function respuestaLogin(challenge, counter) {
  const rpIdHash = createHash('sha256').update(RP_ID).digest();
  const flags = Buffer.from([0x05]); // UP | UV
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(counter, 0);
  const authData = Buffer.concat([rpIdHash, flags, counterBuf]);
  const clientData = clientDataJSON('webauthn.get', challenge);
  // La firma ES256 del autenticador va en DER (ASN.1 ECDSASigValue),
  // como manda WebAuthn: es lo que @simplewebauthn/server espera y
  // desempaqueta (unwrapEC2Signature). Node la devuelve en DER por defecto.
  const firma = sign(null, Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), privateKey);
  return {
    id: b64url(CRED_ID),
    rawId: b64url(CRED_ID),
    response: {
      clientDataJSON: b64url(clientData),
      authenticatorData: b64url(authData),
      signature: b64url(firma),
    },
    type: 'public-key',
    clientExtensionResults: {},
  };
}

// --- BD falsa con la misma interfaz que server/db.js ---
function crearDbFalsa() {
  const creds = new Map();
  const usuarios = new Map([
    [164001, { id: 164001, email: 'prueba@ejemplo.com', name: 'Prueba', role: 'user', active: true }],
  ]);
  return {
    _creds: creds,
    async getUserByEmail(email) {
      for (const u of usuarios.values()) if (u.email === String(email).toLowerCase()) return u;
      return null;
    },
    async getUserById(id) { return usuarios.get(Number(id)) || null; },
    async listWebauthnCredentials(userId) {
      return [...creds.values()].filter((c) => c.user_id === Number(userId));
    },
    async addWebauthnCredential(c) {
      if (creds.has(c.credentialId)) return false;
      creds.set(c.credentialId, {
        credential_id: c.credentialId, user_id: c.userId, public_key: c.publicKey,
        counter: c.counter, transports: c.transports, created_at: new Date().toISOString(), last_used_at: null,
      });
      return true;
    },
    async getWebauthnCredentialById(id) { return creds.get(String(id)) || null; },
    async updateWebauthnCounter(id, counter) {
      const c = creds.get(String(id));
      if (!c) return false;
      c.counter = counter;
      c.last_used_at = new Date().toISOString();
      return true;
    },
  };
}
const usuarioPrueba = { id: 164001, email: 'prueba@ejemplo.com', name: 'Prueba', role: 'user' };

console.log('v16.4 — 1. Constantes y librería');
check('@simplewebauthn/server v14 instalado en server/ (generate/verify Registration + Authentication)',
  (() => { try { const s = require('./server/node_modules/@simplewebauthn/server'); return ['generateRegistrationOptions', 'verifyRegistrationResponse', 'generateAuthenticationOptions', 'verifyAuthenticationResponse'].every((f) => typeof s[f] === 'function'); } catch { return false; } })());
check('server/package.json depende de @simplewebauthn/server',
  src('server/package.json').includes('@simplewebauthn/server'));
check('rpID es cripto-en-vivo.onrender.com (fijo, producción)',
  webauthn.RP_ID === 'cripto-en-vivo.onrender.com' && webauthn.PROD_ORIGIN === 'https://cripto-en-vivo.onrender.com');
check('el reto vive 5 minutos (CHALLENGE_TTL_MS = 300000)',
  webauthn.CHALLENGE_TTL_MS === 5 * 60 * 1000);
check('la verificación criptográfica la hace la librería (nada a mano en webauthn.js)',
  src('server/webauthn.js').includes("require('@simplewebauthn/server')")
  && src('server/webauthn.js').includes('verifyRegistrationResponse')
  && src('server/webauthn.js').includes('verifyAuthenticationResponse'));
check('se exige verificación de usuario (huella/rostro/PIN) al registrar y al entrar',
  (src('server/webauthn.js').match(/requireUserVerification: true/g) || []).length >= 2);
check('solo autenticador de plataforma (sin llaves USB)',
  src('server/webauthn.js').includes("authenticatorAttachment: 'platform'"));

console.log('v16.4 — 2. Challenges de un solo uso y con expiración');
{
  webauthn.guardarChallenge('test:1', 'reto-abc');
  check('consumirChallenge devuelve el reto guardado la primera vez',
    webauthn.consumirChallenge('test:1') === 'reto-abc');
  check('el mismo reto reutilizado da null (un solo uso)',
    webauthn.consumirChallenge('test:1') === null);
  webauthn.guardarChallenge('test:2', 'reto-def');
  check('un reto distinto al guardado da null',
    webauthn.consumirChallenge('test:2', 'reto-otro') === null);
  check('tras un intento con reto distinto, el reto ya no existe (se borra al consumir)',
    webauthn.consumirChallenge('test:2') === null);
  webauthn.guardarChallenge('test:3', 'reto-viejo');
  webauthn._challenges.get('test:3').expiresAt = Date.now() - 1000;
  check('un reto caducado da null',
    webauthn.consumirChallenge('test:3') === null);
}

console.log('v16.4 — 3. Registro WebAuthn con autenticador simulado (ES256 real)');
let dbFalsa;
{
  dbFalsa = crearDbFalsa();
  const options = await webauthn.crearOpcionesRegistro(dbFalsa, usuarioPrueba);
  check('crearOpcionesRegistro devuelve options con challenge y rpId de producción',
    typeof options.challenge === 'string' && options.challenge.length > 10
    && options.rp && options.rp.id === 'cripto-en-vivo.onrender.com');
  check('las opciones excluyen las credenciales ya registradas (vacío al inicio)',
    Array.isArray(options.excludeCredentials) && options.excludeCredentials.length === 0);
  const resp = respuestaRegistro(options.challenge);
  const guardada = await webauthn.verificarRegistro(dbFalsa, usuarioPrueba, resp);
  check('verificarRegistro acepta la attestation simulada y devuelve el credentialId',
    guardada && guardada.credentialId === b64url(CRED_ID));
  const lista = await dbFalsa.listWebauthnCredentials(usuarioPrueba.id);
  check('la credencial queda guardada: clave pública (base64url), contador 0, transports internal',
    lista.length === 1 && typeof lista[0].public_key === 'string' && lista[0].public_key.length > 50
    && lista[0].counter === 0 && lista[0].transports.includes('internal'));
  check('la clave pública guardada es la COSE ES256 del simulador (no la privada)',
    !JSON.stringify(lista).includes('private') && lista[0].public_key !== b64url(CRED_ID));
  // Re-registrar la MISMA credencial: el reto se consume y la librería
  // o el duplicado la rechazan (en cualquier caso, no se guarda otra).
  const options2 = await webauthn.crearOpcionesRegistro(dbFalsa, usuarioPrueba);
  check('al re-registrar, excludeCredentials ya trae la credencial existente',
    options2.excludeCredentials.length === 1 && options2.excludeCredentials[0].id === b64url(CRED_ID));
  let rechazoDuplicado = null;
  try { await webauthn.verificarRegistro(dbFalsa, usuarioPrueba, respuestaRegistro(options2.challenge)); }
  catch (e) { rechazoDuplicado = e; }
  check('re-registrar la misma credencial se rechaza',
    rechazoDuplicado instanceof Error && (await dbFalsa.listWebauthnCredentials(usuarioPrueba.id)).length === 1);
  // Reto reutilizado en registro: el segundo intento con el mismo
  // challenge (ya consumido) se rechaza sin verificar.
  let rechazoReuso = null;
  try { await webauthn.verificarRegistro(dbFalsa, usuarioPrueba, respuestaRegistro(options.challenge)); }
  catch (e) { rechazoReuso = e; }
  check('reutilizar el reto de registro se rechaza (caducó o ya se usó)',
    rechazoReuso instanceof Error && /caducó o ya se usó/.test(rechazoReuso.message));
}

console.log('v16.4 — 4. Login WebAuthn con autenticador simulado (assertion firmada)');
{
  const r = await webauthn.crearOpcionesLogin(dbFalsa, 'prueba@ejemplo.com');
  check('crearOpcionesLogin devuelve options con allowCredentials de la credencial registrada',
    r && Array.isArray(r.options.allowCredentials) && r.options.allowCredentials.length === 1
    && r.options.allowCredentials[0].id === b64url(CRED_ID));
  const respLogin = { ...respuestaLogin(r.options.challenge, 1), email: 'prueba@ejemplo.com' };
  const user = await webauthn.verificarLogin(dbFalsa, respLogin);
  check('verificarLogin acepta la assertion firmada y devuelve el usuario',
    user && user.id === 164001 && user.email === 'prueba@ejemplo.com');
  const trasLogin = await dbFalsa.getWebauthnCredentialById(b64url(CRED_ID));
  check('tras el login el contador sube de 0 a 1 (anti-replay)',
    trasLogin.counter === 1);
  // Replay: la MISMA assertion otra vez (reto ya consumido).
  let rechazoReplay = null;
  try { await webauthn.verificarLogin(dbFalsa, respLogin); }
  catch (e) { rechazoReplay = e; }
  check('reutilizar la misma assertion se rechaza (reto de un solo uso)',
    rechazoReplay instanceof Error && /caducó o ya se usó/.test(rechazoReplay.message));
  // Contador que no crece: assertion nueva (reto nuevo) con contador 1
  // cuando el guardado ya es 1.
  const r2 = await webauthn.crearOpcionesLogin(dbFalsa, 'prueba@ejemplo.com');
  let rechazoContador = null;
  try { await webauthn.verificarLogin(dbFalsa, { ...respuestaLogin(r2.options.challenge, 1), email: 'prueba@ejemplo.com' }); }
  catch (e) { rechazoContador = e; }
  check('una assertion con contador que no crece se rechaza (posible replay/clon)',
    rechazoContador instanceof Error);
  check('tras el rechazo por contador, el contador guardado sigue en 1',
    (await dbFalsa.getWebauthnCredentialById(b64url(CRED_ID))).counter === 1);
  // Contador 2 sí pasa (el flujo normal sigue funcionando).
  const r3 = await webauthn.crearOpcionesLogin(dbFalsa, 'prueba@ejemplo.com');
  const user2 = await webauthn.verificarLogin(dbFalsa, { ...respuestaLogin(r3.options.challenge, 2), email: 'prueba@ejemplo.com' });
  check('una assertion con contador 2 (mayor que 1) sí entra, y el contador queda en 2',
    user2 && user2.id === 164001 && (await dbFalsa.getWebauthnCredentialById(b64url(CRED_ID))).counter === 2);
  // Challenge manipulado: la assertion firma otro reto distinto al guardado.
  const r4 = await webauthn.crearOpcionesLogin(dbFalsa, 'prueba@ejemplo.com');
  let rechazoReto = null;
  try {
    await webauthn.verificarLogin(dbFalsa, {
      ...respuestaLogin('cmV0by1mYWxzbw', 3),
      email: 'prueba@ejemplo.com',
    });
  } catch (e) { rechazoReto = e; }
  check('una assertion con challenge manipulado se rechaza',
    rechazoReto instanceof Error);
  void r4;
  // Sin credenciales registradas: null (el cliente muestra el password).
  const dbVacia = crearDbFalsa();
  dbVacia._creds.clear();
  check('crearOpcionesLogin sin credenciales devuelve null',
    (await webauthn.crearOpcionesLogin(dbVacia, 'prueba@ejemplo.com')) === null);
  check('crearOpcionesLogin con email desconocido devuelve null',
    (await webauthn.crearOpcionesLogin(dbVacia, 'nadie@ejemplo.com')) === null);
}

console.log('v16.4 — 5. Rutas, persistencia y login con password intacto');
check('routes.js tiene las 4 rutas WebAuthn',
  routesSrc.includes("router.post('/auth/webauthn/register/options'")
  && routesSrc.includes("router.post('/auth/webauthn/register/verify'")
  && routesSrc.includes("router.post('/auth/webauthn/login/options'")
  && routesSrc.includes("router.post('/auth/webauthn/login/verify'"));
check('routes.js tiene GET /auth/webauthn/credentials (sin claves públicas)',
  routesSrc.includes("router.get('/auth/webauthn/credentials'") && routesSrc.includes('credentialId: c.credential_id'));
check('el login con WebAuthn devuelve el mismo token JWT (signToken) que el password',
  routesSrc.includes("router.post('/auth/webauthn/login/verify'") && routesSrc.includes('signToken(pub)'));
check('el login con password sigue intacto (verifyPassword + DUMMY_HASH + 401)',
  routesSrc.includes("router.post('/auth/login'") && routesSrc.includes('verifyPassword(password, user ? user.password_hash : DUMMY_HASH)')
  && routesSrc.includes("Email o contraseña incorrectos."));
check('auth.js sigue exportando hashPassword/verifyPassword/signToken sin cambios de conducta',
  src('server/auth.js').includes('function hashPassword') && src('server/auth.js').includes('function verifyPassword')
  && src('server/auth.js').includes('function signToken'));
check('db.js y schema.sql crean la tabla cev_webauthn_credentials (clave pública + contador + transports)',
  dbSrc.includes('CREATE TABLE IF NOT EXISTS cev_webauthn_credentials') && schemaSql.includes('CREATE TABLE IF NOT EXISTS cev_webauthn_credentials')
  && dbSrc.includes('addWebauthnCredential') && dbSrc.includes('updateWebauthnCounter')
  && dbSrc.includes('getWebauthnCredentialById') && dbSrc.includes('listWebauthnCredentials'));
check('db.js: la tabla referencia al usuario con ON DELETE CASCADE',
  dbSrc.includes('REFERENCES cev_users(id) ON DELETE CASCADE'));

console.log('v16.4 — 6. Cliente: botones de huella / rostro y soporte');
check('AuthModal.jsx tiene el botón «Entrar con huella / rostro» (navigator.credentials.get)',
  authModalJsx.includes('Entrar con huella / rostro') && clientWebauthn.includes('navigator.credentials.get'));
check('AuthModal.jsx explica cuando el dispositivo no admite huella/rostro (botón deshabilitado)',
  authModalJsx.includes('disabled={!webauthnAvailable') && authModalJsx.includes('no tiene huella ni rostro disponible'));
check('WebauthnRegister.jsx tiene «Registrar huella / rostro en este dispositivo» (navigator.credentials.create)',
  webRegJsx.includes('Registrar huella / rostro en este dispositivo') && clientWebauthn.includes('navigator.credentials.create'));
check('WebauthnRegister.jsx no muestra el botón si no hay soporte (solo explicación)',
  webRegJsx.includes('isWebauthnSupported()') && webRegJsx.includes('no tiene huella ni rostro disponible'));
check('AccountBox.jsx muestra el registro de huella con sesión iniciada',
  accountBoxJsx.includes('WebauthnRegister'));
check('App.jsx pasa webauthnAvailable/onWebauthnLogin al modal y guarda la sesión tras el login por huella',
  appJsx.includes('handleWebauthnLogin') && appJsx.includes('webauthnAvailable={webauthnAvailable}')
  && appJsx.includes('onWebauthnLogin={handleWebauthnLogin}') && clientWebauthn.includes('saveToken(data.token)'));
check('client/src/webauthn.js comprueba PublicKeyCredential y el autenticador de plataforma',
  clientWebauthn.includes('window.PublicKeyCredential') && clientWebauthn.includes('isUserVerifyingPlatformAuthenticatorAvailable'));
check('client/src/auth.js exporta saveToken para el login por huella',
  clientAuth.includes('export function saveToken'));

console.log('v16.4 — 7. Versión, motor intacto, live sigue apagado');
check("VERSION_LABEL es 'v16.5 — PIN de acceso antes de la web'",
  appJsx.includes("const VERSION_LABEL = 'v16.5 — PIN de acceso antes de la web';"));
check('VERSION.txt documenta la Parte 1 (WebAuthn, rpID, challenges, Parte 2 pendiente)',
  versionTxt.includes('v16.4 — Entrada biométrica') && versionTxt.includes('cripto-en-vivo.onrender.com')
  && versionTxt.includes('Challenges de un solo uso') && versionTxt.includes('Parte 2'));
check('el motor no menciona WebAuthn (kalshi.js, analysis.js, verdict.js, windowOutcome.js)',
  motor.every((m) => !m.includes('webauthn') && !m.includes('WebAuthn')));
check('la fórmula del denominador NO cambió: totalMuestrasEfectivas = N + (R-1)',
  auditorSrc.includes('const totalMuestrasEfectivas = muestrasCapturadas + segundosRestantesReales;'));
check('live sigue APAGADO por defecto (isLiveEnabled false sin la env)',
  trader.isLiveEnabled() === false);
check('LIVE_TRADING_ENABLED no está puesta en el entorno de este test',
  process.env.LIVE_TRADING_ENABLED !== 'true');

// --- 8. Extremo a extremo contra el servidor real (modo archivo) ---
console.log('v16.4 — 8. HTTP real: registro + login por huella + password intacto');
{
  // Entorno de prueba: secreto propio, sin DATABASE_URL (modo archivo),
  // sin admin por variables de entorno (el registro queda abierto al
  // no haber usuarios). Se respalda server/data/db.json y se restaura.
  process.env.JWT_SECRET = 'test-v164-secreto-solo-para-tests';
  process.env.NODE_ENV = 'test';
  delete process.env.DATABASE_URL;
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;
  const dbFile = path.join(ROOT, 'server', 'data', 'db.json');
  const bak = existsSync(dbFile) ? readFileSync(dbFile) : null;
  if (existsSync(dbFile)) unlinkSync(dbFile);
  let server = null;
  try {
    const app = require('./server/app.js');
    await sleep(500); // init() de routes en segundo plano (db.init)
    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const get = (p, headers = {}) => fetch(base + p, { headers });

    const rReg = await post('/api/auth/register', { email: 'http@ejemplo.com', password: 'Contrasena123', name: 'Http' });
    check('HTTP: registro con password crea la cuenta (201 + token)',
      rReg.status === 201 && !!(await rReg.clone().json().catch(() => ({}))).token);
    const regJson = await rReg.json().catch(() => ({}));
    const tokenPass = regJson.token;

    const rLogin = await post('/api/auth/login', { email: 'http@ejemplo.com', password: 'Contrasena123' });
    check('HTTP: login con password sigue funcionando (200 + token)',
      rLogin.status === 200 && !!(await rLogin.json()).token);
    const rLoginMal = await post('/api/auth/login', { email: 'http@ejemplo.com', password: 'incorrecta' });
    check('HTTP: login con password incorrecta sigue dando 401',
      rLoginMal.status === 401);

    const rOpts = await post('/api/auth/webauthn/register/options', {}, { Authorization: `Bearer ${tokenPass}` });
    const optsJson = await rOpts.json();
    check('HTTP: POST /auth/webauthn/register/options con JWT devuelve options (200)',
      rOpts.status === 200 && typeof optsJson.options?.challenge === 'string');
    const rVerify = await post('/api/auth/webauthn/register/verify', respuestaRegistro(optsJson.options.challenge), { Authorization: `Bearer ${tokenPass}` });
    const verifyJson = await rVerify.json();
    check('HTTP: POST /auth/webauthn/register/verify con attestation simulada guarda la credencial (200)',
      rVerify.status === 200 && verifyJson.ok === true && verifyJson.credential?.credentialId === b64url(CRED_ID));

    const rLista = await get('/api/auth/webauthn/credentials', { Authorization: `Bearer ${tokenPass}` });
    const listaJson = await rLista.json();
    check('HTTP: GET /auth/webauthn/credentials lista 1 credencial SIN clave pública',
      rLista.status === 200 && listaJson.credentials?.length === 1 && !('public_key' in (listaJson.credentials[0] || {})) && !('publicKey' in (listaJson.credentials[0] || {})));

    const rLoginOpts = await post('/api/auth/webauthn/login/options', { email: 'http@ejemplo.com' });
    const loginOptsJson = await rLoginOpts.json();
    check('HTTP: POST /auth/webauthn/login/options devuelve options con la credencial (200)',
      rLoginOpts.status === 200 && loginOptsJson.options?.allowCredentials?.length === 1);
    const cuerpoLogin = { ...respuestaLogin(loginOptsJson.options.challenge, 1), email: 'http@ejemplo.com' };
    const rLoginBio = await post('/api/auth/webauthn/login/verify', cuerpoLogin);
    const loginBioJson = await rLoginBio.json();
    check('HTTP: POST /auth/webauthn/login/verify con assertion firmada devuelve token JWT (200)',
      rLoginBio.status === 200 && typeof loginBioJson.token === 'string' && loginBioJson.user?.email === 'http@ejemplo.com');
    const rMe = await get('/api/auth/me', { Authorization: `Bearer ${loginBioJson.token}` });
    check('HTTP: el token del login por huella abre /api/auth/me (200)',
      rMe.status === 200 && (await rMe.json()).user?.email === 'http@ejemplo.com');

    const rReplay = await post('/api/auth/webauthn/login/verify', cuerpoLogin);
    check('HTTP: reutilizar la misma assertion da 400 (reto de un solo uso)',
      rReplay.status === 400);
    const rLoginOpts2 = await post('/api/auth/webauthn/login/options', { email: 'http@ejemplo.com' });
    const loginOpts2 = await rLoginOpts2.json();
    void loginOpts2;
    const rRetoFalso = await post('/api/auth/webauthn/login/verify', {
      ...respuestaLogin('cmV0by1mYWxzbw', 2),
      email: 'http@ejemplo.com',
    });
    check('HTTP: assertion con challenge manipulado da 400',
      rRetoFalso.status === 400);
    const rSinHuella = await post('/api/auth/webauthn/login/options', { email: 'nadie@ejemplo.com' });
    check('HTTP: login/options con email sin huella da 404 (entra con contraseña)',
      rSinHuella.status === 404);
    const rSinToken = await post('/api/auth/webauthn/register/options', {});
    check('HTTP: register/options sin token da 401 (exige sesión)',
      rSinToken.status === 401);
    const rLoginFinal = await post('/api/auth/login', { email: 'http@ejemplo.com', password: 'Contrasena123' });
    check('HTTP: tras todo lo anterior, el login con password sigue en 200',
      rLoginFinal.status === 200);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    if (bak) writeFileSync(dbFile, bak);
    else if (existsSync(dbFile)) unlinkSync(dbFile);
  }
}

// --- v16.4 Parte 2: experimento live acotado (SOLO LOCAL) ---
// Sin credenciales reales en ningún test: las claves son 'k'/'p'
// de mentira, la red está stubbeada y live solo se enciende en
// process.env dentro de cada bloque (se restaura al salir).
console.log('v16.4 — 9. HTTP real: ruta POST /kalshi/live/experiment');
{
  // Mismo entorno que la §8 (JWT_SECRET de prueba, modo archivo).
  // Se entra con el usuario creado en la §8 (sigue en la BD en
  // memoria); se respalda server/data/db.json y se restaura byte a
  // byte al terminar (setExperiment persiste en live_trade_log).
  const dbFile = path.join(ROOT, 'server', 'data', 'db.json');
  const bak = existsSync(dbFile) ? readFileSync(dbFile) : null;
  let server = null;
  try {
    const app = require('./server/app.js');
    await sleep(300);
    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const get = (p, headers = {}) => fetch(base + p, { headers });

    const rHealth = await get('/api/health');
    check('HTTP: GET /api/health OK (200)',
      rHealth.status === 200 && (await rHealth.json()).ok === true);
    const rStatusSinToken = await get('/api/kalshi/live/status');
    check('HTTP: GET /api/kalshi/live/status sin token da 401',
      rStatusSinToken.status === 401);
    const rLogin = await post('/api/auth/login', { email: 'http@ejemplo.com', password: 'Contrasena123' });
    const loginJson = await rLogin.json();
    check('HTTP: login del usuario de la §8 sigue en 200 (para probar la ruta del experimento)',
      rLogin.status === 200 && typeof loginJson.token === 'string');
    const token = loginJson.token;
    const rExpSinToken = await post('/api/kalshi/live/experiment', { experimentMode: true });
    check('HTTP: POST /kalshi/live/experiment sin token da 401 (exige sesión)',
      rExpSinToken.status === 401);
    const rExpOn = await post('/api/kalshi/live/experiment', { experimentMode: true }, { Authorization: `Bearer ${token}` });
    const expOnJson = await rExpOn.json();
    check('HTTP: activar el experimento (200): enabled, 1 contrato, tope $5',
      rExpOn.status === 200 && expOnJson.experiment?.enabled === true
      && expOnJson.experiment?.contractsPerOrder === 1
      && expOnJson.experiment?.maxNotionalUsdPerOrder === 5
      && expOnJson.limits?.maxContractsPerOrder === 1
      && expOnJson.limits?.maxNotionalUsdPerOrder === 5);
    const rStatus = await get('/api/kalshi/live/status', { Authorization: `Bearer ${token}` });
    const statusJson = await rStatus.json();
    check('HTTP: GET /api/kalshi/live/status con token expone el experimento activo (live sigue apagado)',
      rStatus.status === 200 && statusJson.experiment?.enabled === true && statusJson.liveEnabled === false);
    const rExpMal = await post('/api/kalshi/live/experiment', { experimentMode: true, contractsPerOrder: 3 }, { Authorization: `Bearer ${token}` });
    check('HTTP: activar con contractsPerOrder 3 da 400 (validación)',
      rExpMal.status === 400);
    const rExpOff = await post('/api/kalshi/live/experiment', { experimentMode: false }, { Authorization: `Bearer ${token}` });
    const expOffJson = await rExpOff.json();
    check('HTTP: desactivar el experimento (200): vuelve el default global 2, sin tope',
      rExpOff.status === 200 && expOffJson.experiment?.enabled === false
      && expOffJson.limits?.maxContractsPerOrder === 2
      && expOffJson.limits?.maxNotionalUsdPerOrder === null);
    const rEnable = await post('/api/kalshi/live/enable', {}, { Authorization: `Bearer ${token}` });
    check('HTTP: POST /kalshi/live/enable sigue dando 403 (configurar el experimento NO enciende live)',
      rEnable.status === 403);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    if (bak) writeFileSync(dbFile, bak);
    else if (existsSync(dbFile)) unlinkSync(dbFile);
  }
}

// Señal viable en papel, NO a 20¢ (misma que v16.2, con count 1.00).
const senalExp = (ticker = 'KXBTC15M-26NOV181430-00', over = {}) => ({
  ticker,
  viableDespuesDeComision: true,
  direccionElegida: 'no',
  askPriceDollars: '0.2000',
  feePerContractDollars: 0.0112,
  ordenV2Preview: { payload: { ticker, client_order_id: 'c-exp-1', side: 'ask', count: '1.00', price: '0.8000' } },
  ...over,
});
const senalExpQty = (count, ask = '0.2000', ticker = 'KXBTC15M-26NOV181430-00') => senalExp(ticker, {
  askPriceDollars: ask,
  ordenV2Preview: { payload: { ticker, client_order_id: 'c-exp-2', side: 'ask', count, price: '0.8000' } },
});
const ahoraIso = () => new Date().toISOString();

console.log('v16.4 — 10. Parte 2: límites del experimento (puros + setExperiment)');
const {
  crearEstadoTrader: crearEstadoP2, limitesEfectivos, setExperiment: setExp,
  verificarLimites: verificarP2, getSnapshot: snapshotP2,
} = trader;
const persistidosExp = [];
trader.setPersistencia(async (userId, estado) => { persistidosExp.push({ userId, estado }); });
trader.setCargarEstado(async () => null);
trader.setBalanceProvider(null);
{
  const est0 = crearEstadoP2();
  est0.armed = true;
  check('default global sigue siendo 2 contratos, sin tope de notional, 5 órdenes/día (y 2 contratos pasan)',
    limitesEfectivos(est0).maxContractsPerOrder === 2 && limitesEfectivos(est0).maxNotionalUsdPerOrder === null
    && limitesEfectivos(est0).maxOrdersPerDay === 5 && verificarP2(est0, senalExpQty('2.00')).ok === true);
  const snapExp = await setExp(994001, { experimentMode: true });
  check('setExperiment activa el modo: 1 contrato, tope $5, 5 órdenes/día (snapshot y limits)',
    snapExp.experiment?.enabled === true && snapExp.experiment?.contractsPerOrder === 1
    && snapExp.experiment?.maxNotionalUsdPerOrder === 5 && snapExp.experiment?.maxOrdersPerDay === 5
    && snapExp.limits?.maxContractsPerOrder === 1 && snapExp.limits?.maxNotionalUsdPerOrder === 5);
  check('setExperiment persiste el modo en live_trade_log (hook con experiment.enabled true)',
    persistidosExp.some((p) => p.userId === 994001 && p.estado.experiment?.enabled === true));
  const estExp = trader._traders.get(994001);
  estExp.armed = true;
  check('en modo experimento, 2 contratos se bloquean (max_contracts_per_order) aunque el global sea 2',
    verificarP2(estExp, senalExpQty('2.00')).reason === 'max_contracts_per_order');
  await setExp(994002, { experimentMode: true, maxNotionalUsdPerOrder: 0.5 });
  const estN = trader._traders.get(994002);
  estN.armed = true;
  check('tope de notional: 1 contrato a $0.80 con tope $0.50 se bloquea (max_notional_per_order)',
    verificarP2(estN, senalExpQty('1.00', '0.8000')).reason === 'max_notional_per_order');
  check('tope de notional: 1 contrato a $0.20 con tope $5 pasa (notional $0.20)',
    verificarP2(estExp, senalExp()).ok === true);
  check('guarda de saldo: saldo $0.10 < costo $0.2112 bloquea (insufficient_balance)',
    verificarP2(estExp, senalExp(), { balanceUsd: 0.10 }).reason === 'insufficient_balance');
  check('guarda de saldo: saldo $40 (el de Luis) cubre el costo y pasa',
    verificarP2(estExp, senalExp(), { balanceUsd: 40 }).ok === true);
  check('guarda de saldo: saldo desconocido (null) no bloquea en la función pura (decide el llamador)',
    verificarP2(estExp, senalExp(), { balanceUsd: null }).ok === true);
  async function rechazaSetExp(cfg) { try { await setExp(994009, cfg); return false; } catch { return true; } }
  check('setExperiment rechaza contractsPerOrder 3, notional -1 y maxOrdersPerDay 0',
    await rechazaSetExp({ experimentMode: true, contractsPerOrder: 3 })
    && await rechazaSetExp({ experimentMode: true, maxNotionalUsdPerOrder: -1 })
    && await rechazaSetExp({ experimentMode: true, maxOrdersPerDay: 0 }));
  const snapOff = await setExp(994001, { experimentMode: false });
  check('desactivar el experimento restaura el default global (2 contratos, sin tope) y 2 contratos pasan',
    snapOff.experiment?.enabled === false && snapOff.limits?.maxContractsPerOrder === 2
    && snapOff.limits?.maxNotionalUsdPerOrder === null && verificarP2(estExp, senalExpQty('2.00')).ok === true);
  const snapVacio = snapshotP2(994099);
  check('getSnapshot sin estado: límites globales (2, sin tope) y experimento apagado',
    snapVacio.limits?.maxContractsPerOrder === 2 && snapVacio.limits?.maxNotionalUsdPerOrder === null
    && snapVacio.experiment?.enabled === false);
  check('constantes del experimento exportadas: 1 contrato, $5 notional, 5 órdenes/día',
    trader.EXPERIMENT_CONTRACTS_PER_ORDER === 1 && trader.EXPERIMENT_MAX_NOTIONAL_USD_PER_ORDER === 5
    && trader.EXPERIMENT_MAX_ORDERS_PER_DAY === 5);
}

console.log('v16.4 — 11. Parte 2: conciliación del llenado y resultado realizado');
const {
  conciliarOrdenEnviada: conciliarP2, calcularResultadoRealizado: resultadoP2,
  registrarLiquidacion: liquidarP2, handleViableSignal: handleP2, arm: armP2,
} = trader;
const fillsDe1 = (ticker) => ({ fills: [{ ticker, side: 'no', action: 'buy', count_fp: '1.00', price_dollars: '0.20', created_time: ahoraIso() }] });
{
  const conc = await conciliarP2({
    keyId: 'k', privateKeyPem: 'p', orderId: 'ord-1', clientOrderId: 'c-exp-1',
    ticker: 'KXBTC15M-26NOV181430-00', side: 'no', placedAt: Date.now(),
    consultarOrdenFn: async () => ({ orderId: 'ord-1', clientOrderId: 'c-exp-1', status: 'executed' }),
    fillsFn: async () => fillsDe1('KXBTC15M-26NOV181430-00'),
  });
  check('conciliar orden ejecutada + 1 fill: filledQty 1, precio medio $0.20, fillStatus filled',
    conc && conc.filledQty === 1 && conc.avgFillPriceDollars === 0.20 && conc.fillStatus === 'filled');
  const concVacia = await conciliarP2({
    keyId: 'k', privateKeyPem: 'p', orderId: 'ord-2', clientOrderId: 'c-exp-2',
    ticker: 'KXBTC15M-26NOV181430-00', side: 'no', placedAt: Date.now(),
    consultarOrdenFn: async () => ({ orderId: 'ord-2', clientOrderId: 'c-exp-2', status: 'resting' }),
    fillsFn: async () => ({ fills: [] }),
  });
  check('conciliar orden resting sin fills: filledQty 0, fillStatus none (no se inventa un llenado)',
    concVacia && concVacia.filledQty === 0 && concVacia.fillStatus === 'none');
  const concNula = await conciliarP2({
    keyId: 'k', privateKeyPem: 'p', orderId: 'ord-3', clientOrderId: 'c-exp-3',
    ticker: 'KXBTC15M-26NOV181430-00', side: 'no', placedAt: Date.now(),
    consultarOrdenFn: async () => null,
    fillsFn: async () => ({ fills: [] }),
  });
  check('conciliar orden que Kalshi no tiene devuelve null',
    concNula === null);
  const concSinFills = await conciliarP2({
    keyId: 'k', privateKeyPem: 'p', orderId: 'ord-4', clientOrderId: 'c-exp-4',
    ticker: 'KXBTC15M-26NOV181430-00', side: 'no', placedAt: Date.now(),
    consultarOrdenFn: async () => ({ orderId: 'ord-4', clientOrderId: 'c-exp-4', status: 'executed' }),
    fillsFn: async () => { throw new Error('Kalshi HTTP 500'); },
  });
  check('conciliar con fills que fallan: filledQty null, fillStatus unknown (la orden sí existe)',
    concSinFills && concSinFills.filledQty === null && concSinFills.fillStatus === 'unknown');
  const gano = resultadoP2({ filledQty: 1, avgFillPriceDollars: 0.20, feePerContractDollars: 0.0112, direccion: 'no', resultadoOficial: 'no' });
  check('resultado realizado ganó: 1 contrato a $0.20 + fee $0.0112 → pnl +$0.7888',
    gano.resultado === 'ganó' && gano.gano === true && Math.abs(gano.pnlUsd - 0.7888) < 0.0001);
  const perdio = resultadoP2({ filledQty: 1, avgFillPriceDollars: 0.20, feePerContractDollars: 0.0112, direccion: 'no', resultadoOficial: 'yes' });
  check('resultado realizado perdió: 1 contrato a $0.20 + fee $0.0112 → pnl -$0.2112',
    perdio.resultado === 'perdió' && perdio.gano === false && Math.abs(perdio.pnlUsd - (-0.2112)) < 0.0001);
  check('resultado realizado no_llenó: 0 contratos → pnl $0',
    (() => { const r = resultadoP2({ filledQty: 0, avgFillPriceDollars: null, feePerContractDollars: 0.0112, direccion: 'no', resultadoOficial: 'no' }); return r.resultado === 'no_llenó' && r.pnlUsd === 0; })());
  check('resultado realizado pendiente: sin resultado oficial aún → pendiente, pnl null',
    (() => { const r = resultadoP2({ filledQty: 1, avgFillPriceDollars: 0.20, feePerContractDollars: 0.0112, direccion: 'no', resultadoOficial: 'pendiente' }); return r.resultado === 'pendiente' && r.pnlUsd === null; })());
  check('resultado realizado sin_dato: llenado desconocido (null) → sin_dato, pnl null',
    (() => { const r = resultadoP2({ filledQty: null, avgFillPriceDollars: null, feePerContractDollars: 0.0112, direccion: 'no', resultadoOficial: 'no' }); return r.resultado === 'sin_dato' && r.pnlUsd === null; })());
}
{
  const envAntes = process.env.LIVE_TRADING_ENABLED;
  process.env.LIVE_TRADING_ENABLED = 'true';
  try {
    await armP2(994011);
    const entry = await handleP2(994011, senalExp('KXBTC15M-26NOV181430-11'), {
      sendFn: async () => ({ sent: true, order: { order_id: 'ord-9', client_order_id: 'c-exp-9' } }),
      credsProvider: async () => ({ keyId: 'k', privateKeyPem: 'p' }),
      consultarOrdenFn: async () => ({ orderId: 'ord-9', clientOrderId: 'c-exp-9', status: 'executed' }),
      fillsFn: async () => fillsDe1('KXBTC15M-26NOV181430-11'),
    });
    const est = trader._traders.get(994011);
    check('envío OK + conciliación: entry sent con filledQty 1, precio medio $0.20, reconciliation ok, 1 orden hoy',
      entry.action === 'sent' && entry.orderId === 'ord-9' && entry.fillStatus === 'filled'
      && entry.filledQty === 1 && entry.avgFillPriceDollars === 0.20 && entry.reconciliation === 'ok'
      && est.ordersToday === 1);
    await armP2(994012);
    const entrySinConc = await handleP2(994012, senalExp('KXBTC15M-26NOV181430-12'), {
      sendFn: async () => ({ sent: true, order: { order_id: 'ord-10', client_order_id: 'c-exp-10' } }),
      credsProvider: async () => ({ keyId: 'k', privateKeyPem: 'p' }),
      consultarOrdenFn: async () => { throw new Error('Kalshi HTTP 500'); },
      fillsFn: async () => ({ fills: [] }),
    });
    check('conciliación que falla NO quita el sent: la orden cuenta como enviada, reconciliation unknown',
      entrySinConc.action === 'sent' && entrySinConc.reconciliation === 'unknown' && entrySinConc.filledQty === null);
    const liq = await liquidarP2(994011, { ticker: 'KXBTC15M-26NOV181430-11', resultadoOficial: 'no' });
    check('liquidación ganó: resultadoRealizado ganó, pnl +$0.7888 en la entrada',
      liq.ok === true && liq.entry?.resultadoRealizado === 'ganó' && Math.abs(liq.entry?.pnlRealizadoUsd - 0.7888) < 0.0001);
    check('snapshot today.realizedPnlUsd suma el pnl liquidado (+$0.7888)',
      Math.abs(snapshotP2(994011).today.realizedPnlUsd - 0.7888) < 0.0001);
    const liqNada = await liquidarP2(994099, { ticker: 'KXBTC15M-26NOV181430-99', resultadoOficial: 'no' });
    check('liquidación sin entrada sent para ese ticker → no_sent_entry',
      liqNada.ok === false && liqNada.reason === 'no_sent_entry');
    await armP2(994013);
    await handleP2(994013, senalExp('KXBTC15M-26NOV181430-13'), {
      sendFn: async () => ({ sent: true, order: { order_id: 'ord-11', client_order_id: 'c-exp-11' } }),
      credsProvider: async () => ({ keyId: 'k', privateKeyPem: 'p' }),
      consultarOrdenFn: async () => ({ orderId: 'ord-11', clientOrderId: 'c-exp-11', status: 'resting' }),
      fillsFn: async () => ({ fills: [] }),
    });
    const liqVacia = await liquidarP2(994013, { ticker: 'KXBTC15M-26NOV181430-13', resultadoOficial: 'yes' });
    check('liquidación sin llenado: resultadoRealizado no_llenó, pnl $0',
      liqVacia.ok === true && liqVacia.entry?.resultadoRealizado === 'no_llenó' && liqVacia.entry?.pnlRealizadoUsd === 0);
  } finally {
    if (envAntes === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = envAntes;
  }
}

console.log('v16.4 — 12. Parte 2: ambigüedad por timeout (aceptada → enviada; no aceptada → error)');
{
  const envAntes = process.env.LIVE_TRADING_ENABLED;
  process.env.LIVE_TRADING_ENABLED = 'true';
  try {
    const { privateKey: pkTimeout } = generateKeyPairSync('ed25519');
    const pemTimeout = pkTimeout.export({ type: 'pkcs8', format: 'pem' });
    const fetchAborta = async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; };
    let errTimeout = null;
    try {
      await trader.enviarOrdenReal({ keyId: 'test-key-timeout', privateKeyPem: pemTimeout, payload: { ticker: 'KXBTC15M-26NOV181430-00' }, fetchFn: fetchAborta });
    } catch (e) { errTimeout = e; }
    check('enviarOrdenReal con fetch que aborta lanza error marcado timeout=true',
      errTimeout && errTimeout.timeout === true && trader.esErrorTimeout(errTimeout) === true);
    const sendAborta = async () => { const e = new Error('AbortError'); e.name = 'AbortError'; throw e; };
    await armP2(994021);
    const entryHallada = await handleP2(994021, senalExp('KXBTC15M-26NOV181430-21'), {
      sendFn: sendAborta,
      credsProvider: async () => ({ keyId: 'k', privateKeyPem: 'p' }),
      consultarOrdenFn: async () => ({ orderId: 'ord-t1', clientOrderId: 'c-exp-1', status: 'executed' }),
      fillsFn: async () => fillsDe1('KXBTC15M-26NOV181430-21'),
    });
    const estHallada = trader._traders.get(994021);
    check('timeout + orden encontrada por client_order_id → sent (sent_after_timeout), 1 orden hoy, 0 errores, llenado 1',
      entryHallada.action === 'sent' && entryHallada.reason === 'sent_after_timeout' && entryHallada.orderId === 'ord-t1'
      && estHallada.ordersToday === 1 && estHallada.consecutiveErrors === 0 && entryHallada.filledQty === 1);
    await armP2(994022);
    const entryPerdida = await handleP2(994022, senalExp('KXBTC15M-26NOV181430-22'), {
      sendFn: sendAborta,
      credsProvider: async () => ({ keyId: 'k', privateKeyPem: 'p' }),
      consultarOrdenFn: async () => null,
      fillsFn: async () => ({ fills: [] }),
    });
    const estPerdida = trader._traders.get(994022);
    check('timeout + orden NO encontrada en Kalshi → blocked send_error, 0 órdenes hoy, 1 error consecutivo',
      entryPerdida.action === 'blocked' && entryPerdida.reason === 'send_error'
      && estPerdida.ordersToday === 0 && estPerdida.consecutiveErrors === 1);
  } finally {
    if (envAntes === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = envAntes;
  }
}

console.log('v16.4 — 13. Parte 2: rutas, cableado, versión, live sigue apagado');
check('routes.js tiene POST /kalshi/live/experiment (JWT) y el proveedor de saldo (balance en centavos → dólares)',
  routesSrc.includes("router.post('/kalshi/live/experiment'") && routesSrc.includes('setBalanceProvider')
  && routesSrc.includes("kalshiGet('/trade-api/v2/portfolio/balance'"));
check('liveTrader.js exporta setExperiment, conciliarOrdenEnviada, calcularResultadoRealizado, registrarLiquidacion y setBalanceProvider',
  typeof trader.setExperiment === 'function' && typeof trader.conciliarOrdenEnviada === 'function'
  && typeof trader.calcularResultadoRealizado === 'function' && typeof trader.registrarLiquidacion === 'function'
  && typeof trader.setBalanceProvider === 'function');
check('routes.js no mete la ruta de órdenes fuera de comentarios (el GET de órdenes vive solo en liveTrader.js)',
  (() => { const sinComentarios = routesSrc.replace(/\/\/.*$/gm, ''); return !sinComentarios.includes('portfolio/orders') && !sinComentarios.includes('portfolio/events/orders') && !sinComentarios.includes('fetch('); })());
check('VERSION.txt documenta la Parte 2 con los parámetros (1 contrato, $5, $40, marco de Luis)',
  versionTxt.includes('PARTE 2') && versionTxt.includes('1 contrato por orden') && versionTxt.includes('$5 USD de notional')
  && versionTxt.includes('saldo $40 USD') && versionTxt.includes('la web es el producto que le dará dinero')
  && versionTxt.includes('experimento acotado'));
check('live sigue APAGADO al final (env restaurada, isLiveEnabled false)',
  trader.isLiveEnabled() === false && process.env.LIVE_TRADING_ENABLED !== 'true');
check('kalshiServer.js sigue solo lectura (READ_ONLY_PATHS intacto, sin POST ni ruta de órdenes)',
  src('server/kalshiServer.js').includes("'/trade-api/v2/portfolio/fills'") && !src('server/kalshiServer.js').includes('portfolio/orders'));

console.log(`\ntests-v16.4.mjs: ${pass} pasaron, ${fail} fallaron.`);
process.exit(fail ? 1 : 0);
