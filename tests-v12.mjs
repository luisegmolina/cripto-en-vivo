// Pruebas v12 — usuarios + Kalshi SOLO LECTURA.
// Se corre con el servidor local ya arrancado en :3001 (modo archivo,
// sin DATABASE_URL) y con ADMIN_EMAIL/ADMIN_PASSWORD de prueba.
// Uso: node tests-v12.mjs
// Comprueba: registro/login/JWT, admin solo para admin, clave privada
// cifrada en la BD (nunca en claro), firma Kalshi Ed25519+RSA, y que
// NO existe ningún endpoint de escritura de Kalshi.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';

const BASE = 'http://localhost:3001';
let pass = 0;
function ok(name, cond) { assert.ok(cond, name); pass++; console.log(`  ✓ ${name}`); }
async function j(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

const email = `test${Date.now()}@ejemplo.com`;

// 1. Salud y precios siguen funcionando (nada de v7-v11 se rompió)
console.log('— salud y precios —');
let r = await j('GET', '/api/health');
ok('health OK', r.status === 200 && r.data.ok === true);
r = await j('GET', '/api/ticker?symbol=BTC&currency=USD');
ok('ticker BTC real > 0', r.status === 200 && r.data.price > 0);
console.log(`  (BTC $${r.data.price} vía ${r.data.source})`);
r = await j('GET', '/api/candles?symbol=BTC&currency=USD&interval=15m');
ok('velas 15m reales', r.status === 200 && Array.isArray(r.data.candles) && r.data.candles.length > 10);

// 2. Registro / login / JWT
console.log('— auth —');
r = await j('POST', '/api/auth/register', { email, password: 'clave-secreta-123', name: 'Prueba' });
ok('registro 201 con token', r.status === 201 && r.data.token && r.data.user.role === 'user');
const userToken = r.data.token;
r = await j('POST', '/api/auth/register', { email, password: 'clave-secreta-123', name: 'Prueba' });
ok('email duplicado 400', r.status === 400);
r = await j('POST', '/api/auth/register', { email: 'otro@ejemplo.com', password: 'corta', name: 'X' });
ok('contraseña corta 400', r.status === 400);
r = await j('POST', '/api/auth/login', { email, password: 'clave-mala' });
ok('login con clave mala 401', r.status === 401);
r = await j('POST', '/api/auth/login', { email, password: 'clave-secreta-123' });
ok('login OK con token', r.status === 200 && r.data.token);
r = await j('GET', '/api/auth/me', null, userToken);
ok('me devuelve el usuario', r.status === 200 && r.data.user.email === email);
r = await j('GET', '/api/auth/me');
ok('me sin token 401', r.status === 401);

// 3. Admin: usuario normal NO puede entrar; admin sí
console.log('— admin —');
r = await j('GET', '/api/admin/users', null, userToken);
ok('usuario normal no ve admin (403)', r.status === 403);
r = await j('POST', '/api/auth/login', { email: process.env.ADMIN_EMAIL_TEST, password: process.env.ADMIN_PASS_TEST });
ok('login admin OK', r.status === 200 && r.data.user.role === 'admin');
const adminToken = r.data.token;
r = await j('GET', '/api/admin/users', null, adminToken);
ok('admin lista usuarios sin password_hash', r.status === 200 && Array.isArray(r.data.users) && r.data.users.length >= 2 && !JSON.stringify(r.data.users).includes('password_hash'));
ok('admin ve a Prueba en la lista', r.data.users.some((u) => u.email === email));
r = await j('GET', '/api/admin/stats', null, adminToken);
ok('admin stats', r.status === 200 && r.data.totalUsers >= 2);
const targetId = r.data && (await j('GET', '/api/admin/users', null, adminToken)).data.users.find((u) => u.email === email).id;
r = await j('PATCH', `/api/admin/users/${targetId}/active`, { active: false }, adminToken);
ok('admin desactiva usuario', r.status === 200 && r.data.user.active === false);
r = await j('POST', '/api/auth/login', { email, password: 'clave-secreta-123' });
ok('usuario desactivado no puede entrar (403)', r.status === 403);
r = await j('PATCH', `/api/admin/users/${targetId}/active`, { active: true }, adminToken);
ok('admin reactiva usuario', r.status === 200 && r.data.user.active === true);
r = await j('POST', `/api/admin/users/${targetId}/reset-password`, { newPassword: 'nueva-clave-456' }, adminToken);
ok('admin resetea contraseña', r.status === 200 && r.data.ok === true);
r = await j('POST', '/api/auth/login', { email, password: 'nueva-clave-456' });
ok('login con la contraseña reseteada', r.status === 200);

// 4. Kalshi: la clave privada NUNCA viaja en claro ni se devuelve
console.log('— kalshi solo lectura —');
r = await j('GET', '/api/kalshi/status', null, userToken);
ok('sin conectar: connected false', r.status === 200 && r.data.connected === false);
r = await j('GET', '/api/kalshi/positions', null, userToken);
ok('sin conectar: positions vacías', r.status === 200 && r.data.connected === false && Array.isArray(r.data.positions));
// Clave de prueba (generada solo para este test, se borra después)
const { privateKey: edPem, publicKey: edPub } = crypto.generateKeyPairSync('ed25519');
const edPemText = edPem.export({ type: 'pkcs8', format: 'pem' });
r = await j('POST', '/api/kalshi/connect', { keyId: 'test-key-id-12345678', privateKey: 'no es un pem' }, userToken);
ok('clave privada inválida 400', r.status === 400);
r = await j('POST', '/api/kalshi/connect', { keyId: 'test-key-id-12345678', privateKey: edPemText }, userToken);
// Kalshi rechazará la clave de prueba (no existe en su cuenta): 400, y NO se guarda nada.
ok('clave de prueba rechazada por Kalshi (400) y no se guarda', r.status === 400);
r = await j('GET', '/api/kalshi/status', null, userToken);
ok('tras rechazo sigue desconectado', r.status === 200 && r.data.connected === false);

// 5. Cifrado y firma (módulos del servidor, importados directos)
console.log('— cifrado y firma —');
const { encrypt, decrypt, isEncrypted } = await import('./server/crypto.js');
const blob = encrypt(edPemText);
ok('cifrado no contiene el pem en claro', isEncrypted(blob) && !blob.includes('PRIVATE KEY') && decrypt(blob) === edPemText);
const { signHeaders, parsePrivateKey, READ_ONLY_PATHS } = await import('./server/kalshiServer.js');
ok('parse Ed25519', parsePrivateKey(edPemText).type === 'ed25519');
const h = signHeaders({ keyId: 'k1', privateKeyPem: edPemText, method: 'GET', path: '/trade-api/v2/portfolio/positions' });
ok('headers de firma Ed25519', h['KALSHI-ACCESS-KEY'] === 'k1' && h['KALSHI-ACCESS-SIGNATURE'] && h['KALSHI-ACCESS-TIMESTAMP']);
const msg = h['KALSHI-ACCESS-TIMESTAMP'] + 'GET/trade-api/v2/portfolio/positions';
ok('firma Ed25519 verifica con la clave pública', crypto.verify(null, Buffer.from(msg), edPub, Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64')));
const { privateKey: rsaPem, publicKey: rsaPub } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaText = rsaPem.export({ type: 'pkcs1', format: 'pem' });
ok('parse RSA', parsePrivateKey(rsaText).type === 'rsa');
const hr = signHeaders({ keyId: 'k1', privateKeyPem: rsaText, method: 'GET', path: '/trade-api/v2/portfolio/balance' });
const msgR = hr['KALSHI-ACCESS-TIMESTAMP'] + 'GET/trade-api/v2/portfolio/balance';
ok('firma RSA-PSS verifica con la clave pública', crypto.verify('sha256', Buffer.from(msgR), { key: rsaPub, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(hr['KALSHI-ACCESS-SIGNATURE'], 'base64')));
ok('allowlist solo lectura (3 rutas)', READ_ONLY_PATHS.size === 3 && READ_ONLY_PATHS.has('/trade-api/v2/portfolio/positions') && READ_ONLY_PATHS.has('/trade-api/v2/portfolio/balance') && READ_ONLY_PATHS.has('/trade-api/v2/portfolio/fills'));

// 6. Nada en claro en la BD local ni endpoints de escritura
console.log('— secretos y escritura —');
const dbFile = './server/data/db.json';
if (existsSync(dbFile)) {
  const raw = readFileSync(dbFile, 'utf8');
  ok('la BD local no guarda contraseñas en claro', !raw.includes('clave-secreta-123') && !raw.includes('nueva-clave-456'));
  ok('la BD local no guarda el pem en claro', !raw.includes('PRIVATE KEY'));
} else { console.log('  (sin archivo de BD local: se usa Postgres)'); }
const routesSrc = readFileSync('./server/routes.js', 'utf8');
const kalshiSrc = readFileSync('./server/kalshiServer.js', 'utf8');
ok('no hay POST/PUT/DELETE a Kalshi en el servidor', !kalshiSrc.includes("method: 'POST'") && !kalshiSrc.includes("method: 'PUT'") && !kalshiSrc.includes("method: 'DELETE'") && !kalshiSrc.includes("'/trade-api/v2/portfolio/orders'"));
const resJsonLines = routesSrc.split('\n').filter((l) => l.includes('res.json'));
ok('ninguna respuesta JSON incluye la clave cifrada', !resJsonLines.some((l) => l.includes('privateKeyEncrypted')));
const appSrc = readFileSync('./server/app.js', 'utf8');
ok('app.js monta las rutas v12', appSrc.includes("require('./routes')"));

console.log(`\n✅ tests-v12: ${pass} comprobaciones pasaron.`);
