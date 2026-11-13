// Auth v12 — registro/login con JWT (bcrypt, nunca en claro).
// JWT_SECRET debe ponerse en Render (variable de entorno). Sin él, en
// local se usa un secreto de desarrollo con aviso; en producción con
// NODE_ENV=production el servidor NO arranca las rutas de auth sin
// JWT_SECRET (falla cerrado: mejor no arrancar que firmar tokens con
// un secreto conocido).
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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
  return jwt.sign({ sub: user.id, email: user.email, name: user.name || '', role: user.role }, jwtSecret(), { expiresIn: '7d' });
}

function authMiddleware(db) {
  return async (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Falta el token de sesión. Entra con tu cuenta.' });
    let payload;
    try { payload = jwt.verify(token, jwtSecret()); } catch { return res.status(401).json({ error: 'Sesión caducada o no válida. Vuelve a entrar.' }); }
    const user = await db.getUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado.' });
    if (user.active === false) return res.status(403).json({ error: 'Tu cuenta está desactivada. Habla con el administrador.' });
    req.user = { id: user.id, email: user.email, name: user.name || '', role: user.role };
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'No tienes permiso de administrador.' });
  next();
}

// Límite de intentos de login: 10 por IP+email cada 15 min.
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const key = `${req.ip || '?'}|${String((req.body && req.body.email) || '').toLowerCase()}`;
  const now = Date.now();
  const list = (loginAttempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (list.length >= 10) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
  list.push(now);
  loginAttempts.set(key, list);
  next();
}

module.exports = { hashPassword, verifyPassword, signToken, authMiddleware, requireAdmin, loginRateLimit, jwtSecret };
