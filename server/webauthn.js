// WebAuthn / passkeys v16.4 (Parte 1) — entrada con huella o rostro
// (autenticador de plataforma) ADEMÁS del password, que sigue igual.
// El login con WebAuthn devuelve la misma sesión JWT que el login con
// password (signToken de auth.js). Nada del motor ni de live cambia:
// live sigue APAGADO y este módulo no toca Kalshi.
//
// rpID fijo: cripto-en-vivo.onrender.com (el dominio de producción).
// En local (localhost) el navegador NO dejará crear una credencial con
// ese rpID — es una regla del navegador, no del servidor — así que la
// prueba real de huella/rostro solo es posible contra el dominio de
// producción; en local los tests usan un autenticador simulado con
// criptografía ES256 real (ver tests-v16.4.mjs).
//
// Seguridad:
//  - Challenges de un solo uso y con expiración (5 min): se guardan en
//    memoria (Map con barrido) y se BORRAN al consumirlos, acierten o
//    no, así que un reto reutilizado o caducado siempre se rechaza.
//  - La verificación criptográfica la hace @simplewebauthn/server
//    (v14): firma, origen, rpID, reto y contador. Aquí no se inventa
//    ninguna verificación a mano.
//  - El contador del autenticador se guarda y se exige que CREZCA en
//    cada login: si llega un contador igual o menor, es replay o
//    credencial clonada y se rechaza.
//  - La clave pública se guarda en base64url; la clave privada NUNCA
//    sale del dispositivo del usuario (el servidor jamás la ve).
//  - Se exige verificación de usuario (huella, rostro o PIN) tanto al
//    registrar como al entrar: requireUserVerification: true.
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

// Dominio de producción (fijo por diseño de v16.4, Parte 1).
const RP_ID = 'cripto-en-vivo.onrender.com';
const RP_NAME = 'Cripto en Vivo';
const PROD_ORIGIN = 'https://cripto-en-vivo.onrender.com';
// Orígenes de desarrollo local (solo fuera de producción): permiten
// probar el flujo de opciones contra localhost, aunque el navegador
// no creará credenciales reales con el rpID de producción desde ahí.
const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3001',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3001',
];
// Un reto vive 5 minutos: tiempo de sobra para poner la huella y
// corto para que un reto robado no sirva después.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function expectedOrigins() {
  return process.env.NODE_ENV === 'production' ? [PROD_ORIGIN] : [PROD_ORIGIN, ...DEV_ORIGINS];
}

// --- Challenges de un solo uso (en memoria, con barrido) ---
// key -> { challenge, expiresAt }. La clave es `reg:<userId>` para el
// registro (con sesión JWT) y `login:<email>` para el login (sin sesión).
const _challenges = new Map();

function _barrerChallenges() {
  const ahora = Date.now();
  for (const [k, v] of _challenges) {
    if (v.expiresAt <= ahora) _challenges.delete(k);
  }
}
const _barrido = setInterval(_barrerChallenges, 60 * 1000);
if (_barrido.unref) _barrido.unref();

function guardarChallenge(key, challenge) {
  _barrerChallenges();
  _challenges.set(key, { challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return challenge;
}

// Consume el reto: lo borra SIEMPRE (acierte o no la verificación) y
// devuelve el challenge guardado, o null si no existe, caducó o no
// coincide con el esperado. Un reto reutilizado siempre da null.
function consumirChallenge(key, challengeEsperado) {
  const guardado = _challenges.get(key);
  _challenges.delete(key);
  if (!guardado) return null;
  if (guardado.expiresAt <= Date.now()) return null;
  if (challengeEsperado && guardado.challenge !== challengeEsperado) return null;
  return guardado.challenge;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(String(s || ''), 'base64url');

// --- Registro (con sesión JWT) ---
async function crearOpcionesRegistro(db, user) {
  const existentes = await db.listWebauthnCredentials(user.id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: user.email,
    userID: Buffer.from(String(user.id), 'utf8'),
    userDisplayName: user.name || user.email,
    // Solo autenticador de plataforma (huella/rostro del propio
    // dispositivo, p. ej. el Pixel 10 Pro XL de Luis): sin llaves USB.
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
      authenticatorAttachment: 'platform',
    },
    attestationType: 'none',
    excludeCredentials: existentes.map((c) => ({
      id: c.credential_id,
      transports: Array.isArray(c.transports) ? c.transports : [],
    })),
  });
  guardarChallenge(`reg:${user.id}`, options.challenge);
  return options;
}

async function verificarRegistro(db, user, body) {
  if (!body || typeof body !== 'object' || !body.id || !body.response) {
    throw new Error('Respuesta del autenticador incompleta.');
  }
  const challenge = consumirChallenge(`reg:${user.id}`);
  if (!challenge) {
    throw new Error('El reto caducó o ya se usó. Vuelve a pulsar "Registrar huella / rostro".');
  }
  let verificado;
  try {
    verificado = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: expectedOrigins(),
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });
  } catch (e) {
    throw new Error(`No se pudo verificar la huella: ${e.message || 'respuesta no válida.'}`);
  }
  if (!verificado.verified || !verificado.registrationInfo) {
    throw new Error('La huella no se pudo verificar. Inténtalo de nuevo.');
  }
  const cred = verificado.registrationInfo.credential;
  const yaExiste = await db.getWebauthnCredentialById(cred.id).catch(() => null);
  if (yaExiste) {
    throw new Error('Esa huella ya está registrada en este dispositivo.');
  }
  const registro = {
    userId: user.id,
    credentialId: cred.id,
    // La clave pública COSE tal cual la devuelve la librería.
    publicKey: b64url(cred.publicKey),
    counter: cred.counter || 0,
    transports: Array.isArray(cred.transports)
      ? cred.transports
      : (Array.isArray(body.response.transports) ? body.response.transports : []),
  };
  await db.addWebauthnCredential(registro);
  return {
    credentialId: registro.credentialId,
    transports: registro.transports,
    counter: registro.counter,
  };
}

// --- Login (sin sesión: primero el email, como el login con password) ---
async function crearOpcionesLogin(db, email) {
  const limpio = String(email || '').trim().toLowerCase();
  const user = await db.getUserByEmail(limpio);
  if (!user) return null;
  const credenciales = await db.listWebauthnCredentials(user.id);
  if (!credenciales.length) return null;
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: credenciales.map((c) => ({
      id: c.credential_id,
      transports: Array.isArray(c.transports) ? c.transports : [],
    })),
    userVerification: 'required',
  });
  guardarChallenge(`login:${limpio}`, options.challenge);
  return { options, user };
}

async function verificarLogin(db, body) {
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!email || !body.id || !body.response) {
    throw new Error('Falta el email o la respuesta del autenticador.');
  }
  const challenge = consumirChallenge(`login:${email}`);
  if (!challenge) {
    throw new Error('El reto caducó o ya se usó. Vuelve a pulsar "Entrar con huella / rostro".');
  }
  const guardada = await db.getWebauthnCredentialById(body.id);
  if (!guardada) {
    throw new Error('Esa huella no está registrada. Entra con tu contraseña.');
  }
  let verificado;
  try {
    verificado = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: expectedOrigins(),
      expectedRPID: RP_ID,
      credential: {
        id: guardada.credential_id,
        publicKey: fromB64url(guardada.public_key),
        counter: Number(guardada.counter) || 0,
        transports: Array.isArray(guardada.transports) ? guardada.transports : [],
      },
      requireUserVerification: true,
    });
  } catch (e) {
    throw new Error(`No se pudo verificar la huella: ${e.message || 'respuesta no válida.'}`);
  }
  if (!verificado.verified || !verificado.authenticationInfo) {
    throw new Error('La huella no se pudo verificar. Inténtalo de nuevo.');
  }
  const nuevoContador = verificado.authenticationInfo.newCounter;
  // El contador debe CRECER: igual o menor = replay o clon.
  if (!Number.isFinite(nuevoContador) || nuevoContador <= (Number(guardada.counter) || 0)) {
    throw new Error('Contador del autenticador sospechoso (posible replay). Entra con tu contraseña.');
  }
  await db.updateWebauthnCounter(guardada.credential_id, nuevoContador);
  const user = await db.getUserById(guardada.user_id);
  if (!user) throw new Error('Usuario no encontrado.');
  return user;
}

module.exports = {
  RP_ID,
  RP_NAME,
  PROD_ORIGIN,
  CHALLENGE_TTL_MS,
  expectedOrigins,
  guardarChallenge,
  consumirChallenge,
  crearOpcionesRegistro,
  verificarRegistro,
  crearOpcionesLogin,
  verificarLogin,
  _challenges,
};
