// Pruebas v13 — pestañas + fallos del video del 12-nov.
// Se corre con el servidor local ya arrancado en :3001.
// Uso: node tests-v13.mjs
// Comprueba: pestaña por defecto Kalshi, gráfico que se recrea al
// entrar en su pestaña, alertas de veredicto sin duplicar en el mismo
// minuto, posiciones Kalshi con cantidad 0 explicadas (no 0¢), señal
// 15m fallando -> confianza bajada, y que nada de v7-v12 se rompió.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { window15m, recentWinRate, adjustProbForRecent, cashOutDecision } from './client/src/kalshi.js';
import { shouldSignalAlert, dedupePriceAlerts } from './client/src/alerts.js';

const require = createRequire(import.meta.url);
const { describePosition } = require('./server/kalshiServer.js');

const BASE = 'http://localhost:3001';
let pass = 0;
function ok(name, cond) { assert.ok(cond, name); pass++; console.log(`  ✓ ${name}`); }
async function j(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

const appSrc = readFileSync('./client/src/App.jsx', 'utf8');
const kcSrc = readFileSync('./client/src/KalshiConnect.jsx', 'utf8');
const cssSrc = readFileSync('./client/src/index.css', 'utf8');

// 1. Pestañas: Kalshi por defecto, lo demás aparte, sin ruido.
console.log('— pestañas —');
ok('pestaña por defecto es kalshi', appSrc.includes("useState('kalshi')"));
ok('hay 6 pestañas (kalshi, mercados, grafico, cartera, liga, admin) — v13.3 quitó "cuenta"', ['kalshi', 'mercados', 'grafico', 'cartera', 'liga'].every((t) => appSrc.includes(`id: '${t}'`)) && appSrc.includes('Admin') && !appSrc.includes("id: 'cuenta'"));
ok('sin resto de depuración "(admin /admin)"', !appSrc.includes('(admin /admin)'));
ok('sin interruptor ni estado kalshiMode', !appSrc.includes('kalshiMode'));
ok('ticker tape oculto en la pestaña Kalshi', appSrc.includes("activeTab !== 'kalshi'"));
ok('CSS de pestañas presente', cssSrc.includes('.app-tabs'));
ok('sección Kalshi solo en su pestaña', appSrc.includes("{activeTab === 'kalshi' && ("));
ok('Mi cuenta Kalshi vive DENTRO de la pestaña Kalshi, no aparte (v13.3)', !appSrc.includes("{activeTab === 'cuenta' && (") && kcSrc.includes('Mi cuenta</h3>'));

// 2. Gráfico: se crea al entrar en la pestaña y repinta.
console.log('— gráfico —');
ok('creación del gráfico depende de la pestaña activa', appSrc.includes("if (activeTab !== 'grafico') return undefined;"));
ok('ResizeObserver para el ancho del gráfico', appSrc.includes('ResizeObserver'));
ok('chartReady obliga a repintar al crear el gráfico', appSrc.includes('chartReady'));
ok('al cambiar de intervalo se vacían las velas', appSrc.includes('setCandles([]);'));
ok('mensaje "Cargando velas…" si no hay velas', appSrc.includes('Cargando velas…'));

// 3. Alertas de veredicto: una por minuto, la última reemplaza.
console.log('— alertas de veredicto —');
ok('primera alerta dispara', shouldSignalAlert(null, 1000).fire === true);
ok('segunda en el mismo minuto no dispara y reemplaza', (() => { const r = shouldSignalAlert({ at: 1000, key: 'sell' }, 30000); return r.fire === false && r.replace === true; })());
ok('tras 60 s vuelve a disparar', shouldSignalAlert({ at: 1000, key: 'sell' }, 61001).fire === true);
ok('App usa shouldSignalAlert y reemplaza la anterior', appSrc.includes('shouldSignalAlert(lastSignalAlertRef.current') && appSrc.includes('copy[idx] = msg'));

// 4. Posiciones Kalshi con cantidad 0 / sin precio: explicadas, no 0¢.
console.log('— posiciones Kalshi —');
ok('cantidad 0 se explica como cerrada', describePosition({ count: 0, avgPrice: null, currentPrice: null }).includes('cerrada'));
ok('sin precio medio se explica', describePosition({ count: 1, avgPrice: null, currentPrice: 50 }).includes('Sin precio medio'));
ok('sin precio actual se explica', describePosition({ count: 1, avgPrice: 40, currentPrice: null }).includes('Sin precio actual'));
ok('posición sana no lleva nota', describePosition({ count: 2, avgPrice: 40, currentPrice: 55 }) === null);
ok('KalshiConnect no convierte null en 0 (numOrNull)', kcSrc.includes('numOrNull') && !kcSrc.includes('const avg = Number(pos.avgPrice)'));
ok('KalshiConnect muestra la nota de la posición', kcSrc.includes('pos.note'));
ok('KalshiConnect completo (no compacto) dentro de la pestaña Kalshi (v13.3)', !kcSrc.includes('compact') && appSrc.includes('<KalshiConnect token='));

// 5. Señal 15m fallando: aviso + confianza bajada.
console.log('— señal 15m fallando —');
const histFail = [{ won: false }, { won: false }, { won: true }, { won: false }, { won: false }];
ok('rendimiento reciente 1 de 5', recentWinRate(histFail).rate === 0.2);
ok('confianza baja a tope 60 cuando falla <50%', adjustProbForRecent(80, histFail) === 60);
ok('confianza intacta cuando acierta >=50%', adjustProbForRecent(80, [{ won: true }, { won: true }, { won: false }]) === 80);
ok('App muestra el aviso de 15m fallando', appSrc.includes('Está fallando últimamente'));
ok('App usa la probabilidad ajustada', appSrc.includes('kalshiProbAdj'));

// 6. Ventana 15m y decisión cobrar/salir siguen funcionando.
console.log('— modo Kalshi 15 min —');
const w = window15m(new Date('2026-11-12T19:47:30').getTime());
ok('ventana 15m correcta', w.remainingMs > 0 && w.remainingMs <= 15 * 60 * 1000);
const d = cashOutDecision({ dir: 'up', entryPrice: 100, currentPrice: 110, amount: 100, signalKey: 'down', signalScore: -40, entryScore: 30 });
ok('ganando y señal girada -> COBRA AHORA', d.key === 'cash');

// 7. Servidor local con datos reales (nada de v7-v12 se rompió).
console.log('— salud y precios —');
let r = await j('GET', '/api/health');
ok('health OK', r.status === 200 && r.data.ok === true);
r = await j('GET', '/api/ticker?symbol=BTC&currency=USD');
ok('ticker BTC real > 0', r.status === 200 && r.data.price > 0);
console.log(`  (BTC $${r.data.price} vía ${r.data.source})`);
r = await j('GET', '/api/candles?symbol=BTC&currency=USD&interval=15m');
ok('velas 15m reales', r.status === 200 && Array.isArray(r.data.candles) && r.data.candles.length > 10);
r = await j('GET', '/api/candles?symbol=BTC&currency=USD&interval=1h');
ok('velas 1h reales', r.status === 200 && Array.isArray(r.data.candles) && r.data.candles.length > 10);
r = await j('GET', '/api/auth/me');
ok('me sin token 401', r.status === 401);

console.log(`\ntests-v13: ${pass} pasaron`);
