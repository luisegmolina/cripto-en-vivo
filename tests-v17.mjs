// tests-v17.mjs — Papel sin límites, sombra libre (v17).
// NADA de esto envía órdenes reales: la red está stubbeada y las
// credenciales son falsas. Live sigue APAGADO por defecto; el kill
// solo se quita con unkill(), y ningún test arma live en Render ni
// toca LIVE_TRADING_ENABLED fuera de este proceso.
// Uso: node tests-v17.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const trader = require('./server/liveTrader.js');
const paperTrader = require('./server/paperTrader.js');
const traderEval = require('./server/traderEval.js');
const {
  handleTraderEntry, verificarLimitesTrader, ensureTraderObserver,
  handleViableSignal, arm, kill, unkill, getSnapshot, setPersistencia,
  setCargarEstado, isLiveEnabled, dayKey, _traders,
} = trader;
const { calcularComisionPorContrato } = require('./server/paperAuditor.js');

const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const sinComentarios = (s) => s.replace(/\/\/.*$/gm, '');
const app = src('client/src/App.jsx');
const paperTraderJsx = src('client/src/components/PaperTrader.jsx');
const liveTraderJsx = src('client/src/components/LiveTrader.jsx');
const liveTraderSrc = src('server/liveTrader.js');
const paperTraderSrc = src('server/paperTrader.js');
const traderEvalSrc = src('server/traderEval.js');
const routesSrc = src('server/routes.js');
const versionTxt = src('VERSION.txt');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const approx = (a, b, tol) => Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// La env se lee en cada llamada: guardar y restaurar al final.
const envOriginal = process.env.LIVE_TRADING_ENABLED;
function liveOff() { delete process.env.LIVE_TRADING_ENABLED; }
function liveOn() { process.env.LIVE_TRADING_ENABLED = 'true'; }
liveOff();

const persistCalls = [];
setPersistencia(async (uid, estado) => {
  persistCalls.push({ uid, estado: JSON.parse(JSON.stringify(estado)) });
});
setCargarEstado(async () => null);

// Entrada del trader como la que paperTrader guarda en ultimaEntrada
// (v17: con `id` único por entrada).
function entradaTrader({ ticker, lado = 'yes', ask = 0.20, p = 0.95, ev = 0.05, id = null, quoteAgeMs = 1000, ahoraMs = Date.now() } = {}) {
  return {
    id, ticker, lado, ask,
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

// --- Ayudas de tick (patrón tests-v16.10.mjs §3) ---
const ANILLO_SEED = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 100400 : 100600));
const { crearEstadoTrader, tickTrader, getSnapshot: getSnapPaper, _traders: _paperTraders } = paperTrader;
const limpiarPapel = (uid) => { _paperTraders.delete(uid); };
async function escenario(u, { closeSegs, precio = 100500, ask = 0.80, bid = 0.82, noAsk = 0.20, anillo = ANILLO_SEED } = {}) {
  const base = (Math.floor(Date.now() / 1000) + 5) * 1000;
  const closeMs = base + closeSegs * 1000;
  const ticker = `KXBTC15M-TEST-V17-${u}`;
  const contrato = { ticker, targetPrice: 100000, closeMs, closeIso: 'x' };
  let relojMs = base;
  let precioActual = precio;
  let bidActual = bid;
  const deps = {
    brtiState: () => ({ value: precioActual, avg60s: null, avg15mFinal: null, updatedAt: new Date(relojMs).toISOString(), status: 'connected', error: null }),
    descubrir: async () => contrato,
    quote: async () => ({ ticker, status: 'active', result: null, expirationValue: null, yesAskDollars: ask, yesBidDollars: bidActual, noAskDollars: noAsk }),
  };
  const est = crearEstadoTrader();
  est.enabled = true;
  _paperTraders.set(u, est);
  await tickTrader(u, relojMs, deps); // t=0: descubrimiento
  if (anillo) est.anillo = [...anillo];
  est.quoteActual = { yesAskDollars: ask, yesBidDollars: bidActual, noAskDollars: noAsk, ticker, fetchedAt: base };
  return {
    deps, contrato, ticker, est, base,
    setPrecio(v) { precioActual = v; },
    setBid(v) { bidActual = v; },
    async tick(t) { relojMs = base + t * 1000; const s = await tickTrader(u, relojMs, deps); await sleep(5); return s; },
    snap: () => getSnapPaper(u),
  };
}

console.log('v17 — 0. Guardas estáticas: el tope diario y sin_reentrada no existen en el código');
check('LIVE_TRADING_ENABLED no está puesta en el entorno de este test',
  process.env.LIVE_TRADING_ENABLED !== 'true');
check('traderEval.js no tiene MAX_ENTRADAS_DIA ni max_entradas_dia en el código (las menciones en comentarios no cuentan)',
  !/\bMAX_ENTRADAS_DIA\b/.test(sinComentarios(traderEvalSrc))
  && !sinComentarios(traderEvalSrc).includes('max_entradas_dia')
  && traderEval.MAX_ENTRADAS_DIA === undefined);
check('paperTrader.js no tiene MAX_ENTRADAS_DIA, sinReentrada ni sin_reentrada en el código',
  !/\bMAX_ENTRADAS_DIA\b/.test(sinComentarios(paperTraderSrc))
  && !sinComentarios(paperTraderSrc).includes('est.sinReentrada')
  && !sinComentarios(paperTraderSrc).includes('sinReentrada[')
  && !sinComentarios(paperTraderSrc).includes("'sin_reentrada'")
  && paperTrader.MAX_ENTRADAS_DIA === undefined);
check('evaluarEntrada ya no acepta el tope: con entradasHoy=100 sigue entrando',
  (() => {
    const q = { yesAskDollars: 0.90, yesBidDollars: 0.89, noAskDollars: 0.10 };
    const r = traderEval.evaluarEntrada({ pYes: 0.99, pNo: 0.01, quote: q, entradasHoy: 100 });
    return r.entrar === true && r.lado === 'yes';
  })());
check('paperTrader.js pone id único en ultimaEntrada (abrirPosicion usa nuevoTradeId)',
  paperTraderSrc.includes('id: nuevoTradeId()'));
check('el estado del trader nace sin sinReentrada y con ultimaEntrada null',
  (() => {
    const est = crearEstadoTrader();
    return !('sinReentrada' in est) && est.ultimaEntrada === null;
  })());

console.log('v17 — (a) Re-entrada permitida tras salida en la misma ventana (nivel tick)');
{
  const u = 994001;
  const sc = await escenario(u, { closeSegs: 601 });
  let snap = await sc.tick(1); // entra SÍ a $0.80 a R=600
  check('(a) entra SÍ a R=600 (entradasHoy=1) y ultimaEntrada lleva id único',
    snap.posicionAbierta && snap.posicionAbierta.lado === 'yes' && snap.entradasHoy === 1
    && snap.ultimaEntrada && typeof snap.ultimaEntrada.id === 'string'
    && snap.ultimaEntrada.id.startsWith('pt-'),
    JSON.stringify(snap.ultimaEntrada));
  const idPrimera = snap.ultimaEntrada.id;
  sc.setBid(0.90); // neto 0.8937 ≥ costo+0.02: ganancia en el próximo tick con quote fresca
  for (let t = 2; t <= 8; t++) snap = await sc.tick(t);
  check('(a) tras la salida por ganancia VUELVE A ENTRAR en la misma ventana: 3 trades, entradasHoy=4, posición abierta',
    snap.trades.length === 3 && snap.entradasHoy === 4 && snap.posicionAbierta !== null
    && snap.posicionAbierta.lado === 'yes'
    && snap.trades.every((t) => t.motivoSalida === 'ganancia'),
    JSON.stringify(snap.stats));
  check('(a) la segunda entrada tiene OTRO id único (no se reutiliza el de la primera)',
    snap.ultimaEntrada && snap.ultimaEntrada.id !== idPrimera
    && typeof snap.ultimaEntrada.id === 'string' && snap.ultimaEntrada.id.startsWith('pt-'),
    JSON.stringify(snap.ultimaEntrada));
  check('(a) 1 posición abierta a la vez: nunca hay 2 posiciones, solo entradas sucesivas',
    snap.trades.length + (snap.posicionAbierta ? 1 : 0) === snap.entradasHoy);
  limpiarPapel(u);
}

console.log('v17 — (b) 6ª entrada el mismo día permitida');
{
  const q = { yesAskDollars: 0.90, yesBidDollars: 0.89, noAskDollars: 0.10 };
  const r5 = traderEval.evaluarEntrada({ pYes: 0.99, pNo: 0.01, quote: q, entradasHoy: 5 });
  check('(b) evaluarEntrada con entradasHoy=5 ENTRA (antes: max_entradas_dia)',
    r5.entrar === true && r5.lado === 'yes' && approx(r5.ev, 0.0837, 1e-4));
  const r100 = traderEval.evaluarEntrada({ pYes: 0.99, pNo: 0.01, quote: q, entradasHoy: 100 });
  check('(b) evaluarEntrada con entradasHoy=100 también ENTRA: no hay tope',
    r100.entrar === true);
  const u = 994002;
  const sc = await escenario(u, { closeSegs: 601 });
  sc.est.entradasHoy = 5;
  const snap = await sc.tick(1);
  check('(b) a nivel tick: con 5 entradas hoy entra igual (entradasHoy=6, posición abierta, motivo entrada)',
    snap.posicionAbierta !== null && snap.entradasHoy === 6
    && snap.evaluaciones.length === 1 && snap.evaluaciones[0].motivo === 'entrada',
    JSON.stringify(snap.evaluaciones[0]));
  check('(b) entradasHoy se SIGUE contando (stats.entradasHoy=6, solo informativo)',
    snap.stats.entradasHoy === 6);
  limpiarPapel(u);
}

console.log('v17 — (c) El observer procesa dos entradas distintas del mismo ticker (dedup por entrada)');
{
  liveOn();
  let llamadasEnvio = 0;
  const sendStub = async ({ payload }) => { llamadasEnvio++; return { sent: true, order: { client_order_id: 'c-t1' } }; };
  const u = 994003;
  await arm(u);
  const ahora = Date.now();
  const ticker = 'KXBTC15M-26NOV182330-01';
  const e1 = entradaTrader({ ticker, id: 'pt-test-e1', ev: 0.05, ahoraMs: ahora });
  const primera = await handleTraderEntry(u, e1, {
    ahoraMs: ahora, sendFn: sendStub, credsProvider: credsStub,
    ...conciliarStubs(ticker, 'yes', 0.20),
  });
  const e2 = entradaTrader({ ticker, id: 'pt-test-e2', ev: 0.05, ahoraMs: ahora });
  const segunda = await handleTraderEntry(u, e2, {
    ahoraMs: ahora, sendFn: sendStub, credsProvider: credsStub,
    ...conciliarStubs(ticker, 'yes', 0.20),
  });
  const est = _traders.get(u);
  check('(c) dos entradas DISTINTAS del mismo ticker (ids distintos) -> dos sent, 2 envíos, 2 entradas en el log',
    primera.action === 'sent' && segunda.action === 'sent' && llamadasEnvio === 2
    && est.log.length === 2,
    `llamadas=${llamadasEnvio} log=${est.log.length}`);
  check('(c) el log guarda el entradaId de cada entrada (e1 y e2)',
    est.log[0].entradaId === 'pt-test-e1' && est.log[1].entradaId === 'pt-test-e2',
    JSON.stringify(est.log.map((e) => e.entradaId)));
  const repetida = await handleTraderEntry(u, e1, {
    ahoraMs: ahora, sendFn: sendStub, credsProvider: credsStub,
  });
  check('(c) la MISMA entrada dos veces (mismo id) -> duplicate, sin segundo envío',
    repetida.action === 'duplicate' && repetida.reason === 'already_processed'
    && llamadasEnvio === 2 && est.log.length === 2);
  liveOff();
}
{
  // Sin id (entradas viejas): mantiene el dedup por ticker.
  liveOn();
  let llamadasEnvio = 0;
  const sendStub = async () => { llamadasEnvio++; return { sent: true, order: { client_order_id: 'c-t1' } }; };
  const u = 994004;
  await arm(u);
  const ahora = Date.now();
  const ticker = 'KXBTC15M-26NOV182330-02';
  const e1 = entradaTrader({ ticker, id: null, ev: 0.05, ahoraMs: ahora });
  const primera = await handleTraderEntry(u, e1, {
    ahoraMs: ahora, sendFn: sendStub, credsProvider: credsStub,
    ...conciliarStubs(ticker, 'yes', 0.20),
  });
  const segunda = await handleTraderEntry(u, e1, {
    ahoraMs: ahora, sendFn: sendStub, credsProvider: credsStub,
  });
  check('(c) sin id, la segunda entrada del mismo ticker sigue siendo duplicate (fallback por ticker)',
    primera.action === 'sent' && segunda.action === 'duplicate' && llamadasEnvio === 1
    && _traders.get(u).log.length === 1);
  liveOff();
}
check('(c) ensureTraderObserver clavea procesando por entrada.id (si hay) y por ticker si no',
  (() => {
    const inicio = liveTraderSrc.indexOf('function ensureTraderObserver() {');
    if (inicio === -1) return false;
    const cuerpo = liveTraderSrc.slice(inicio);
    return cuerpo.includes('entrada.id != null') && cuerpo.includes('`${userId}:${entrada.id}`')
      && cuerpo.includes('`${userId}:${entrada.ticker}`');
  })());
check('(c) handleTraderEntry pasa entrada.id como simulacion.entradaId',
  liveTraderSrc.includes('entradaId: entrada.id != null ? entrada.id : null'));

console.log('v17 — (d) EV bajo sigue bloqueado');
check('(d) verificarLimitesTrader EV $0.01 -> ev_bajo; EV $0.015 exacto -> ev_bajo; EV $0.016 -> ok',
  verificarLimitesTrader({ qty: 1, ask: 0.5, ev: 0.01 }).reason === 'ev_bajo' &&
  verificarLimitesTrader({ qty: 1, ask: 0.5, ev: 0.015 }).reason === 'ev_bajo' &&
  verificarLimitesTrader({ qty: 1, ask: 0.5, ev: 0.016 }).ok === true);
check('(d) evaluarEntrada con EV bajo (p=0.5, ask=0.50) rechaza con ev_bajo',
  (() => {
    const r = traderEval.evaluarEntrada({ pYes: 0.5, pNo: 0.5, quote: { yesAskDollars: 0.5, yesBidDollars: 0.49, noAskDollars: 0.5 }, entradasHoy: 0 });
    return r.entrar === false && r.motivo === 'ev_bajo';
  })());
{
  liveOff();
  let llamadasEnvio = 0;
  const sendQueFalla = async () => { llamadasEnvio++; throw new Error('NO DEBERÍA LLAMARSE AL ENVÍO'); };
  const u = 994005;
  await arm(u);
  const ahora = Date.now();
  const r = await handleTraderEntry(u, entradaTrader({ ticker: 'KXBTC15M-26NOV182330-03', ev: 0.01, ahoraMs: ahora }), {
    ahoraMs: ahora, sendFn: sendQueFalla, credsProvider: credsStub,
  });
  check('(d) entrada con EV $0.01 en vivo -> blocked ev_bajo, sin envío ni entrada en el log',
    r.action === 'blocked' && r.reason === 'ev_bajo' && llamadasEnvio === 0
    && _traders.get(u).log.length === 0);
}

console.log('v17 — (e) qty≠1 y notional >$5 siguen bloqueados');
check('(e) verificarLimitesTrader qty 2 -> bad_quantity; qty 0 -> bad_quantity; qty 1 a 98¢ con EV $0.02 -> ok',
  verificarLimitesTrader({ qty: 2, ask: 0.5, ev: 0.05 }).reason === 'bad_quantity' &&
  verificarLimitesTrader({ qty: 0, ask: 0.5, ev: 0.05 }).reason === 'bad_quantity' &&
  verificarLimitesTrader({ qty: 1, ask: 0.98, ev: 0.02 }).ok === true);
check('(e) evaluarEntrada con tope de notional $0.50 y ask $0.90 rechaza con max_notional',
  (() => {
    const q = { yesAskDollars: 0.90, yesBidDollars: 0.89, noAskDollars: 0.10 };
    const r = traderEval.evaluarEntrada({ pYes: 0.99, pNo: 0.01, quote: q, maxNotionalUsd: 0.5 });
    return r.entrar === false && r.motivo === 'max_notional';
  })());
check('(e) verificarLimitesTrader conserva la guarda de notional (max_notional_per_order) en el código',
  liveTraderSrc.includes('max_notional_per_order'));

console.log('v17 — (f) unkill limpia killed, deja armed=false y persiste');
{
  persistCalls.length = 0;
  const u = 994006;
  const snapKill = await kill(u, 'manual');
  check('(f) kill deja killed=true, armed=false',
    snapKill.killed === true && snapKill.armed === false && snapKill.killReason === 'manual'
    && typeof snapKill.killedAt === 'string');
  const snapUnkill = await unkill(u);
  check('(f) unkill limpia killed/killReason/killedAt y NO toca armed (sigue false)',
    snapUnkill.killed === false && snapUnkill.killReason === null && snapUnkill.killedAt === null
    && snapUnkill.armed === false);
  check('(f) unkill persiste (hook llamado con killed=false)',
    persistCalls.some((c) => c.uid === u && c.estado.killed === false && c.estado.armed === false));
  const est = _traders.get(u);
  check('(f) el estado en memoria queda limpio tras unkill',
    est.killed === false && est.killReason === null && est.killedAt === null && est.armed === false);
}
{
  // unkill con el bot armado: tampoco desarma (armed se conserva).
  const u = 994007;
  await arm(u);
  await kill(u, 'manual'); // kill desarma
  await arm(u); // re-armar a mano (en producción exige la env; aquí es llamada directa)
  const snap = await unkill(u);
  check('(f) unkill sobre un estado armado NO desarma (armed sigue true) y killed queda false',
    snap.armed === true && snap.killed === false);
}
{
  // unkill sin kill previo: no rompe nada.
  const u = 994008;
  const snap = await unkill(u);
  check('(f) unkill sin kill previo devuelve killed=false, armed=false, sin error',
    snap.killed === false && snap.armed === false);
}
{
  // Tras quitar el kill, el espejo vuelve a registrar (live apagado:
  // would-send, no blocked/killed).
  liveOff();
  const u = 994009;
  await kill(u, 'manual');
  const ahora = Date.now();
  const bloqueada = await handleTraderEntry(u, entradaTrader({ ticker: 'KXBTC15M-26NOV182330-04', id: 'pt-test-k1', ahoraMs: ahora }), {
    ahoraMs: ahora, sendFn: async () => { throw new Error('NO DEBERÍA LLAMARSE'); }, credsProvider: credsStub,
  });
  check('(f) con kill activado la entrada se bloquea con killed',
    bloqueada.action === 'blocked' && bloqueada.reason === 'killed');
  await unkill(u);
  const libre = await handleTraderEntry(u, entradaTrader({ ticker: 'KXBTC15M-26NOV182330-04', id: 'pt-test-k2', ahoraMs: ahora }), {
    ahoraMs: ahora, sendFn: async () => { throw new Error('NO DEBERÍA LLAMARSE'); }, credsProvider: credsStub,
  });
  check('(f) tras unkill, con live apagado la entrada vuelve a registrarse como would-send (no killed)',
    libre.action === 'would-send' && libre.reason === 'live_disabled');
}
check('(f) liveTrader.js exporta unkill',
  typeof unkill === 'function');
check('(f) routes.js expone POST /kalshi/live/unkill con auth y sin exigir la env (misma forma que kill)',
  routesSrc.includes("router.post('/kalshi/live/unkill', auth, async (req, res) => {")
  && routesSrc.includes('liveTrader.unkill(req.user.id)')
  && routesSrc.includes('res.json({ ok: true, ...snap, kalshiConnected: !!conn });'));

console.log('v17 — (g) Con live apagado el espejo es would-send sin red');
{
  liveOff();
  let llamadasEnvio = 0;
  const sendQueFalla = async () => { llamadasEnvio++; throw new Error('NO DEBERÍA LLAMARSE AL ENVÍO'); };
  const u = 994010;
  await arm(u);
  const ahora = Date.now();
  const entry = await handleTraderEntry(u, entradaTrader({ ticker: 'KXBTC15M-26NOV182330-05', id: 'pt-test-w1', ev: 0.05, ahoraMs: ahora }), {
    ahoraMs: ahora, sendFn: sendQueFalla, credsProvider: credsStub,
  });
  const est = _traders.get(u);
  check("(g) live apagado -> entry.action 'would-send', reason 'live_disabled', sendFn 0 llamadas",
    entry.action === 'would-send' && entry.reason === 'live_disabled' && llamadasEnvio === 0,
    `action=${entry.action} llamadas=${llamadasEnvio}`);
  check('(g) el would-send queda en el log con fuente trader y entradaId',
    est.log.length === 1 && est.log[0].action === 'would-send'
    && est.log[0].fuente === 'trader' && est.log[0].entradaId === 'pt-test-w1');
  check('(g) live sigue APAGADO por defecto (isLiveEnabled false sin la env)',
    isLiveEnabled() === false);
}

console.log('v17 — Versión, cliente y motor intacto');
check("VERSION_LABEL es 'v18 — Decisión compacta (solo §2)' (v18 por diseño)",
  app.includes("const VERSION_LABEL = 'v18 — Decisión compacta (solo §2)';"));
check('VERSION.txt empieza en v18 y corrige v16.10 (5a9aa479) como DESPLEGADA (v18 por diseño)',
  versionTxt.startsWith('v18')
  && versionTxt.includes('v16.10 — Evaluar toda la ventana, sin salida por lock roto (18-nov-2026) — DESPLEGADA en Render (commit 5a9aa479)'));
check('PaperTrader.jsx (§6) ya no habla de tope de 5: sin max_entradas_dia, sin sin_reentrada, sin "Entradas hoy (máx. 5)" ni "/ 5" (las menciones en comentarios no cuentan)',
  !sinComentarios(paperTraderJsx).includes('max_entradas_dia') && !sinComentarios(paperTraderJsx).includes('sin_reentrada')
  && !paperTraderJsx.includes('Entradas hoy (máx. 5)') && !paperTraderJsx.includes('} / 5')
  && paperTraderJsx.includes('Entradas hoy') && paperTraderJsx.includes('puede volver a entrar en la misma ventana'));
check('LiveTrader.jsx (§7) tiene el botón "Quitar kill" a /api/kalshi/live/unkill, habilitado solo con killed',
  liveTraderJsx.includes("'/api/kalshi/live/unkill'") && liveTraderJsx.includes('Quitar kill')
  && liveTraderJsx.includes('disabled={busy || !user || !killed}')
  && liveTraderJsx.includes('el espejo vuelve a registrar HABRÍA ENVIADO'));
check('LiveTrader.jsx (§7) ya no dice que no se puede armar hasta levantar la detención sin botón: ahora se levanta con "Quitar kill"',
  liveTraderJsx.includes('con el botón "Quitar kill"') && !liveTraderJsx.includes('no se puede armar hasta que'));
check('el vivo NO vende/cierra: liveTrader.js no define ni exporta venderPosicion ni cerrarPosicion',
  !liveTraderSrc.includes('venderPosicion') && !liveTraderSrc.includes('cerrarPosicion')
  && !/function\s+(vender|cerrar)/.test(liveTraderSrc)
  && trader.venderPosicion === undefined && trader.cerrarPosicion === undefined);
check('verificarLimitesTrader y evaluarDecision no cambiaron de forma (siguen exportadas y con la misma firma)',
  typeof verificarLimitesTrader === 'function' && typeof trader.evaluarDecision === 'function'
  && verificarLimitesTrader({ qty: 1, ask: 0.5, ev: 0.02 }).ok === true);
check('el motor no menciona al trader (kalshi.js, analysis.js, verdict.js, windowOutcome.js)',
  ['client/src/kalshi.js', 'client/src/analysis.js', 'client/src/verdict.js', 'client/src/windowOutcome.js']
    .every((p) => !src(p).includes('paperTrader') && !src(p).includes('paper-trader')));

// Restaurar la env como estaba.
if (envOriginal === undefined) delete process.env.LIVE_TRADING_ENABLED;
else process.env.LIVE_TRADING_ENABLED = envOriginal;

console.log(`\ntests-v17.mjs: ${pass} pasaron, ${fail} fallaron.`);
process.exit(fail ? 1 : 0);
