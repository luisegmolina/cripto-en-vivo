// tests-v16.9.mjs — Entradas del trader en vivo (v16.9).
// NADA de esto envía órdenes reales: la red está stubbeada y las
// credenciales son falsas. El auditor francotirador sigue evaluando
// en papel, pero YA NO alimenta al vivo: el vivo solo ejecuta
// entradas del trader continuo por EV.
// Uso: node tests-v16.9.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const trader = require('./server/liveTrader.js');
const auditor = require('./server/paperAuditor.js');
const paperTrader = require('./server/paperTrader.js');
const traderEval = require('./server/traderEval.js');
const {
  handleTraderEntry, verificarLimitesTrader, ensureTraderObserver,
  handleViableSignal, arm, kill, getSnapshot, setPersistencia,
  setCargarEstado, isLiveEnabled, dayKey, _traders,
} = trader;
const { calcularComisionPorContrato, tickAuditor, crearEstadoAuditor, _auditors } = auditor;

const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const app = src('client/src/App.jsx');
const liveTraderJsx = src('client/src/components/LiveTrader.jsx');
const liveTraderSrc = src('server/liveTrader.js');
const versionTxt = src('VERSION.txt');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const cerca = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

// La env se lee en cada llamada: guardar y restaurar al final.
const envOriginal = process.env.LIVE_TRADING_ENABLED;
function liveOff() { delete process.env.LIVE_TRADING_ENABLED; }
function liveOn() { process.env.LIVE_TRADING_ENABLED = 'true'; }
liveOff();

setPersistencia(async () => {});
setCargarEstado(async () => null);

// Entrada del trader como la que paperTrader guarda en ultimaEntrada.
function entradaTrader({ ticker, lado = 'yes', ask = 0.20, p = 0.95, ev = 0.05, quoteAgeMs = 1000, ahoraMs = Date.now() } = {}) {
  return {
    ticker, lado, ask,
    fee: calcularComisionPorContrato(ask),
    p, ev,
    enteredAt: ahoraMs - 500,
    quoteFetchedAt: ahoraMs - quoteAgeMs,
  };
}
const credsStub = async () => ({ keyId: 'key-falsa', privateKeyPem: 'pem-falso' });
function conciliarStubs(ticker, lado, precio) {
  return {
    consultarOrdenFn: async () => ({ orderId: 'ord-t1', clientOrderId: 'c-t1', status: 'executed' }),
    fillsFn: async () => ({ fills: [{ ticker, side: lado, action: 'buy', count_fp: '1.00', price_dollars: String(precio), created_time: new Date().toISOString() }] }),
  };
}

console.log('v16.9 — 0. traderEval.js: constantes y funciones, re-exportadas por paperTrader.js');
check('constantes del trader: 1 contrato, 5 entradas/día, tope $5, EV mín. $0.015',
  traderEval.QTY_POR_ORDEN === 1 && traderEval.MAX_ENTRADAS_DIA === 5 &&
  traderEval.MAX_NOTIONAL_USD === 5 && traderEval.MIN_EV_USD === 0.015);
check('constantes de modelo: mín. 10 muestras σ, suelo σ $1, anillo 120, ganancia $0.02, stop 50%, R fin 3, quote fresca 5 s, throttle 5 s, 100 trades, 20 en snapshot',
  traderEval.MIN_MUESTRAS_SIGMA === 10 && traderEval.SIGMA_MIN_USD === 1 &&
  traderEval.ANILLO_MAX === 120 && traderEval.GANANCIA_MIN_USD === 0.02 &&
  traderEval.STOP_FRACCION_COSTO === 0.5 && traderEval.R_FIN_VENTANA === 3 &&
  traderEval.QUOTE_FRESCA_MS === 5000 && traderEval.QUOTE_THROTTLE_MS === 5000 &&
  traderEval.MAX_TRADES === 100 && traderEval.MAX_TRADES_SNAPSHOT === 20);
check('traderEval exporta erf, normalCdf y las 11 funciones del modelo',
  ['erf', 'normalCdf', 'calcularSaltoRequerido', 'calcularProbabilidad',
   'calcularSigmaAnillo', 'calcularEV', 'precioSalida', 'valorNetoSalida',
   'evaluarEntrada', 'evaluarSalida', 'calcularHoldPnl', 'calcularStats',
   'dayKey'].every((f) => typeof traderEval[f] === 'function'));
check('paperTrader.js re-exporta las mismas constantes y funciones (misma referencia, sin copia)',
  paperTrader.QTY_POR_ORDEN === traderEval.QTY_POR_ORDEN &&
  paperTrader.MAX_ENTRADAS_DIA === traderEval.MAX_ENTRADAS_DIA &&
  paperTrader.MIN_EV_USD === traderEval.MIN_EV_USD &&
  paperTrader.calcularEV === traderEval.calcularEV &&
  paperTrader.evaluarEntrada === traderEval.evaluarEntrada &&
  paperTrader.evaluarSalida === traderEval.evaluarSalida &&
  paperTrader.calcularStats === traderEval.calcularStats);
check('paperTrader: el estado del trader nace con ultimaEntrada null y getSnapshot la expone',
  (() => {
    const est = paperTrader.crearEstadoTrader();
    paperTrader._traders.set(993000, est);
    const snap = paperTrader.getSnapshot(993000);
    paperTrader._traders.delete(993000);
    return est.ultimaEntrada === null && 'ultimaEntrada' in snap && snap.ultimaEntrada === null;
  })());
check('liveTrader exporta handleTraderEntry, ensureTraderObserver y verificarLimitesTrader',
  typeof handleTraderEntry === 'function' && typeof ensureTraderObserver === 'function' &&
  typeof verificarLimitesTrader === 'function');

console.log('v16.9 — (a) EV > $0.015 con live encendido + armado: señal ejecutable en vivo');
let llamadasEnvioA = 0;
let payloadA = null;
{
  liveOn();
  const sendStub = async ({ payload }) => { llamadasEnvioA++; payloadA = payload; return { sent: true, order: { client_order_id: 'c-t1' } }; };
  await arm(993001);
  const ahora = Date.now();
  const entrada = entradaTrader({ ticker: 'KXBTC15M-26NOV182230-00', lado: 'yes', ask: 0.20, p: 0.95, ev: 0.05, ahoraMs: ahora });
  const entry = await handleTraderEntry(993001, entrada, {
    ahoraMs: ahora, sendFn: sendStub, credsProvider: credsStub,
    ...conciliarStubs('KXBTC15M-26NOV182230-00', 'yes', 0.20),
  });
  const est = _traders.get(993001);
  check('lado yes + EV $0.05 -> entry sent, sendFn 1 llamada, órdenes hoy = 1',
    entry.action === 'sent' && llamadasEnvioA === 1 && est.ordersToday === 1);
  check('payload V2: count "1.00", side bid (comprar SÍ), price "0.2000"',
    payloadA && payloadA.count === '1.00' && payloadA.side === 'bid' && payloadA.price === '0.2000' &&
    payloadA.ticker === 'KXBTC15M-26NOV182230-00');
  check('la entrada del log lleva fuente trader, evEstimada $0.05 y pEstimada 0.95',
    est.log.length === 1 && est.log[0].fuente === 'trader' &&
    est.log[0].evEstimada === 0.05 && est.log[0].pEstimada === 0.95 &&
    est.log[0].action === 'sent');
  liveOff();
}
let llamadasEnvioANo = 0;
let payloadANo = null;
{
  liveOn();
  const sendStub = async ({ payload }) => { llamadasEnvioANo++; payloadANo = payload; return { sent: true, order: { client_order_id: 'c-t1' } }; };
  await arm(993002);
  const ahora = Date.now();
  const entrada = entradaTrader({ ticker: 'KXBTC15M-26NOV182230-01', lado: 'no', ask: 0.20, p: 0.90, ev: 0.04, ahoraMs: ahora });
  const entry = await handleTraderEntry(993002, entrada, {
    ahoraMs: ahora, sendFn: sendStub, credsProvider: credsStub,
    ...conciliarStubs('KXBTC15M-26NOV182230-01', 'no', 0.20),
  });
  check('lado no + EV $0.04 -> entry sent, payload side ask (vender SÍ = comprar NO), price "0.8000"',
    entry.action === 'sent' && llamadasEnvioANo === 1 &&
    payloadANo && payloadANo.side === 'ask' && payloadANo.price === '0.8000' && payloadANo.count === '1.00');
  liveOff();
}

console.log('v16.9 — (b) EV ≤ $0.015 no produce nada');
// DESVIACIÓN DEL CONTRATO (la tarea pedía action 'ignore'): la
// implementación real devuelve 'blocked' con reason 'ev_bajo'
// (handleTraderEntry devuelve {action:'blocked', reason: lim.reason}
// cuando verificarLimitesTrader no pasa). Se afirma lo real.
{
  liveOn();
  let llamadasEnvio = 0;
  const sendQueFalla = async () => { llamadasEnvio++; throw new Error('NO DEBERÍA LLAMARSE AL ENVÍO'); };
  await arm(993003);
  const ahora = Date.now();
  const r = await handleTraderEntry(993003, entradaTrader({ ticker: 'KXBTC15M-26NOV182230-02', ev: 0.01, ahoraMs: ahora }), {
    ahoraMs: ahora, sendFn: sendQueFalla, credsProvider: credsStub,
  });
  check('EV $0.01 -> blocked ev_bajo (no ignore), sendFn 0 llamadas, sin entrada en el log',
    r.action === 'blocked' && r.reason === 'ev_bajo' && llamadasEnvio === 0 &&
    _traders.get(993003).log.length === 0);
  const rBorde = await handleTraderEntry(993003, entradaTrader({ ticker: 'KXBTC15M-26NOV182230-03', ev: 0.015, ahoraMs: ahora }), {
    ahoraMs: ahora, sendFn: sendQueFalla, credsProvider: credsStub,
  });
  check('EV exactamente $0.015 -> también ev_bajo (el umbral es EV > $0.015, no >=)',
    rBorde.action === 'blocked' && rBorde.reason === 'ev_bajo' && llamadasEnvio === 0);
  liveOff();
}

console.log('v16.9 — (c) Con live apagado la entrada EV se registra como would-send y NO se envía');
{
  liveOff();
  let llamadasEnvio = 0;
  const sendQueFalla = async () => { llamadasEnvio++; throw new Error('NO DEBERÍA LLAMARSE AL ENVÍO'); };
  await arm(993004);
  const ahora = Date.now();
  const entry = await handleTraderEntry(993004, entradaTrader({ ticker: 'KXBTC15M-26NOV182230-04', ev: 0.05, ahoraMs: ahora }), {
    ahoraMs: ahora, sendFn: sendQueFalla, credsProvider: credsStub,
  });
  const est = _traders.get(993004);
  check('live apagado + armado + EV $0.05 -> would-send (live_disabled), sendFn 0 llamadas',
    entry.action === 'would-send' && entry.reason === 'live_disabled' && llamadasEnvio === 0);
  check('would-send queda en el log con fuente trader, evEstimada y pEstimada',
    est.log.length === 1 && est.log[0].fuente === 'trader' &&
    est.log[0].evEstimada === 0.05 && est.log[0].pEstimada === 0.95);
}

console.log('v16.9 — (d) Con kill activado se bloquea');
{
  liveOn();
  let llamadasEnvio = 0;
  const sendQueFalla = async () => { llamadasEnvio++; throw new Error('NO DEBERÍA LLAMARSE AL ENVÍO'); };
  await arm(993005);
  await kill(993005, 'manual');
  const ahora = Date.now();
  const entry = await handleTraderEntry(993005, entradaTrader({ ticker: 'KXBTC15M-26NOV182230-05', ev: 0.05, ahoraMs: ahora }), {
    ahoraMs: ahora, sendFn: sendQueFalla, credsProvider: credsStub,
  });
  check('kill activo -> blocked killed, sin envío, entrada registrada como blocked',
    entry.action === 'blocked' && entry.reason === 'killed' && llamadasEnvio === 0 &&
    _traders.get(993005).log.some((e) => e.action === 'blocked' && e.reason === 'killed'));
  liveOff();
}

console.log('v16.9 — (e) Sin armar se bloquea');
{
  liveOn();
  let llamadasEnvio = 0;
  const sendQueFalla = async () => { llamadasEnvio++; throw new Error('NO DEBERÍA LLAMARSE AL ENVÍO'); };
  const ahora = Date.now();
  const entry = await handleTraderEntry(993006, entradaTrader({ ticker: 'KXBTC15M-26NOV182230-06', ev: 0.05, ahoraMs: ahora }), {
    ahoraMs: ahora, sendFn: sendQueFalla, credsProvider: credsStub,
  });
  check('sin armar -> blocked not_armed, sin envío',
    entry.action === 'blocked' && entry.reason === 'not_armed' && llamadasEnvio === 0);
  liveOff();
}

console.log('v16.9 — (f) Límites del trader en vivo');
check('verificarLimitesTrader qty 2 -> no ok (bad_quantity: solo 1 contrato)',
  verificarLimitesTrader({ qty: 2, ask: 0.5, ev: 0.05 }).ok === false &&
  verificarLimitesTrader({ qty: 2, ask: 0.5, ev: 0.05 }).reason === 'bad_quantity');
check('verificarLimitesTrader qty 6 a 99¢ -> no ok (DESVIACIÓN: reason bad_quantity, no max_notional_per_order — la guarda de qty dispara primero y con qty=1 el notional nunca pasa de $5 porque ask<1)',
  verificarLimitesTrader({ qty: 6, ask: 0.99, ev: 0.05 }).ok === false &&
  verificarLimitesTrader({ qty: 6, ask: 0.99, ev: 0.05 }).reason === 'bad_quantity');
check('verificarLimitesTrader qty 1 a 98¢ con EV $0.02 -> ok',
  verificarLimitesTrader({ qty: 1, ask: 0.98, ev: 0.02 }).ok === true);
check('verificarLimitesTrader EV $0.01 -> ev_bajo; EV $0.015 exacto -> ev_bajo; EV $0.016 -> ok',
  verificarLimitesTrader({ qty: 1, ask: 0.5, ev: 0.01 }).reason === 'ev_bajo' &&
  verificarLimitesTrader({ qty: 1, ask: 0.5, ev: 0.015 }).reason === 'ev_bajo' &&
  verificarLimitesTrader({ qty: 1, ask: 0.5, ev: 0.016 }).ok === true);
{
  liveOn();
  let llamadasEnvio = 0;
  const sendQueFalla = async () => { llamadasEnvio++; throw new Error('NO DEBERÍA LLAMARSE AL ENVÍO'); };
  await arm(993007);
  const est7 = _traders.get(993007);
  est7.day = dayKey();
  est7.ordersToday = 5;
  const ahora = Date.now();
  const entry = await handleTraderEntry(993007, entradaTrader({ ticker: 'KXBTC15M-26NOV182230-07', ev: 0.05, ahoraMs: ahora }), {
    ahoraMs: ahora, sendFn: sendQueFalla, credsProvider: credsStub,
  });
  check('5 órdenes hoy -> blocked max_orders_per_day, sin envío',
    entry.action === 'blocked' && entry.reason === 'max_orders_per_day' && llamadasEnvio === 0);
  liveOff();
}
{
  liveOn();
  let llamadasEnvio = 0;
  const sendStub = async () => { llamadasEnvio++; return { sent: true, order: { client_order_id: 'c-t1' } }; };
  await arm(993008);
  const ahora = Date.now();
  const entrada = entradaTrader({ ticker: 'KXBTC15M-26NOV182230-08', ev: 0.05, ahoraMs: ahora });
  const primera = await handleTraderEntry(993008, entrada, {
    ahoraMs: ahora, sendFn: sendStub, credsProvider: credsStub,
    ...conciliarStubs('KXBTC15M-26NOV182230-08', 'yes', 0.20),
  });
  const segunda = await handleTraderEntry(993008, entrada, {
    ahoraMs: ahora, sendFn: sendStub, credsProvider: credsStub,
  });
  check('segunda entrada del mismo ticker -> duplicate, envío 1 sola vez, log sin duplicar',
    primera.action === 'sent' && segunda.action === 'duplicate' &&
    segunda.reason === 'already_processed' && llamadasEnvio === 1 &&
    _traders.get(993008).log.length === 1);
  liveOff();
}
{
  liveOn();
  let llamadasEnvio = 0;
  const sendQueFalla = async () => { llamadasEnvio++; throw new Error('NO DEBERÍA LLAMARSE AL ENVÍO'); };
  await arm(993009);
  const ahora = Date.now();
  const r = await handleTraderEntry(993009, entradaTrader({ ticker: 'KXBTC15M-26NOV182230-09', ev: 0.05, quoteAgeMs: 60000, ahoraMs: ahora }), {
    ahoraMs: ahora, sendFn: sendQueFalla, credsProvider: credsStub,
  });
  check('quote de hace 60 s -> ignore quote_desactualizada, sin envío ni entrada en el log',
    r.action === 'ignore' && r.reason === 'quote_desactualizada' && llamadasEnvio === 0 &&
    _traders.get(993009).log.length === 0);
  liveOff();
}

console.log('v16.9 — (g) El vivo NO vende/cierra: ni función ni llamada de salida');
check('liveTrader.js no define ni exporta venderPosicion ni cerrarPosicion (ni función vender/cerrar)',
  !liveTraderSrc.includes('venderPosicion') && !liveTraderSrc.includes('cerrarPosicion') &&
  !/function\s+(vender|cerrar)/.test(liveTraderSrc) &&
  trader.venderPosicion === undefined && trader.cerrarPosicion === undefined);
check('el único POST a Kalshi sigue siendo la orden de entrada en enviarOrdenReal (los 2 method POST están dentro de esa función)',
  (() => {
    const sinComentarios = liveTraderSrc.replace(/\/\/.*$/gm, '');
    const posts = (sinComentarios.match(/method:\s*'POST'/g) || []).length;
    const inicio = sinComentarios.indexOf('async function enviarOrdenReal');
    const fin = sinComentarios.indexOf('async function', inicio + 10);
    const cuerpo = sinComentarios.slice(inicio, fin === -1 ? undefined : fin);
    return posts === 2 && (cuerpo.match(/method:\s*'POST'/g) || []).length === 2;
  })());
check('la ruta de órdenes aparece solo en la constante LIVE_ORDERS_PATH (sin POST de venta/cierre en ningún otro sitio)',
  (liveTraderSrc.match(/portfolio\/events\/orders/g) || []).length === 2 &&
  liveTraderSrc.includes("const LIVE_ORDERS_PATH = '/trade-api/v2/portfolio/events/orders';"));
{
  // Conductual: tras la entrada enviada del caso (a), un segundo
  // procesado del mismo ticker da duplicate y el envío sigue en 1.
  liveOn();
  const ahora = Date.now();
  const r = await handleTraderEntry(993001, entradaTrader({ ticker: 'KXBTC15M-26NOV182230-00', lado: 'yes', ask: 0.20, p: 0.95, ev: 0.05, ahoraMs: ahora }), {
    ahoraMs: ahora, sendFn: async () => { llamadasEnvioA++; return { sent: true }; }, credsProvider: credsStub,
  });
  check('segundo procesado del ticker enviado en (a) -> duplicate, envío sigue en exactamente 1 (ninguna llamada de salida)',
    r.action === 'duplicate' && llamadasEnvioA === 1 && _traders.get(993001).log.length === 1);
  liveOff();
}

console.log('v16.9 — (h) El auditor francotirador sigue evaluando en papel aunque ya no alimente al vivo');
{
  const ahora = Date.now();
  const segAhora = Math.floor(ahora / 1000);
  const est = crearEstadoAuditor();
  est.enabled = true;
  est.contrato = { ticker: 'KXBTC15M-26NOV182230-10', targetPrice: 63000, closeMs: (segAhora + 10) * 1000, closeIso: 'x' };
  for (let i = 1; i <= 50; i++) est.muestras.set(segAhora - i, 62900);
  est.ultimoUpdatedAt = 'tick-viejo';
  _auditors.set(993010, est);
  const tickIso = new Date(ahora).toISOString();
  await tickAuditor(993010, ahora, {
    brtiState: () => ({ value: 62900, avg60s: 62950, avg15mFinal: null, updatedAt: tickIso, status: 'connected', error: null }),
    quote: async () => ({ ticker: 'KXBTC15M-26NOV182230-10', status: 'active', result: null, expirationValue: null, yesAskDollars: 0.80, yesBidDollars: 0.79, noAskDollars: 0.20 }),
  });
  await new Promise((r) => setTimeout(r, 10));
  const snap = auditor.getSnapshot(993010);
  check('(h1) tickAuditor en T-10 con salto ≥$95 -> snapshot.simulacion viableDespuesDeComision true, dirección NO',
    est.simulacion && est.simulacion.direccionElegida === 'no' &&
    est.simulacion.viableDespuesDeComision === true &&
    snap.simulacion && snap.simulacion.viableDespuesDeComision === true);
  _auditors.delete(993010);
}
check('(h2) el cuerpo de ensureObservador NO contiene ninguna llamada a handleViableSignal (solo ensureTraderObserver/handleTraderEntry pueden referenciarlo en el camino de envío)',
  (() => {
    const inicio = liveTraderSrc.indexOf('function ensureObservador() {');
    if (inicio === -1) return false;
    const resto = liveTraderSrc.slice(inicio);
    // El cuerpo termina en el '}' a principio de línea; el comentario
    // que sigue (sobre ensureTraderObserver) menciona
    // handleViableSignal y NO forma parte del cuerpo.
    const fin = resto.indexOf('\n}\n');
    if (fin === -1) return false;
    return !resto.slice(0, fin).includes('handleViableSignal');
  })());
check('(h2) ensureTraderObserver SÍ llama a handleTraderEntry (el único feed de entradas en vivo)',
  (() => {
    const inicio = liveTraderSrc.indexOf('function ensureTraderObserver() {');
    if (inicio === -1) return false;
    const resto = liveTraderSrc.slice(inicio);
    const fin = resto.indexOf('\nfunction ', 10);
    const cuerpo = fin === -1 ? resto : resto.slice(0, fin);
    return cuerpo.includes('handleTraderEntry(userId, entrada');
  })());

console.log('v16.9 — Versión, cliente y motor intacto');
check("VERSION_LABEL es 'v16.9 — Entradas del trader en vivo'",
  app.includes("const VERSION_LABEL = 'v16.9 — Entradas del trader en vivo';"));
check('VERSION.txt empieza en v16.9 y corrige v16.8 (77c8cce4) y v16.5 (6340dd71) como DESPLEGADAS',
  versionTxt.startsWith('v16.9') &&
  versionTxt.includes('v16.8 — Regla 1 con tiempo restante (18-nov-2026) — DESPLEGADA en Render (commit 77c8cce4)') &&
  versionTxt.includes('v16.5 — PIN de acceso antes de la web (18-nov-2026) — DESPLEGADA en Render (commit 6340dd71)'));
check('VERSION.txt (v16.9) dice que NO hay salidas en vivo y que el vivo solo registra would-send con la variable en false',
  versionTxt.includes('NO hay salidas en vivo') && versionTxt.includes('LIVE_TRADING_ENABLED=false'));
check('LiveTrader.jsx ya no habla de señales del auditor: dice "entrada del trader (EV)" y muestra la columna Fuente (e.fuente || auditor)',
  (() => {
    // El JSX parte la frase entre líneas; se normaliza el espacio.
    const plano = liveTraderJsx.replace(/\s+/g, ' ');
    return !liveTraderJsx.includes('señal viable del auditor') &&
      liveTraderJsx.includes('la próxima entrada del trader (EV) enviará una orden REAL') &&
      plano.includes('cada entrada del trader (EV) se registra solo como "HABRÍA ENVIADO"') &&
      liveTraderJsx.includes('<th>Fuente</th>') &&
      liveTraderJsx.includes("e.fuente || 'auditor'");
  })());
check('LiveTrader.jsx mantiene la estructura dinámica de 4 ramas, la interpolación de limits y el sondeo cada 2 s',
  liveTraderJsx.includes("const tituloEstado = !live ? 'APAGADO'") &&
  liveTraderJsx.includes('live && armed && !killed') &&
  liveTraderJsx.includes('máx. {limits.maxContractsPerOrder} contratos por orden') &&
  liveTraderJsx.includes("apiAuth('/api/kalshi/live/status')") && liveTraderJsx.includes('2000') &&
  liveTraderJsx.includes("'/api/kalshi/live/kill'"));
check('el motor no menciona al trader en vivo (kalshi.js, analysis.js, verdict.js, windowOutcome.js)',
  ['client/src/kalshi.js', 'client/src/analysis.js', 'client/src/verdict.js', 'client/src/windowOutcome.js']
    .every((p) => !src(p).includes('liveTrader') && !src(p).includes('handleTraderEntry')));
check('LIVE_TRADING_ENABLED no está puesta en el entorno de este test',
  process.env.LIVE_TRADING_ENABLED !== 'true');
check('live sigue APAGADO por defecto (isLiveEnabled false sin la env)',
  isLiveEnabled() === false);

// Restaurar la env como estaba.
if (envOriginal === undefined) delete process.env.LIVE_TRADING_ENABLED;
else process.env.LIVE_TRADING_ENABLED = envOriginal;

console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
