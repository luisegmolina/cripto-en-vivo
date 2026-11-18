// Rutas v12 — usuarios, admin y Kalshi SOLO LECTURA.
// Montadas en /api desde server/app.js. Nada de esto mueve dinero
// real ni opera en Kalshi: la única llamada a Kalshi es GET a
// /portfolio/positions, /portfolio/balance y /portfolio/fills
// (ver kalshiServer.js, allowlist). La clave privada de Kalshi se
// guarda CIFRADA (crypto.js) y NUNCA se devuelve por ninguna API:
// las respuestas solo traen keyIdPreview (4 primeros + 4 últimos).
const express = require('express');
const db = require('./db');
const { hashPassword, verifyPassword, signToken, authMiddleware, requireAdmin, loginRateLimit, registerRateLimit, DUMMY_HASH } = require('./auth');
const { encrypt, decrypt, masterKey } = require('./crypto');
const kalshi = require('./kalshiServer');
const brti = require('./brti');
const paperAuditor = require('./paperAuditor');

// v16.1 — El auditor en papel persiste sus resultados (últimas 20
// ventanas) en cev_user_data kind 'paper_audit', solo al cerrar
// ventana y al parar/arrancar, nunca cada segundo.
paperAuditor.setPersistencia(async (userId, resultados) => {
  await db.setUserData(userId, 'paper_audit', { resultados, updatedAt: new Date().toISOString() });
});

const router = express.Router();

// v15.2: Express 4 no captura los rechazos de los handlers async: si la BD
// fallaba, la petición se quedaba colgada y Node podía caerse por un
// unhandledRejection. Aquí se envuelve cada handler async de este router
// para que el error vaya al manejador final de app.js (500 JSON).
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
for (const verb of ['get', 'post', 'put', 'patch', 'delete']) {
  const orig = router[verb].bind(router);
  router[verb] = (p, ...handlers) => orig(p, ...handlers.flat().map((h) => (
    typeof h === 'function' && h.constructor.name === 'AsyncFunction' ? asyncHandler(h) : h
  )));
}
const auth = authMiddleware(db);
const keyIdPreview = (k) => (k && k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '••••');

function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim()); }

// --- Arranque: tablas + primer admin por variables de entorno ---
// ADMIN_EMAIL + ADMIN_PASSWORD (en Render, solo para crear el primer
// admin). Si ya hay un admin, no hace nada. La contraseña NUNCA se
// escribe en logs ni en GitHub. Tras crear el admin, quita
// ADMIN_PASSWORD de las variables de entorno de Render.
async function init() {
  await db.init();
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPass = process.env.ADMIN_PASSWORD || '';
  if (adminEmail && adminPass) {
    const n = await db.countAdmins();
    if (n === 0) {
      const existing = await db.getUserByEmail(adminEmail);
      if (existing) {
        // v15.2: antes solo se cambiaba la contraseña y la cuenta seguía
        // siendo 'user' (el admin nunca se creaba). Ahora se promueve y se
        // reactiva; setUserPassword/setUserRole invalidan sesiones previas.
        await db.setUserPassword(existing.id, await hashPassword(adminPass));
        await db.setUserRole(existing.id, 'admin');
        await db.setUserActive(existing.id, true);
        console.log(`[auth] Cuenta ${adminEmail} promovida a admin y contraseña actualizada desde ADMIN_PASSWORD.`);
      } else {
        await db.createUser({ email: adminEmail, passwordHash: await hashPassword(adminPass), name: 'Luis', role: 'admin' });
        console.log(`[auth] Admin creado: ${adminEmail}. Quita ADMIN_PASSWORD de Render tras entrar.`);
      }
    }
  }
}

// --- Auth ---
router.post('/auth/register', registerRateLimit, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!validEmail(email)) return res.status(400).json({ error: 'Pon un email válido.' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'La contraseña necesita al menos 8 caracteres.' });
  try {
    const user = await db.createUser({ email, passwordHash: await hashPassword(password), name: String(name || '').slice(0, 50), role: 'user' });
    return res.status(201).json({ token: signToken(user), user });
  } catch (e) {
    if (e.code === 'EMAIL_TAKEN' || /duplicate key|UNIQUE/i.test(String(e.message || ''))) return res.status(400).json({ error: 'Ese email ya está registrado. Entra con tu contraseña.' });
    console.log('[auth] error en register:', e.message);
    return res.status(500).json({ error: 'No se pudo crear la cuenta. Inténtalo de nuevo.' });
  }
});

router.post('/auth/login', loginRateLimit, async (req, res) => {
  const { email, password } = req.body || {};
  if (!validEmail(email) || !password) return res.status(400).json({ error: 'Pon tu email y tu contraseña.' });
  const user = await db.getUserByEmail(email);
  // v15.2: siempre se ejecuta bcrypt (contra DUMMY_HASH si no hay cuenta) para
  // que el tiempo de respuesta no delate si el email existe.
  const passwordOk = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
  if (user.active === false) return res.status(403).json({ error: 'Tu cuenta está desactivada. Habla con el administrador.' });
  const pub = db.publicUser(user);
  return res.json({ token: signToken(pub), user: pub });
});

router.get('/auth/me', auth, async (req, res) => {
  const conn = await db.getKalshiConnection(req.user.id);
  res.json({ user: { ...req.user, kalshiConnected: !!conn } });
});

router.post('/auth/logout', auth, (req, res) => res.json({ ok: true }));

// --- Datos del usuario (cartera virtual / alertas en la cuenta) ---
router.get('/me/portfolio', auth, async (req, res) => res.json({ portfolio: (await db.getUserData(req.user.id, 'portfolio')) || null }));
router.put('/me/portfolio', auth, async (req, res) => {
  const p = req.body && req.body.portfolio;
  if (!p || typeof p !== 'object') return res.status(400).json({ error: 'portfolio no válido.' });
  await db.setUserData(req.user.id, 'portfolio', p);
  res.json({ ok: true });
});
router.get('/me/alerts', auth, async (req, res) => res.json({ alerts: (await db.getUserData(req.user.id, 'alerts')) || null }));
router.put('/me/alerts', auth, async (req, res) => {
  const a = req.body && req.body.alerts;
  if (!Array.isArray(a)) return res.status(400).json({ error: 'alerts no válido.' });
  await db.setUserData(req.user.id, 'alerts', a.slice(0, 100));
  res.json({ ok: true });
});

// --- Kalshi SOLO LECTURA (por usuario) ---
router.get('/kalshi/status', auth, async (req, res) => {
  const c = await db.getKalshiConnection(req.user.id);
  if (!c) return res.json({ connected: false, keyIdPreview: null, lastSyncAt: null, status: 'not_connected' });
  res.json({ connected: true, keyIdPreview: keyIdPreview(c.keyId), lastSyncAt: c.lastSyncAt || null, status: c.status || 'connected' });
});

router.post('/kalshi/connect', auth, async (req, res) => {
  const { keyId, privateKey } = req.body || {};
  if (!keyId || String(keyId).trim().length < 5) return res.status(400).json({ error: 'Pon tu Kalshi API Key ID.' });
  if (!privateKey || !String(privateKey).includes('PRIVATE KEY')) return res.status(400).json({ error: 'Pega tu clave privada .pem completa (empieza por -----BEGIN ... PRIVATE KEY-----).' });
  const mk = masterKey();
  if (mk.ephemeral && process.env.NODE_ENV === 'production') {
    return res.status(503).json({ error: 'Falta KALSHI_ENCRYPTION_KEY en el servidor (Render). Sin ella no se puede guardar tu clave cifrada.' });
  }
  let parsed;
  try { parsed = kalshi.parsePrivateKey(privateKey); } catch (e) { return res.status(400).json({ error: e.message }); }
  const creds = { keyId: String(keyId).trim(), privateKeyPem: String(privateKey).trim() };
  try {
    await kalshi.testCredentials(creds);
  } catch (e) {
    console.log('[kalshi] credenciales rechazadas:', e.status || '', e.message);
    return res.status(400).json({ error: `Kalshi no aceptó estas credenciales (${e.message}). Revisa el Key ID y la clave privada.` });
  }
  await db.setKalshiConnection(req.user.id, { keyId: creds.keyId, privateKeyEncrypted: encrypt(creds.privateKeyPem) });
  console.log(`[kalshi] Usuario ${req.user.id} conectó Kalshi (solo lectura, clave ${parsed.type}, ${keyIdPreview(creds.keyId)}).`);
  res.json({ connected: true, keyIdPreview: keyIdPreview(creds.keyId), lastSyncAt: new Date().toISOString(), status: 'connected' });
});

router.delete('/kalshi/connect', auth, async (req, res) => {
  await db.deleteKalshiConnection(req.user.id);
  brti.stopBrti(req.user.id); // cierra el WebSocket BRTI de este usuario
  await paperAuditor.stopAuditor(req.user.id).catch(() => {}); // sin Kalshi no hay auditor
  res.json({ ok: true });
});

// v13.5 — VALOR EN VIVO DE KALSHI (BRTI) por WebSocket.
// El servidor mantiene UNA conexión WS por usuario conectado y
// guarda el último tick en memoria; este endpoint solo LEE ese
// último valor (no abre conexiones nuevas por cada sondeo). Sin
// Kalshi conectado NO se abre ninguna conexión a Kalshi y responde
// connected:false: el cliente cae a Coinbase con aviso, nunca en
// blanco. Si el WS falla o aún no hay tick, source es
// 'kalshi-unavailable' y el cliente también cae a Coinbase.
// La clave privada se descifra solo aquí, en el servidor, y nunca
// sale en ninguna respuesta.
router.get('/kalshi/brti', auth, async (req, res) => {
  const conn = await db.getKalshiConnection(req.user.id);
  if (!conn) return res.json({ connected: false, source: 'coinbase', value: null, avg60s: null, avg15mFinal: null, updatedAt: null, status: 'not_connected', error: null });
  let privateKeyPem;
  try { privateKeyPem = decrypt(conn.privateKeyEncrypted); } catch (e) {
    return res.json({ connected: true, source: 'kalshi-unavailable', value: null, avg60s: null, avg15mFinal: null, updatedAt: null, status: 'error', error: 'No se pudo descifrar tu clave de Kalshi en el servidor. Desconéctala y vuelve a conectarla.' });
  }
  const state = brti.ensureBrti(req.user.id, { keyId: conn.keyId, privateKeyPem });
  const ageMs = state.updatedAt ? Date.now() - new Date(state.updatedAt).getTime() : null;
  const stale = state.value == null || ageMs == null || ageMs > 15000;
  res.json({
    connected: true,
    source: state.value != null ? 'kalshi' : 'kalshi-unavailable',
    value: state.value,
    avg60s: state.avg60s,
    avg15mFinal: state.avg15mFinal,
    updatedAt: state.updatedAt,
    status: state.status,
    stale,
    error: state.error,
  });
});

// v16.1 — AUDITOR EN PAPEL del sniper BRTI (sin dinero real).
// Solo LEE: el estado BRTI en memoria + mercados públicos de Kalshi.
// NUNCA envía órdenes a Kalshi: no hay ningún POST a Kalshi en este
// archivo ni en server/paperAuditor.js (el payload V2 solo existe
// como vista previa en papel). Sin Kalshi conectado no se puede
// auditar: start devuelve 400 y GET devuelve enabled:false.
router.get('/kalshi/paper-audit', auth, async (req, res) => {
  const conn = await db.getKalshiConnection(req.user.id);
  const snap = paperAuditor.getSnapshot(req.user.id);
  if (!conn) return res.json({ ...snap, enabled: false, kalshiConnected: false, ultimoError: 'Kalshi no conectado: conecta tu cuenta Kalshi abajo para auditar en papel.' });
  res.json({ ...snap, kalshiConnected: true });
});

router.post('/kalshi/paper-audit/start', auth, async (req, res) => {
  const conn = await db.getKalshiConnection(req.user.id);
  if (!conn) return res.status(400).json({ error: 'Conecta primero tu cuenta Kalshi (panel inferior): el auditor necesita el BRTI en vivo y sin conexión no hay nada que auditar.' });
  let privateKeyPem;
  try { privateKeyPem = decrypt(conn.privateKeyEncrypted); } catch (e) {
    return res.status(500).json({ error: 'No se pudo descifrar tu clave de Kalshi en el servidor. Desconéctala y vuelve a conectarla.' });
  }
  // Arranca (o reutiliza) el WS BRTI de este usuario: el auditor lee
  // de ahí cada segundo y así mantiene vivo el WS.
  brti.ensureBrti(req.user.id, { keyId: conn.keyId, privateKeyPem });
  const prev = await db.getUserData(req.user.id, 'paper_audit').catch(() => null);
  const snap = paperAuditor.startAuditor(req.user.id, prev && Array.isArray(prev.resultados) ? prev.resultados : []);
  res.json({ ok: true, ...snap, kalshiConnected: true });
});

router.post('/kalshi/paper-audit/stop', auth, async (req, res) => {
  const snap = await paperAuditor.stopAuditor(req.user.id);
  const conn = await db.getKalshiConnection(req.user.id);
  res.json({ ok: true, ...snap, kalshiConnected: !!conn });
});

const posCache = new Map(); // userId -> {at, data}
router.get('/kalshi/positions', auth, async (req, res) => {
  const conn = await db.getKalshiConnection(req.user.id);
  if (!conn) return res.json({ connected: false, positions: [], balance: null, fetchedAt: null, source: 'kalshi' });
  const hit = posCache.get(req.user.id);
  if (hit && Date.now() - hit.at < 30000) return res.json(hit.data);
  let privateKeyPem;
  try { privateKeyPem = decrypt(conn.privateKeyEncrypted); } catch (e) {
    return res.status(500).json({ error: 'No se pudo descifrar tu clave de Kalshi en el servidor. Desconéctala y vuelve a conectarla.' });
  }
  try {
    const data = await kalshi.getPositions({ keyId: conn.keyId, privateKeyPem });
    await db.setKalshiLastSync(req.user.id, 'connected');
    const out = { connected: true, ...data, source: 'kalshi' };
    posCache.set(req.user.id, { at: Date.now(), data: out });
    res.json(out);
  } catch (e) {
    await db.setKalshiLastSync(req.user.id, 'error');
    console.log('[kalshi] error al leer posiciones:', e.status || '', e.message);
    res.status(502).json({ error: `Kalshi no devolvió tus posiciones (${e.message}). Revisa tu conexión en el panel.` });
  }
});

// --- Admin (solo rol admin) ---
router.get('/admin/stats', auth, requireAdmin, async (req, res) => {
  const users = await db.listUsers();
  res.json({ totalUsers: users.length, activeUsers: users.filter((u) => u.active).length, kalshiConnected: users.filter((u) => u.kalshiConnected).length });
});

router.get('/admin/users', auth, requireAdmin, async (req, res) => {
  const users = await db.listUsers();
  // NUNCA se devuelven password_hash ni claves privadas de Kalshi.
  res.json({ users });
});

router.patch('/admin/users/:id/active', auth, requireAdmin, async (req, res) => {
  const target = await db.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Usuario no encontrado.' });
  if (target.id === req.user.id && req.body && req.body.active === false) return res.status(400).json({ error: 'No puedes desactivar tu propia cuenta de admin.' });
  const updated = await db.setUserActive(target.id, req.body && req.body.active !== false);
  res.json({ user: { ...db.publicUser(updated), kalshiConnected: !!(await db.getKalshiConnection(target.id)) } });
});

router.post('/admin/users/:id/reset-password', auth, requireAdmin, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) return res.status(400).json({ error: 'La nueva contraseña necesita al menos 8 caracteres.' });
  const target = await db.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Usuario no encontrado.' });
  await db.setUserPassword(target.id, await hashPassword(newPassword));
  res.json({ ok: true });
});

module.exports = { router, init };
