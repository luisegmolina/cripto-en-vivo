// Pruebas de integración offline del servidor (modo archivo, sin red de exchanges).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = 'test-secret-1234567890';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cev-'));
process.env.ADMIN_EMAIL = 'admin@ejemplo.com';
process.env.ADMIN_PASSWORD = 'AdminPass123';

const dbPath = require.resolve('../server/db.js');
let app, server, base, db, jwt;
before(async () => {
  // El modo archivo escribe en server/data/db.json: se hace una copia de seguridad y se restaura al final.
  const file = path.join(path.dirname(dbPath), 'data', 'db.json');
  globalThis.__bak = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (fs.existsSync(file)) fs.unlinkSync(file);
  // Un usuario normal se registra ANTES de que exista el admin con el mismo email.
  db = require('../server/db.js');
  await db.init();
  const { hashPassword } = require('../server/auth.js');
  await db.createUser({ email: 'admin@ejemplo.com', passwordHash: await hashPassword('ContrasenaVieja1'), name: 'Intruso', role: 'user' });
  app = require('../server/app.js');
  await new Promise((r) => setTimeout(r, 400)); // init() de routes en segundo plano
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  jwt = require('jsonwebtoken');
});
after(() => {
  server && server.close();
  const file = path.join(path.dirname(dbPath), 'data', 'db.json');
  if (globalThis.__bak) fs.writeFileSync(file, globalThis.__bak); else if (fs.existsSync(file)) fs.unlinkSync(file);
});
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('el email que ya existía como usuario se promueve a admin con ADMIN_PASSWORD', async () => {
  const r = await post('/api/auth/login', { email: 'admin@ejemplo.com', password: 'AdminPass123' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.user.role, 'admin');
});
test('la contraseña antigua ya no entra', async () => {
  const r = await post('/api/auth/login', { email: 'admin@ejemplo.com', password: 'ContrasenaVieja1' });
  assert.equal(r.status, 401);
});
test('un token anterior al cambio de rol/contraseña queda invalidado', async () => {
  const u = await db.getUserByEmail('admin@ejemplo.com');
  const old = jwt.sign({ sub: u.id, email: u.email, role: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '7d', noTimestamp: false });
  const stale = jwt.sign({ sub: u.id, iat: Math.floor(Date.now() / 1000) - 3600 }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  const r = await fetch(base + '/api/admin/stats', { headers: { Authorization: `Bearer ${stale}` } });
  assert.equal(r.status, 401);
  const ok = await fetch(base + '/api/admin/stats', { headers: { Authorization: `Bearer ${old}` } });
  assert.equal(ok.status, 200);
});
test('jwt con algoritmo distinto de HS256 se rechaza', async () => {
  const u = await db.getUserByEmail('admin@ejemplo.com');
  const t = jwt.sign({ sub: u.id }, process.env.JWT_SECRET, { algorithm: 'HS512' });
  const r = await fetch(base + '/api/auth/me', { headers: { Authorization: `Bearer ${t}` } });
  assert.equal(r.status, 401);
});
test('JSON mal formado responde 400 JSON (no cuelga)', async () => {
  const r = await post('/api/auth/login', '{"email": ');
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error);
});
test('un fallo de BD en un handler async responde 500 JSON y no cuelga la petición', async () => {
  const orig = db.getUserByEmail;
  db.getUserByEmail = async () => { throw new Error('BD caída (simulada)'); };
  try {
    const r = await post('/api/auth/login', { email: 'x@ejemplo.com', password: 'abcdefgh' });
    assert.equal(r.status, 500);
    assert.match((await r.json()).error, /Error interno/);
  } finally { db.getUserByEmail = orig; }
});
test('login con email inexistente ejecuta bcrypt (tiempo parecido al de un email real)', async () => {
  const t = async (email) => { const s = process.hrtime.bigint(); await post('/api/auth/login', { email, password: 'abcdefgh' }); return Number(process.hrtime.bigint() - s) / 1e6; };
  await t('nadie@ejemplo.com'); // calentar
  const noUser = await t('nadie2@ejemplo.com');
  assert.ok(noUser > 20, `respuesta demasiado rápida (${noUser.toFixed(1)} ms): no se ejecutó bcrypt`);
});
test('registro: 11.º intento desde la misma IP en una hora devuelve 429', async () => {
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await post('/api/auth/register', { email: `u${i}@ejemplo.com`, password: 'Contrasena123' })).status);
  assert.ok(codes.includes(429), codes.join(','));
});
test('login: tras 10 intentos fallidos con el mismo email, 429', async () => {
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await post('/api/auth/login', { email: 'victima@ejemplo.com', password: 'mala-contrasena' })).status);
  assert.equal(codes[0], 401);
  assert.equal(codes.at(-1), 429);
});
test('CORS: en producción sin CORS_ORIGINS no hay cabeceras CORS; con CORS_ORIGINS solo ese origen', async () => {
  const { execFileSync } = await import('node:child_process');
  const probe = (extraEnv) => JSON.parse(execFileSync(process.execPath, ['-e', `
    const app = require('./server/app.js');
    const s = app.listen(0, async () => {
      const r = await fetch('http://127.0.0.1:' + s.address().port + '/api/health', { headers: { Origin: 'https://a.com' } });
      console.log(JSON.stringify({ acao: r.headers.get('access-control-allow-origin') }));
      process.exit(0);
    });`], { cwd: path.resolve(path.dirname(dbPath), '..'), env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(20), KALSHI_ENCRYPTION_KEY: 'a'.repeat(64), ...extraEnv }, encoding: 'utf8' }).trim().split('\n').pop());
  assert.equal(probe({}).acao, null);
  assert.equal(probe({ CORS_ORIGINS: 'https://a.com,https://b.com' }).acao, 'https://a.com');
  assert.equal(probe({ CORS_ORIGINS: 'https://b.com' }).acao, null);
});
