// Auth v12 — registro/login con JWT (bcrypt, nunca en claro).
// JWT_SECRET debe ponerse en Render (variable de entorno). Sin él, en
// local se usa un secreto de desarrollo con aviso; en producción con
// NODE_ENV=production el servidor NO arranca las rutas de auth sin
// JWT_SECRET (falla cerrado: mejor no arrancar que firmar tokens con
// un secreto conocido).
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// v15.2: algoritmo fijado en firma y verificación (evita aceptar tokens
// firmados con otro algoritmo).
const JWT_ALG = 'HS256';
// Hash de relleno: se compara contra él cuando el email no existe, para
// que login tarde lo mismo exista o no la cuenta (evita enumerar usuarios
// midiendo el tiempo de respuesta).
const DUMMY_HASH = bcrypt.hashSync('cev-relleno-no-es-una-contrasena', 10);

function jwtSecret() {
  const s = (process.env.JWT_SECRET || '').trim();
  if (s) return s;
  if (process.env.NODE_ENV === 'production') throw new Error('Falta JWT_SECRET (variable de entorno en Render).');
  console.log('[auth] ⚠️ Sin JWT_SECRET: secreto de desarrollo (solo local). Pon JWT_SECRET en Render.');
  return 'cev-dev-secret-change-me';
}

function hashPassword(pw) { return bcrypt.hash(String(pw), 10); }
function verifyPassword(pw, hash) { return bcrypt.compare(String(pw), String(hash || '')); }
function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name || '', role: user.role }, jwtSecret(), { algorithm: JWT_ALG, expiresIn: '7d' });
}

function authMiddleware(db) {
  return async (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Falta el token de sesión. Entra con tu cuenta.' });
    let payload;
    try { payload = jwt.verify(token, jwtSecret(), { algorithms: [JWT_ALG] }); } catch { return res.status(401).json({ error: 'Sesión caducada o no válida. Vuelve a entrar.' }); }
    const user = await db.getUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado.' });
    if (user.active === false) return res.status(403).json({ error: 'Tu cuenta está desactivada. Habla con el administrador.' });
    // v15.2: un cambio de contraseña o de rol invalida las sesiones
    // anteriores (token_valid_after). Compara en segundos porque iat va en segundos.
    if (user.token_valid_after) {
      const since = Math.floor(new Date(user.token_valid_after).getTime() / 1000);
      if (Number.isFinite(since) && (payload.iat || 0) < since) return res.status(401).json({ error: 'Sesión caducada o no válida. Vuelve a entrar.' });
    }
    req.user = { id: user.id, email: user.email, name: user.name || '', role: user.role };
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'No tienes permiso de administrador.' });
  next();
}

// Límites de intentos (v15.2). Ventana deslizante en memoria, con barrido
// periódico (antes el Map de login crecía sin límite) y tope de claves.
// En Render hay que tener app.set('trust proxy', 1) (ver app.js) para que
// req.ip sea la del cliente y no la del proxy.
const MAX_RATE_KEYS = 10000;
function makeRateLimiter({ max, windowMs, keyFn, message }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, list] of hits) {
      const fresh = list.filter((t) => now - t < windowMs);
      if (fresh.length) hits.set(k, fresh); else hits.delete(k);
    }
  }, Math.min(windowMs, 5 * 60 * 1000));
  if (sweep.unref) sweep.unref();
  const mw = (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: message });
    if (!hits.has(key) && hits.size >= MAX_RATE_KEYS) hits.delete(hits.keys().next().value);
    list.push(now);
    hits.set(key, list);
    next();
  };
  mw._hits = hits; // solo para tests
  return mw;
}
const ipOf = (req) => req.ip || '?';
const emailOf = (req) => String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 100);

// Login: 10 intentos por IP+email y 50 por IP cada 15 min.
const loginRateLimit = [
  makeRateLimiter({ max: 10, windowMs: 15 * 60 * 1000, keyFn: (req) => `${ipOf(req)}|${emailOf(req)}`, message: 'Demasiados intentos. Espera 15 minutos.' }),
  makeRateLimiter({ max: 50, windowMs: 15 * 60 * 1000, keyFn: ipOf, message: 'Demasiados intentos desde esta red. Espera 15 minutos.' }),
];
// Registro: 10 cuentas nuevas por IP cada hora.
const registerRateLimit = makeRateLimiter({ max: 10, windowMs: 60 * 60 * 1000, keyFn: ipOf, message: 'Demasiados registros desde esta red. Inténtalo más tarde.' });

module.exports = { hashPassword, verifyPassword, signToken, authMiddleware, requireAdmin, loginRateLimit, registerRateLimit, makeRateLimiter, jwtSecret, DUMMY_HASH };
