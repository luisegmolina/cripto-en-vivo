// webauthn.js — v16.4 (Parte 1): entrada con huella o rostro
// (WebAuthn / passkeys, autenticador de plataforma) desde el navegador.
// Usa navigator.credentials directamente, sin librería extra: las
// opciones JSON del servidor se convierten a ArrayBuffer y la respuesta
// del autenticador se vuelve a convertir a base64url para el servidor.
// Si el navegador no tiene PublicKeyCredential o el dispositivo no
// tiene autenticador de plataforma con verificación de usuario, las
// funciones lanzan un error corto y la UI esconde el botón (ver
// AuthModal.jsx y WebauthnRegister.jsx).
import { apiAuth, saveToken } from './auth.js';

// base64url <-> Uint8Array (sin dependencias).
export function b64urlToBuf(s) {
  const b64 = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
export function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ¿Este navegador sabe de WebAuthn? (sin esto, ni se muestran los botones).
export function isWebauthnSupported() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential;
}

// ¿Este dispositivo tiene autenticador de plataforma con verificación
// de usuario (huella/rostro/PIN)? null = no se pudo saber.
export async function isPlatformAuthenticatorAvailable() {
  if (!isWebauthnSupported()) return false;
  try {
    if (typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return null;
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return null; }
}

function opcionesRegistroABuffer(options) {
  return {
    ...options,
    challenge: b64urlToBuf(options.challenge),
    user: { ...options.user, id: b64urlToBuf(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })),
  };
}
function opcionesLoginABuffer(options) {
  return {
    ...options,
    challenge: b64urlToBuf(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })),
  };
}
function respuestaAJson(cred) {
  const r = cred.response;
  const out = {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufToB64url(r.clientDataJSON),
    },
    clientExtensionResults: typeof cred.getClientExtensionResults === 'function' ? cred.getClientExtensionResults() : {},
  };
  // Registro: attestationObject. Login: authenticatorData + signature.
  if (r.attestationObject) out.response.attestationObject = bufToB64url(r.attestationObject);
  if (r.authenticatorData) out.response.authenticatorData = bufToB64url(r.authenticatorData);
  if (r.signature) out.response.signature = bufToB64url(r.signature);
  if (r.userHandle) out.response.userHandle = bufToB64url(r.userHandle);
  if (Array.isArray(cred.response.transports)) out.response.transports = cred.response.transports;
  else if (typeof r.getTransports === 'function') {
    try { out.response.transports = r.getTransports(); } catch { /* sin transports */ }
  }
  return out;
}

function errorHuella(e) {
  if (e && e.name === 'NotAllowedError') return new Error('No se completó la huella: se canceló o tardó demasiado. Inténtalo de nuevo.');
  if (e && e.name === 'NotSupportedError') return new Error('Este dispositivo no admite huella o rostro para entrar.');
  if (e && e.name === 'SecurityError') return new Error('La huella solo funciona en el dominio de la app (https) y con el rpID de producción.');
  if (e && e.name === 'InvalidStateError') return new Error('Esa huella ya está registrada en este dispositivo.');
  return e instanceof Error ? e : new Error('No se pudo usar la huella.');
}

// Registrar la huella / rostro de ESTE dispositivo (con sesión).
// POST /api/auth/webauthn/register/options -> navigator.credentials.create
// -> POST /api/auth/webauthn/register/verify.
export async function webauthnRegister() {
  if (!isWebauthnSupported()) throw new Error('Tu navegador no admite huella ni rostro (WebAuthn).');
  let cred;
  try {
    const { options } = await apiAuth('/api/auth/webauthn/register/options', { method: 'POST', body: {} });
    cred = await navigator.credentials.create({
      publicKey: opcionesRegistroABuffer(options),
    });
    if (!cred) throw new Error('El autenticador no devolvió ninguna credencial.');
  } catch (e) {
    if (e && e.status) throw e; // error del servidor (apiAuth), tal cual
    throw errorHuella(e);
  }
  const data = await apiAuth('/api/auth/webauthn/register/verify', {
    method: 'POST',
    body: respuestaAJson(cred),
  });
  return data;
}

// Entrar con huella / rostro (sin sesión: hace falta el email).
// POST /api/auth/webauthn/login/options -> navigator.credentials.get
// -> POST /api/auth/webauthn/login/verify -> {token, user} (igual que
// el login con password). Guarda el token y devuelve los datos.
export async function webauthnLogin(email) {
  if (!isWebauthnSupported()) throw new Error('Tu navegador no admite huella ni rostro (WebAuthn).');
  if (!String(email || '').trim()) throw new Error('Pon tu email primero para entrar con huella.');
  let cred;
  try {
    const { options } = await apiAuth('/api/auth/webauthn/login/options', {
      method: 'POST',
      body: { email: String(email).trim() },
    });
    cred = await navigator.credentials.get({
      publicKey: opcionesLoginABuffer(options),
    });
    if (!cred) throw new Error('El autenticador no devolvió ninguna respuesta.');
  } catch (e) {
    if (e && e.status) throw e; // error del servidor (apiAuth), tal cual
    throw errorHuella(e);
  }
  const data = await apiAuth('/api/auth/webauthn/login/verify', {
    method: 'POST',
    body: { ...respuestaAJson(cred), email: String(email).trim() },
  });
  if (data.token) saveToken(data.token);
  return data;
}

// Huellas registradas del usuario (sin claves públicas).
export async function listWebauthnCredentials() {
  const data = await apiAuth('/api/auth/webauthn/credentials');
  return Array.isArray(data.credentials) ? data.credentials : [];
}
