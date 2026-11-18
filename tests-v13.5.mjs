// tests-v13.5.mjs — Valor en vivo de Kalshi (BRTI) por WebSocket
// (aprobado por Luis, 17-nov-2026).
//
// Contexto verificado contra docs.kalshi.com:
// - KXBTC15M se liquida con el índice CF Benchmarks BRTI (promedio
//   de 60 s al final de la ventana), NO con Coinbase ni con Pyth.
//   Pyth NO liquida este mercado (canal pyth_value existe, pero no
//   es la fuente de liquidación).
// - El canal `cfbenchmarks_value` trae el valor BRTI en vivo, el
//   promedio de 60 s y, en el último minuto, el promedio final de
//   la ventana. Requiere autenticación: la conexión WS misma pide
//   la clave API en el handshake (mensaje firmado
//   `{timestamp}GET/trade-api/ws/v2`), incluso para datos públicos.
// - Forma del mensaje (verificado en tráfico real por terceros):
//   `msg.data` es un STRING JSON (segunda decodificación), y
//   `avg_60s_data` es un objeto normal. El timestamp del tick es
//   `received_at` (epoch ms).
//
// Arreglo v13.5:
//  1. server/brti.js: conexión WS por usuario conectado (clave
//     descifrada solo en el servidor), suscripción a
//     cfbenchmarks_value con index_ids ["BRTI"], último tick en
//     memoria, reconexión con backoff, cierre tras 5 min sin sondeo.
//  2. GET /api/kalshi/brti (autenticado): lee el último tick. Sin
//     Kalshi conectado NO se abre ninguna conexión y responde
//     connected:false (el cliente cae a Coinbase con aviso).
//  3. Pestaña Kalshi: "BRTI ahora" en vivo, promedio
//     de 60 s, diferencia contra el objetivo y GANANDO/PERDIENDO
//     según el BRTI (brtiWinning: SOLO contra el promedio de 60 s;
//     CORRECCIÓN v15: sin promedio no hay resultado, el tick
//     instantáneo nunca liquida; >= liquida SÍ).
// Uso: node tests-v13.5.mjs (después de npm --prefix client run build)

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { frontendSrc } from './frontendSrc.mjs';

const require = createRequire(import.meta.url);
const brti = require('./server/brti.js');
const { parseCfBenchmarksMessage, wsAuthHeaders, getBrtiState, stopBrti, ensureBrti } = brti;
const kalshiClient = await import('./client/src/kalshi.js');
const { brtiWinning } = kalshiClient;

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
const src = (p) => readFileSync(p, 'utf8');

// --- 1. Parseo del mensaje cfbenchmarks_value (forma real) ---
const realMsg = JSON.stringify({
  type: 'cfbenchmarks_value',
  msg: {
    data: JSON.stringify({ type: 'value', time: 1784775705000, id: 'BRTI', value: '65766.03' }),
    avg_60s_data: { value: '65760.10' },
    received_at: 1784775705000,
  },
});
const t1 = parseCfBenchmarksMessage(realMsg);
check('mensaje real: valor BRTI 65766.03', t1 && t1.value === 65766.03, JSON.stringify(t1));
check('mensaje real: promedio 60 s 65760.10', t1 && t1.avg60s === 65760.10);
check('mensaje real: receivedAt del tick', t1 && t1.receivedAt === 1784775705000);
check('mensaje real: sin promedio final si no viene', t1 && t1.avg15mFinal === null);

const withFinal = JSON.stringify({
  type: 'cfbenchmarks_value',
  msg: {
    data: { type: 'value', time: 1784775705000, id: 'BRTI', value: '65770.00' },
    avg_60s_data: { value: 65765.5 },
    last_60s_windowed_average_15min: { value: '65762.25' },
    received_at: 1784775705000,
  },
});
const t2 = parseCfBenchmarksMessage(withFinal);
check('data como objeto (no string) también se parsea', t2 && t2.value === 65770);
check('promedio final de ventana presente se parsea', t2 && t2.avg15mFinal === 65762.25);
check('avg60s como número directo se parsea', t2 && t2.avg60s === 65765.5);

const wrongIndex = JSON.stringify({ type: 'cfbenchmarks_value', msg: { data: JSON.stringify({ type: 'value', time: 1, id: 'ETHUSD_RTI', value: '3000.00' }), received_at: 1 } });
check('otro índice (ETHUSD_RTI) = null, no se confunde con BTC', parseCfBenchmarksMessage(wrongIndex) === null);
check('otro tipo de mensaje (ticker) = null', parseCfBenchmarksMessage(JSON.stringify({ type: 'ticker', msg: {} })) === null);
check('basura no-JSON = null', parseCfBenchmarksMessage('no-json{{{') === null);
check('data string con JSON inválido = null', parseCfBenchmarksMessage(JSON.stringify({ type: 'cfbenchmarks_value', msg: { data: '{roto', received_at: 1 } })) === null);
check('sin valor = null (no se inventa)', parseCfBenchmarksMessage(JSON.stringify({ type: 'cfbenchmarks_value', msg: { data: JSON.stringify({ type: 'value', id: 'BRTI' }), received_at: 1 } })) === null);
check('sin avg60s: value sí, avg60s null', (() => { const t = parseCfBenchmarksMessage(JSON.stringify({ type: 'cfbenchmarks_value', msg: { data: JSON.stringify({ type: 'value', id: 'BRTI', value: '70000' }), received_at: 1 } })); return t && t.value === 70000 && t.avg60s === null; })());

// --- 2. Firma del handshake WS ---
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const headers = wsAuthHeaders({ keyId: 'test-key-id-1234', privateKeyPem: pem });
const ts = headers['KALSHI-ACCESS-TIMESTAMP'];
const sigOk = crypto.verify(null, Buffer.from(`${ts}GET/trade-api/ws/v2`, 'utf8'), publicKey, Buffer.from(headers['KALSHI-ACCESS-SIGNATURE'], 'base64'));
check('handshake WS: firma Ed25519 válida sobre "{ts}GET/trade-api/ws/v2"', sigOk === true);
check('handshake WS: trae las 3 cabeceras', headers['KALSHI-ACCESS-KEY'] === 'test-key-id-1234' && !!headers['KALSHI-ACCESS-TIMESTAMP'] && !!headers['KALSHI-ACCESS-SIGNATURE']);
check('handshake WS: clave RSA también firma (mismo mensaje)', (() => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const h = wsAuthHeaders({ keyId: 'rsa-key', privateKeyPem: rsaPem });
  return crypto.verify('sha256', Buffer.from(`${h['KALSHI-ACCESS-TIMESTAMP']}GET/trade-api/ws/v2`, 'utf8'), { key: rsa.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64'));
})());

// --- 3. Sin Kalshi conectado no hay conexión ---
check('sin usuario: getBrtiState = null (no se abrió nada)', getBrtiState('usuario-que-no-existe') === null);
check('stopBrti de un usuario sin conexión no lanza', (() => { try { stopBrti('usuario-que-no-existe'); return true; } catch { return false; } })());
check('ensureBrti solo se llama con las credenciales descifradas del usuario conectado', src('server/routes.js').includes('brti.ensureBrti(req.user.id, { keyId: conn.keyId, privateKeyPem })'));

// --- 4. GANANDO/PERDIENDO según BRTI (brtiWinning) ---
const TARGET = 70487.89;
check('SUBE + avg60s 70500 >= objetivo = GANANDO (ref avg60s)', (() => { const r = brtiWinning({ dir: 'up', targetPrice: TARGET, avg60s: 70500, value: 70400 }); return r && r.winning === true && r.refLabel === 'avg60s'; })());
check('SUBE + avg60s 70400 < objetivo = PERDIENDO', brtiWinning({ dir: 'up', targetPrice: TARGET, avg60s: 70400, value: 70500 }).winning === false);
check('BAJA + avg60s 70400 < objetivo = GANANDO', brtiWinning({ dir: 'down', targetPrice: TARGET, avg60s: 70400, value: 70500 }).winning === true);
check('BAJA + avg60s 70500 >= objetivo = PERDIENDO', brtiWinning({ dir: 'down', targetPrice: TARGET, avg60s: 70500, value: 70400 }).winning === false);
check('SUBE + avg == objetivo exacto = GANANDO (>= liquida SÍ)', brtiWinning({ dir: 'up', targetPrice: TARGET, avg60s: TARGET, value: TARGET }).winning === true);
check('CORRECCIÓN v15: sin avg60s = null aunque el tick esté por encima (el tick nunca liquida)', brtiWinning({ dir: 'up', targetPrice: TARGET, avg60s: null, value: 70500 }) === null);
check('sin objetivo = null (no se inventa)', brtiWinning({ dir: 'up', targetPrice: null, avg60s: 70500, value: 70500 }) === null);
check('sin dirección = null', brtiWinning({ dir: null, targetPrice: TARGET, avg60s: 70500, value: 70500 }) === null);
check('sin precios = null', brtiWinning({ dir: 'up', targetPrice: TARGET, avg60s: null, value: null }) === null);
check('diff y diffPct con signo correcto (avg 70500 vs 70487.89)', (() => { const r = brtiWinning({ dir: 'up', targetPrice: TARGET, avg60s: 70500, value: 70500 }); return r && Math.abs(r.diff - 12.11) < 0.01 && r.diffPct > 0; })());

// --- 5. Cableado servidor + cliente (estáticos) ---
const routes = src('server/routes.js');
check('routes.js tiene GET /kalshi/brti', routes.includes("'/kalshi/brti'"));
check('routes.js cierra el WS al desconectar Kalshi', routes.includes('stopBrti(req.user.id)'));
check('routes.js: /kalshi/brti exige conexión (connected:false sin ella)', routes.includes("connected: false, source: 'coinbase'"));
check('brti.js no tiene llamadas de escritura a Kalshi (ni /orders, ni POST, ni kalshiGet)', !src('server/brti.js').includes('/orders') && !src('server/brti.js').includes("method: 'POST'") && !src('server/brti.js').includes('kalshiGet('));
check('brti.js se suscribe a cfbenchmarks_value con BRTI', src('server/brti.js').includes('cfbenchmarks_value') && src('server/brti.js').includes("index_ids: [BRTI_INDEX_ID]"));
const app = frontendSrc();
check('App.jsx sondea /api/kalshi/brti cada 2 s (v15)', app.includes("apiAuth('/api/kalshi/brti')") && app.includes('2000'));
check('App.jsx muestra "BRTI ahora" (v15)', app.includes('BRTI ahora'));
check('App.jsx muestra aviso de fallback a Coinbase si no hay BRTI (v15: Sin valor en vivo de Kalshi)', app.includes('Sin valor en vivo de Kalshi') && app.includes('Precio de Coinbase ahora:'));
check('App.jsx usa brtiPositionOutcome (promedio 60 s) para GANANDO/PERDIENDO (v15)', app.includes('brtiPositionOutcome'));
check('kalshi.js documenta que Pyth NO liquida KXBTC15M', src('client/src/kalshi.js').includes('Pyth NO liquida'));
check('VERSION.txt dice v15', src('VERSION.txt').startsWith('v15'));
check('README menciona v13.5 y BRTI', src('README.md').includes('v13.5') && src('README.md').includes('BRTI'));

// --- 6. Bundle compilado ---
let bundleOk = false;
try {
  const files = readdirSync('client/dist/assets').filter((f) => f.endsWith('.js'));
  bundleOk = files.some((f) => readFileSync(`client/dist/assets/${f}`, 'utf8').includes('BRTI ahora'));
} catch { bundleOk = false; }
check('bundle compilado contiene "BRTI ahora" (v15)', bundleOk);

console.log(`\ntests-v13.5: ${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
