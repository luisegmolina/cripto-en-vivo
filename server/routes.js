// Rutas v12 — usuarios, admin y Kalshi.
// Montadas en /api desde server/app.js. La app es SOLO LECTURA
// MIENTRAS el bot en vivo esté apagado (LIVE_TRADING_ENABLED no es
// 'true'): en ese modo la única llamada a Kalshi es GET a
// /portfolio/positions, /portfolio/balance y /portfolio/fills
// (ver kalshiServer.js, allowlist). Con live encendido Y armado en
// POST /kalshi/live/enable, liveTrader.js SÍ puede enviar órdenes
// (POST /trade-api/v2/portfolio/events/orders): es el único POST a
// Kalshi de todo el proyecto. La clave privada de Kalshi se guarda
// CIFRADA (crypto.js) y NUNCA se devuelve por ninguna API:
// las respuestas solo traen keyIdPreview (4 primeros + 4 últimos).
const express = require('express');
const db = require('./db');
const { hashPassword, verifyPassword, signToken, authMiddleware, requireAdmin, loginRateLimit, registerRateLimit, makeRateLimiter, DUMMY_HASH } = require('./auth');
const webauthn = require('./webauthn');
const siteGate = require('./siteGate');
const { encrypt, decrypt, masterKey } = require('./crypto');
const kalshi = require('./kalshiServer');
const brti = require('./brti');
const paperAuditor = require('./paperAuditor');
const liveTrader = require('./liveTrader');

// v16.1 — El auditor en papel persiste sus resultados (últimas 20
// ventanas) en cev_user_data kind 'paper_audit', solo al cerrar
// ventana y al parar/arrancar, nunca cada segundo.
paperAuditor.setPersistencia(async (userId, resultados) => {
  await db.setUserData(userId, 'paper_audit', { resultados, updatedAt: new Date().toISOString() });
});

// v16.3 — El historial sin tope del auditor (cada ventana liquidada,
// compacta) en cev_user_data kind 'cev_paper_windows' (array plano).
paperAuditor.setPersistenciaHistorial(async (userId, historial) => {
  await db.setUserData(userId, 'cev_paper_windows', Array.isArray(historial) ? historial : []);
});

// v16.2 — El bot en vivo persiste su registro de decisiones (máx. 50)
// en cev_user_data kind 'live_trade_log'. El trader solo descifra la
// clave de Kalshi en el camino de envío real (live encendido); en modo
// would-send nunca se pide ni se descifra. El observador del trader
// arranca perezoso y se apaga solo cuando no queda ningún auditor activo.
liveTrader.setPersistencia(async (userId, estado) => {
  await db.setUserData(userId, 'live_trade_log', estado);
});
liveTrader.setCargarEstado(async (userId) => {
  const d = await db.getUserData(userId, 'live_trade_log').catch(() => null);
  return d || null;
});
liveTrader.setCredentialsProvider(async (userId) => {
  const conn = await db.getKalshiConnection(userId);
  if (!conn) return null;
  try { return { keyId: conn.keyId, privateKeyPem: decrypt(conn.privateKeyEncrypted) }; } catch { return null; }
});
// v16.4 Parte 2 — Guarda de saldo del experimento live acotado: el
// trader consulta el saldo real de Kalshi antes de enviar (ver
// liveTrader.js handleViableSignal). Sin saldo legible no se envía
// (fail-closed). El saldo de Kalshi viene en centavos: se convierte
// a dólares. Un fallo aquí devuelve null, nunca un saldo inventado.
liveTrader.setBalanceProvider(async (userId) => {
  const conn = await db.getKalshiConnection(userId);
  if (!conn) return null;
  let privateKeyPem;
  try { privateKeyPem = decrypt(conn.privateKeyEncrypted); } catch { return null; }
  try {
    const j = await kalshi.kalshiGet('/trade-api/v2/portfolio/balance', { keyId: conn.keyId, privateKeyPem });
    const cents = j && j.balance != null ? Number(j.balance) : NaN;
    return Number.isFinite(cents) ? cents / 100 : null;
  } catch (e) {
    console.log('[live-trader] No se pudo leer el saldo de Kalshi para la guarda de saldo:', e.message);
    return null;
  }
});
liveTrader.ensureObservador();

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

// v16.3 — En producción el servidor NO arranca sin los secretos:
// JWT_SECRET (firmar sesiones) y KALSHI_ENCRYPTION_KEY (cifrar la
// clave de Kalshi). DATABASE_URL sigue siendo OPCIONAL: sin ella el
// servidor usa el modo archivo local (diseño actual; en Render hay
// que ponerla para no perder usuarios al reiniciar, ver db.js).
// Lanza Error con el mensaje claro; app.js lo convierte en salida
// del proceso en producción. Función pura de `env` para probarla.
function verificarVariablesArranque(env = process.env) {
  if ((env.NODE_ENV || '') !== 'production') return true;
  const falta = (msg) => {
    const e = new Error(msg);
    e.code = 'MISSING_SECRETS';
    return e;
  };
  if (!String(env.JWT_SECRET || '').trim()) {
    throw falta('Falta JWT_SECRET (variable de entorno en Render). En producción el servidor no arranca sin ella.');
  }
  const raw = String(env.KALSHI_ENCRYPTION_KEY || '').trim();
  if (!raw) {
    throw falta('Falta KALSHI_ENCRYPTION_KEY (variable de entorno en Render). En producción el servidor no arranca sin ella.');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    let ok = false;
    try { ok = Buffer.from(raw, 'base64').length === 32; } catch { ok = false; }
    if (!ok) throw falta('KALSHI_ENCRYPTION_KEY no es válida: usa 64 caracteres hex (32 bytes) o base64 de 32 bytes.');
  }
  return true;
}

// v16.3 — Cuenta única: el registro se cierra cuando ya existe algún
// usuario. init() crea el admin con db.createUser directo, no por
// esta ruta, así que no se rompe.
async function registroCerrado(dbMod) {
  const usuarios = await dbMod.listUsers();
  return Array.isArray(usuarios) && usuarios.length > 0;
}

// v16.3 — Arranque automático del auditor en papel: para cada usuario
// con autostart=true y conexión Kalshi guardada, abre el WS BRTI y
// arranca el auditor con su clave descifrada. Fail-closed por usuario:
// sin conexión, sin descifrado o con cualquier error, se registra el
// motivo y se sigue con el siguiente usuario (nunca tumba el arranque).
// Solo arranca el AUDITOR (papel): sin la env LIVE_TRADING_ENABLED y
// sin armar, no sale ninguna orden.
async function arrancarAutostart() {
  let usuarios;
  try {
    usuarios = await db.listUsers();
  } catch (e) {
    console.log('[autostart] No se pudo listar usuarios:', e.message);
    return;
  }
  for (const u of usuarios) {
    try {
      const settings = await db.getUserData(u.id, 'paper_audit_settings').catch(() => null);
      if (!settings || settings.autostart !== true) continue;
      const conn = await db.getKalshiConnection(u.id);
      if (!conn) {
        console.log(`[autostart] Usuario ${u.id}: autostart activo pero sin conexión Kalshi, no arranca.`);
        continue;
      }
      let privateKeyPem;
      try {
        privateKeyPem = decrypt(conn.privateKeyEncrypted);
      } catch {
        console.log(`[autostart] Usuario ${u.id}: no se pudo descifrar la clave de Kalshi, no arranca.`);
        continue;
      }
      brti.ensureBrti(u.id, { keyId: conn.keyId, privateKeyPem });
      const prev = await db.getUserData(u.id, 'paper_audit').catch(() => null);
      const hist = await db.getUserData(u.id, 'cev_paper_windows').catch(() => null);
      paperAuditor.setAutostart(u.id, true);
      paperAuditor.startAuditor(
        u.id,
        prev && Array.isArray(prev.resultados) ? prev.resultados : [],
        Array.isArray(hist) ? hist : [],
      );
      console.log(`[autostart] Auditor en papel arrancado para el usuario ${u.id}.`);
    } catch (e) {
      console.log(`[autostart] Usuario ${u.id}: no arrancó (${e.message}).`);
    }
  }
}

async function init() {
  // v16.3 — en producción, sin secretos no se arranca (falla cerrado).
  verificarVariablesArranque();
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
  // v16.3 — arranque automático del auditor en papel (solo papel).
  await arrancarAutostart();
}

// --- Auth ---
router.post('/auth/register', registerRateLimit, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!validEmail(email)) return res.status(400).json({ error: 'Pon un email válido.' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'La contraseña necesita al menos 8 caracteres.' });
  try {
    // v16.3 — cuenta única: si ya existe algún usuario, el registro
    // está cerrado (403). El admin se crea en init(), no por aquí.
    if (await registroCerrado(db)) return res.status(403).json({ error: 'El registro está cerrado: esta app es de un solo usuario.' });
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

// v16.4 — Entrada con huella / rostro (WebAuthn / passkeys, Parte 1).
// El login con WebAuthn devuelve la MISMA sesión JWT que el login con
// password; el password sigue funcionando exactamente igual. Los
// challenges son de un solo uso y caducan a los 5 minutos (ver
// server/webauthn.js): reutilizar o caducar un reto da 400.
// rpID: cripto-en-vivo.onrender.com. Solo autenticador de plataforma
// (huella/rostro del propio dispositivo).
// Límite: 20 intentos por IP cada 15 min en el registro (con sesión),
// y el mismo límite del login con password en el login por huella.
const webauthnRegisterRateLimit = makeRateLimiter({ max: 20, windowMs: 15 * 60 * 1000, keyFn: (req) => req.ip || '?', message: 'Demasiados intentos. Espera 15 minutos.' });

router.post('/auth/webauthn/register/options', auth, webauthnRegisterRateLimit, async (req, res) => {
  const options = await webauthn.crearOpcionesRegistro(db, req.user);
  res.json({ options });
});

router.post('/auth/webauthn/register/verify', auth, webauthnRegisterRateLimit, async (req, res) => {
  try {
    const cred = await webauthn.verificarRegistro(db, req.user, req.body || {});
    res.json({ ok: true, credential: cred });
  } catch (e) {
    res.status(400).json({ error: e.message || 'No se pudo registrar la huella.' });
  }
});

router.post('/auth/webauthn/login/options', loginRateLimit, async (req, res) => {
  const { email } = req.body || {};
  if (!validEmail(email)) return res.status(400).json({ error: 'Pon tu email para entrar con huella.' });
  const r = await webauthn.crearOpcionesLogin(db, String(email).trim().toLowerCase());
  if (!r) return res.status(404).json({ error: 'No hay ninguna huella registrada para ese email. Entra con tu contraseña.' });
  res.json({ options: r.options });
});

router.post('/auth/webauthn/login/verify', loginRateLimit, async (req, res) => {
  try {
    const user = await webauthn.verificarLogin(db, req.body || {});
    if (user.active === false) return res.status(403).json({ error: 'Tu cuenta está desactivada. Habla con el administrador.' });
    const pub = db.publicUser(user);
    return res.json({ token: signToken(pub), user: pub });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'No se pudo entrar con huella.' });
  }
});

// Huellas registradas en este usuario (sin claves públicas: solo id,
// transports y fechas, para mostrarlas en la pantalla).
router.get('/auth/webauthn/credentials', auth, async (req, res) => {
  const creds = await db.listWebauthnCredentials(req.user.id);
  res.json({
    credentials: creds.map((c) => ({
      credentialId: c.credential_id,
      transports: Array.isArray(c.transports) ? c.transports : [],
      createdAt: c.created_at || null,
      lastUsedAt: c.last_used_at || null,
    })),
  });
});

router.post('/auth/logout', auth, (req, res) => res.json({ ok: true }));

// --- PIN de acceso al sitio (v16.5) ---
// La puerta en sí (bloquear todo sin cookie cuando hay PIN) vive en
// server/siteGate.js, montada en app.js antes de todas las rutas. Aquí
// solo las rutas que la gestionan. El PIN y el código de recuperación
// solo existen como HASH bcrypt en cev_site_settings: nunca en claro,
// nunca en logs y nunca en otra respuesta que el recoveryCode de una
// sola vez al poner el PIN.
// Límite compartido: 5 intentos por IP cada 15 min entre verify y
// recover (son la misma puerta; un atacante no gana intentos cambiando
// de ruta). El 401 es genérico a propósito: no delata si el fallo fue
// el PIN o el código.
const siteGateRateLimit = makeRateLimiter({ max: 5, windowMs: 15 * 60 * 1000, keyFn: (req) => req.ip || '?', message: 'Demasiados intentos. Espera 15 minutos.' });

// Pública: ¿hay PIN puesto? Solo eso, sin filtrar nada más. El
// cliente la llama al arrancar para saber si debe pedir el código.
router.get('/site-gate/status', async (req, res) => {
  const hash = await db.getSiteSetting('gate_pin_hash');
  // v16.5 — locked es "puerta cerrada PARA ESTE NAVEGADOR": hay PIN
  // y esta petición no trae cookie de puerta válida. Sin esto, un
  // navegador que ya verificó (cookie de 30 días) seguiría viendo la
  // pantalla del PIN en cada arranque, y tras verify el cliente
  // quedaría atascado en locked:true porque el PIN sigue existiendo.
  res.json({ locked: !!hash && !siteGate.gateCookieValid(req) });
});

// Pública: entrar con el PIN. Correcto → cookie de puerta (30 días)
// en la respuesta + {ok:true}. Sin PIN puesto → 400 (el cliente solo
// llama aquí cuando status dice locked:true).
router.post('/site-gate/verify', siteGateRateLimit, async (req, res) => {
  const pinHash = await db.getSiteSetting('gate_pin_hash');
  if (!pinHash) return res.status(400).json({ error: 'No hay código de acceso puesto.' });
  const { pin } = req.body || {};
  const ok = typeof pin === 'string' && pin.length > 0 && await verifyPassword(pin, pinHash);
  if (!ok) return res.status(401).json({ error: 'Código incorrecto.' });
  siteGate.setGateCookie(res);
  res.json({ ok: true });
});

// Admin (JWT + rol admin): poner o cambiar el PIN. Si ya hay PIN,
// exige el actual (401 si falla); si no hay, no lo exige. El PIN
// nuevo necesita 4-32 caracteres. Al poner/cambiar se genera UN
// código de recuperación nuevo: su hash se guarda y el código en
// claro vuelve SOLO en esta respuesta (no se guarda ni se loguea).
// También pone la cookie de puerta para no bloquear la sesión del
// admin que lo pone. Para llegar aquí con PIN puesto hace falta la
// cookie (la puerta la exige antes que el JWT): primero verify.
router.post('/site-gate/pin', auth, requireAdmin, async (req, res) => {
  const { pin, currentPin } = req.body || {};
  const existingHash = await db.getSiteSetting('gate_pin_hash');
  if (existingHash) {
    const ok = typeof currentPin === 'string' && await verifyPassword(currentPin, existingHash);
    if (!ok) return res.status(401).json({ error: 'El código actual no es correcto.' });
  }
  if (!siteGate.validPin(pin)) return res.status(400).json({ error: 'El código de acceso necesita entre 4 y 32 caracteres.' });
  const recoveryCode = siteGate.generateRecoveryCode();
  await db.setSiteSetting('gate_pin_hash', await hashPassword(pin));
  await db.setSiteSetting('gate_recovery_hash', await hashPassword(recoveryCode));
  siteGate.setGateCookie(res);
  res.json({ ok: true, recoveryCode });
});

// Admin (JWT + rol admin): quitar el PIN. Exige el PIN actual; borra
// el PIN y el código de recuperación y la puerta queda abierta.
router.post('/site-gate/pin/remove', auth, requireAdmin, async (req, res) => {
  const { currentPin } = req.body || {};
  const existingHash = await db.getSiteSetting('gate_pin_hash');
  if (!existingHash) return res.status(400).json({ error: 'No hay código de acceso puesto.' });
  const ok = typeof currentPin === 'string' && await verifyPassword(currentPin, existingHash);
  if (!ok) return res.status(401).json({ error: 'El código actual no es correcto.' });
  await db.deleteSiteSetting('gate_pin_hash');
  await db.deleteSiteSetting('gate_recovery_hash');
  res.json({ ok: true });
});

// Pública: entrar con el código de recuperación (el que se dio UNA
// vez al poner el PIN). Correcto → borra PIN y código, la puerta
// queda abierta ({ok:true}, sin cookie porque ya no hay PIN).
router.post('/site-gate/recover', siteGateRateLimit, async (req, res) => {
  const recHash = await db.getSiteSetting('gate_recovery_hash');
  if (!recHash) return res.status(400).json({ error: 'No hay código de acceso puesto.' });
  const { code } = req.body || {};
  const ok = typeof code === 'string' && code.length > 0 && await verifyPassword(code, recHash);
  if (!ok) return res.status(401).json({ error: 'Código incorrecto.' });
  await db.deleteSiteSetting('gate_pin_hash');
  await db.deleteSiteSetting('gate_recovery_hash');
  res.json({ ok: true });
});

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
  await liveTrader.kill(req.user.id, 'kalshi_disconnected').catch(() => {}); // sin Kalshi no hay bot en vivo
  // v16.3 — sin conexión tampoco hay arranque automático: se apaga el
  // flag para que el próximo arranque no lo intente sin clave.
  paperAuditor.setAutostart(req.user.id, false);
  await db.setUserData(req.user.id, 'paper_audit_settings', { autostart: false, updatedAt: new Date().toISOString() }).catch(() => {});
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
  const hist = await db.getUserData(req.user.id, 'cev_paper_windows').catch(() => null);
  const snap = paperAuditor.startAuditor(
    req.user.id,
    prev && Array.isArray(prev.resultados) ? prev.resultados : [],
    Array.isArray(hist) ? hist : [],
  );
  res.json({ ok: true, ...snap, kalshiConnected: true });
});

router.post('/kalshi/paper-audit/stop', auth, async (req, res) => {
  const snap = await paperAuditor.stopAuditor(req.user.id);
  const conn = await db.getKalshiConnection(req.user.id);
  res.json({ ok: true, ...snap, kalshiConnected: !!conn });
});

// v16.3 — Arranque automático del auditor en papel al reiniciar el
// servidor. Solo afecta al AUDITOR (papel): sin la env
// LIVE_TRADING_ENABLED y sin armar, no sale ninguna orden.
// Default false; se persiste por usuario (kind 'paper_audit_settings').
// Apagarlo NO detiene el auditor que ya está corriendo: para eso está
// Detener. El flag solo manda en el próximo arranque.
router.post('/kalshi/paper-audit/autostart', auth, async (req, res) => {
  const v = req.body && req.body.autostart === true;
  paperAuditor.setAutostart(req.user.id, v);
  await db.setUserData(req.user.id, 'paper_audit_settings', { autostart: v, updatedAt: new Date().toISOString() });
  const snap = paperAuditor.getSnapshot(req.user.id);
  res.json({ ok: true, ...snap });
});

// v16.2 — BOT EN VIVO (APAGADO por defecto). Ninguna de estas rutas
// envía órdenes directamente: las órdenes solo salen desde
// liveTrader.handleViableSignal al evaluar una señal viable del
// auditor. LIVE_TRADING_ENABLED='true' en el servidor es el
// interruptor global; sin ella, enable devuelve 403 y todo queda en
// would-send. El kill switch (POST /kalshi/live/kill) está siempre
// disponible y es persistente.
router.get('/kalshi/live/status', auth, async (req, res) => {
  await liveTrader.cargarEstadoSiHaceFalta(req.user.id);
  const snap = liveTrader.getSnapshot(req.user.id);
  const conn = await db.getKalshiConnection(req.user.id);
  res.json({ ...snap, kalshiConnected: !!conn });
});

router.post('/kalshi/live/kill', auth, async (req, res) => {
  const snap = await liveTrader.kill(req.user.id, 'manual');
  const conn = await db.getKalshiConnection(req.user.id);
  res.json({ ok: true, ...snap, kalshiConnected: !!conn });
});

router.post('/kalshi/live/enable', auth, async (req, res) => {
  if (!liveTrader.isLiveEnabled()) {
    return res.status(403).json({ error: 'El trading en vivo está apagado en el servidor (LIVE_TRADING_ENABLED no es \'true\'). Activarlo exige poner esa variable en el servidor Y una decisión explícita tuya: no se enciende solo desde la web.' });
  }
  const conn = await db.getKalshiConnection(req.user.id);
  if (!conn) return res.status(400).json({ error: 'Conecta primero tu cuenta Kalshi: sin credenciales no hay nada que firmar.' });
  const snap = await liveTrader.arm(req.user.id);
  res.json({ ok: true, ...snap, kalshiConnected: true });
});

// v16.4 Parte 2 — EXPERIMENTO LIVE ACOTADO (decidido por Luis,
// 18-nov-2026). Activa/desactiva el modo experimento del trader:
// 1 contrato por orden y tope de $5 USD de notional por orden (el
// default global sigue siendo 2 contratos, sin tope). NO enciende
// live ni arma nada: solo cambia los límites que verificarLimites
// aplicará CUANDO live esté encendido y armado. Sin pagos, sin plan
// Starter de Render: Luis despierta la web él mismo cuando se duerme.
// Marco de Luis: la web es el producto que le dará dinero; el bot es
// un experimento acotado al lado, no el negocio.
router.post('/kalshi/live/experiment', auth, async (req, res) => {
  const body = req.body || {};
  try {
    const snap = await liveTrader.setExperiment(req.user.id, {
      experimentMode: body.experimentMode === true,
      contractsPerOrder: body.contractsPerOrder,
      maxNotionalUsdPerOrder: body.maxNotionalUsdPerOrder,
      maxOrdersPerDay: body.maxOrdersPerDay,
    });
    const conn = await db.getKalshiConnection(req.user.id);
    res.json({ ok: true, ...snap, kalshiConnected: !!conn });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Configuración de experimento no válida.' });
  }
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

module.exports = { router, init, verificarVariablesArranque, registroCerrado };
