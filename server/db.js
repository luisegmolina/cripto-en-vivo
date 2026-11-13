// Capa de datos v12 — usuarios + Kalshi (solo lectura) + datos de usuario.
// Dos modos:
//  - Con DATABASE_URL (Render/Neon): Postgres (pg Pool). Al arrancar se
//    crean las tablas cev_* si no existen (mismo SQL que schema.sql).
//  - Sin DATABASE_URL (dev local): archivo JSON en server/data/db.json.
//    En Render SIN DATABASE_URL los usuarios se perderían al reiniciar
//    (disco efímero): por eso DATABASE_URL es obligatoria en producción
//    (ver DEPLOYMENT.md). El modo archivo solo sirve para probar en local.
// La contraseña NUNCA se guarda en claro: solo password_hash (bcrypt).
// La clave privada de Kalshi NUNCA se guarda en claro: solo cifrada
// (AES-256-GCM, ver crypto.js); este módulo no la descifra jamás.
const fs = require('fs');
const path = require('path');

const hasPg = !!process.env.DATABASE_URL;
let pool = null;
if (hasPg) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
  pool.on('error', (e) => console.log('[db] error del pool Postgres (se reintentará):', e.message));
}

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
let fileDb = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cev_users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS cev_kalshi_connections (
  user_id INTEGER PRIMARY KEY REFERENCES cev_users(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL,
  private_key_encrypted TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sync_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS cev_user_data (
  user_id INTEGER NOT NULL REFERENCES cev_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('portfolio', 'alerts')),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, kind)
);
CREATE INDEX IF NOT EXISTS cev_users_email_idx ON cev_users (email);`;

function fileLoad() {
  if (fileDb) return fileDb;
  try {
    fileDb = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    fileDb = { seq: 1, users: [], kalshi: {}, data: {} };
  }
  return fileDb;
}
function fileSave() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(fileDb));
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name || '', role: u.role, active: u.active !== false, createdAt: u.created_at || u.createdAt || null };
}

async function init() {
  if (hasPg) {
    await pool.query(SCHEMA);
    console.log('[db] Postgres conectado (Neon): tablas cev_* listas.');
  } else {
    fileLoad();
    console.log('[db] Sin DATABASE_URL: modo archivo local (server/data/db.json). SOLO para probar en local; en producción pon DATABASE_URL en Render.');
  }
}

async function createUser({ email, passwordHash, name, role }) {
  const cleanEmail = String(email).trim().toLowerCase();
  if (hasPg) {
    const r = await pool.query(
      'INSERT INTO cev_users (email, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING *',
      [cleanEmail, passwordHash, String(name || '').slice(0, 50), role === 'admin' ? 'admin' : 'user']);
    return publicUser(r.rows[0]);
  }
  const db = fileLoad();
  if (db.users.some((u) => u.email === cleanEmail)) { const e = new Error('Ese email ya está registrado.'); e.code = 'EMAIL_TAKEN'; throw e; }
  const u = { id: db.seq++, email: cleanEmail, password_hash: passwordHash, name: String(name || '').slice(0, 50), role: role === 'admin' ? 'admin' : 'user', active: true, created_at: new Date().toISOString() };
  db.users.push(u);
  fileSave();
  return publicUser(u);
}

async function getUserByEmail(email) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (hasPg) {
    const r = await pool.query('SELECT * FROM cev_users WHERE email = $1', [cleanEmail]);
    return r.rows[0] || null;
  }
  return fileLoad().users.find((u) => u.email === cleanEmail) || null;
}

async function getUserById(id) {
  const n = Number(id);
  if (hasPg) {
    const r = await pool.query('SELECT * FROM cev_users WHERE id = $1', [n]);
    return r.rows[0] || null;
  }
  return fileLoad().users.find((u) => u.id === n) || null;
}

async function listUsers() {
  if (hasPg) {
    const r = await pool.query('SELECT u.*, (k.user_id IS NOT NULL) AS kalshi_connected, k.last_sync_at AS kalshi_last_sync FROM cev_users u LEFT JOIN cev_kalshi_connections k ON k.user_id = u.id ORDER BY u.created_at ASC');
    return r.rows.map((u) => ({ ...publicUser(u), kalshiConnected: !!u.kalshi_connected, kalshiLastSyncAt: u.kalshi_last_sync || null }));
  }
  const db = fileLoad();
  return db.users.map((u) => ({ ...publicUser(u), kalshiConnected: !!db.kalshi[u.id], kalshiLastSyncAt: db.kalshi[u.id] ? db.kalshi[u.id].lastSyncAt : null }));
}

async function setUserActive(id, active) {
  const n = Number(id);
  if (hasPg) {
    const r = await pool.query('UPDATE cev_users SET active = $2 WHERE id = $1 RETURNING *', [n, !!active]);
    return publicUser(r.rows[0]);
  }
  const db = fileLoad();
  const u = db.users.find((x) => x.id === n);
  if (!u) return null;
  u.active = !!active;
  fileSave();
  return publicUser(u);
}

async function setUserPassword(id, passwordHash) {
  const n = Number(id);
  if (hasPg) { await pool.query('UPDATE cev_users SET password_hash = $2 WHERE id = $1', [n, passwordHash]); return true; }
  const db = fileLoad();
  const u = db.users.find((x) => x.id === n);
  if (!u) return false;
  u.password_hash = passwordHash;
  fileSave();
  return true;
}

async function countAdmins() {
  if (hasPg) {
    const r = await pool.query("SELECT COUNT(*)::int AS n FROM cev_users WHERE role = 'admin'");
    return r.rows[0].n;
  }
  return fileLoad().users.filter((u) => u.role === 'admin').length;
}

async function setKalshiConnection(userId, { keyId, privateKeyEncrypted }) {
  const n = Number(userId);
  if (hasPg) {
    await pool.query(
      `INSERT INTO cev_kalshi_connections (user_id, key_id, private_key_encrypted, status, last_sync_at)
       VALUES ($1,$2,$3,'connected', NOW())
       ON CONFLICT (user_id) DO UPDATE SET key_id = EXCLUDED.key_id, private_key_encrypted = EXCLUDED.private_key_encrypted, status = 'connected', last_sync_at = NOW()`,
      [n, String(keyId).slice(0, 100), privateKeyEncrypted]);
    return true;
  }
  const db = fileLoad();
  db.kalshi[n] = { keyId: String(keyId).slice(0, 100), privateKeyEncrypted, status: 'connected', lastSyncAt: new Date().toISOString() };
  fileSave();
  return true;
}

async function getKalshiConnection(userId) {
  const n = Number(userId);
  if (hasPg) {
    const r = await pool.query('SELECT * FROM cev_kalshi_connections WHERE user_id = $1', [n]);
    const row = r.rows[0];
    if (!row) return null;
    return { userId: n, keyId: row.key_id, privateKeyEncrypted: row.private_key_encrypted, status: row.status, lastSyncAt: row.last_sync_at };
  }
  const c = fileLoad().kalshi[n];
  if (!c) return null;
  return { userId: n, keyId: c.keyId, privateKeyEncrypted: c.privateKeyEncrypted, status: c.status, lastSyncAt: c.lastSyncAt };
}

async function deleteKalshiConnection(userId) {
  const n = Number(userId);
  if (hasPg) { await pool.query('DELETE FROM cev_kalshi_connections WHERE user_id = $1', [n]); return true; }
  const db = fileLoad();
  delete db.kalshi[n];
  fileSave();
  return true;
}

async function setKalshiLastSync(userId, status) {
  const n = Number(userId);
  const now = new Date().toISOString();
  if (hasPg) { await pool.query('UPDATE cev_kalshi_connections SET last_sync_at = NOW(), status = $2 WHERE user_id = $1', [n, String(status || 'connected').slice(0, 50)]); return true; }
  const db = fileLoad();
  if (db.kalshi[n]) { db.kalshi[n].lastSyncAt = now; db.kalshi[n].status = String(status || 'connected').slice(0, 50); fileSave(); }
  return true;
}

async function getUserData(userId, kind) {
  const n = Number(userId);
  if (hasPg) {
    const r = await pool.query('SELECT data FROM cev_user_data WHERE user_id = $1 AND kind = $2', [n, kind]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  const d = fileLoad().data[`${n}:${kind}`];
  return d === undefined ? null : d;
}

async function setUserData(userId, kind, data) {
  const n = Number(userId);
  if (hasPg) {
    await pool.query(
      `INSERT INTO cev_user_data (user_id, kind, data, updated_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (user_id, kind) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [n, kind, JSON.stringify(data)]);
    return true;
  }
  const db = fileLoad();
  db.data[`${n}:${kind}`] = data;
  fileSave();
  return true;
}

module.exports = {
  init, hasPg, publicUser, createUser, getUserByEmail, getUserById, listUsers,
  setUserActive, setUserPassword, countAdmins, setKalshiConnection,
  getKalshiConnection, deleteKalshiConnection, setKalshiLastSync,
  getUserData, setUserData,
};
