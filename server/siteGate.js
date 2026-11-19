// PIN de acceso al sitio (v16.5) — puerta de entrada a toda la web.
// Idea: un PIN de 4-32 caracteres que el admin pone desde su panel.
// Mientras haya PIN puesto, TODO queda bloqueado sin la cookie de
// puerta (cev_gate_v1): las rutas /api/* (incluidas las públicas como
// /api/kalshi-market), el estático de client/dist y el fallback SPA.
// Sin PIN puesto, la puerta está abierta y nada cambia.
// El PIN y el código de recuperación solo viven como HASH bcrypt en
// cev_site_settings (claves gate_pin_hash / gate_recovery_hash, ver
// server/db.js): en claro no se guardan, no se loguean y no se
// devuelven nunca, salvo el código de recuperación UNA vez al poner
// el PIN. La cookie es un JWT HS256 con {gate:true} y 30 días, firmado
// con el mismo JWT_SECRET de las sesiones (ver auth.js): fail-closed,
// firma mala o caducada = puerta cerrada.
// La puerta NO toca Kalshi, ni el auditor, ni el bot, ni la sesión
// JWT, ni el trading en vivo: solo decide si la petición pasa o no.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('./auth');

const GATE_COOKIE_NAME = 'cev_gate_v1';
const GATE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 días
const GATE_PIN_MIN = 4;
const GATE_PIN_MAX = 32;

// Alfabeto del código de recuperación: solo A-Z y 2-9, sin los
// ambiguos (0, 1, I, L, O). 12 caracteres en 3 grupos de 4.
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateRecoveryCode() {
  const bytes = crypto.randomBytes(12);
  let code = '';
  for (let i = 0; i < 12; i++) code += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function validPin(pin) {
  return typeof pin === 'string' && pin.length >= GATE_PIN_MIN && pin.length <= GATE_PIN_MAX;
}

function signGateToken() {
  return jwt.sign({ gate: true }, jwtSecret(), { algorithm: 'HS256', expiresIn: `${GATE_MAX_AGE_SECONDS}s` });
}

// Cookie de puerta: HttpOnly, SameSite=Lax, Path=/, 30 días. Secure
// solo en producción (en local el servidor va por http).
function setGateCookie(res) {
  res.cookie(GATE_COOKIE_NAME, signGateToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: GATE_MAX_AGE_SECONDS * 1000,
  });
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    try { out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim()); }
    catch { out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim(); }
  }
  return out;
}

// Fail-closed: sin cookie, con firma mala o caducada, o sin
// {gate:true} en el payload, la puerta está cerrada.
function gateCookieValid(req) {
  const token = parseCookies(req.headers && req.headers.cookie)[GATE_COOKIE_NAME];
  if (!token) return false;
  try {
    const payload = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] });
    return payload && payload.gate === true;
  } catch { return false; }
}

// Rutas que pasan siempre, haya PIN o no: salud y las tres de la
// puerta que no exigen cookie (status, verify, recover). Todo lo
// demás —incluidos /api/site-gate/pin y /api/site-gate/pin/remove,
// que además exigen JWT de admin— necesita la cookie cuando hay PIN.
const GATE_PUBLIC_PATHS = new Set(['/api/health', '/api/site-gate/status', '/api/site-gate/verify', '/api/site-gate/recover']);

function gateMiddleware(db) {
  return async (req, res, next) => {
    if (GATE_PUBLIC_PATHS.has(req.path)) return next();
    let pinHash;
    try {
      pinHash = await db.getSiteSetting('gate_pin_hash');
    } catch (e) {
      // Sin poder leer el PIN no se puede saber si hay puerta: cerrada
      // por seguridad (mejor un 403 que dejar pasar sin saber).
      console.log('[site-gate] No se pudo leer el ajuste de puerta (puerta cerrada por seguridad):', e.message);
      return res.status(403).json({ error: 'site_gate' });
    }
    if (!pinHash) return next(); // sin PIN puesto, la puerta está abierta
    if (gateCookieValid(req)) return next();
    return res.status(403).json({ error: 'site_gate' });
  };
}

module.exports = {
  GATE_COOKIE_NAME, GATE_MAX_AGE_SECONDS, GATE_PIN_MIN, GATE_PIN_MAX,
  generateRecoveryCode, validPin, signGateToken, setGateCookie,
  parseCookies, gateCookieValid, gateMiddleware, GATE_PUBLIC_PATHS,
};
