// tests-v16.10.mjs — Evaluar toda la ventana + quitar el lock roto
// + registro de evaluaciones rechazadas (SERVIDOR, solo en local).
// NADA de esto toca la red de Kalshi para enviar órdenes ni enciende
// live: las únicas llamadas externas son GET públicos (descubrir/
// quote, siempre con stubs en las pruebas de tick). Sin credenciales
// reales: el trader es de prueba y no hay BD ni HTTP en este archivo
// (la ruta GET ya expone el snapshot por spread; se verifica por
// fuente que `evaluaciones` llega a la API).
// Uso: node tests-v16.10.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const pt = require('./server/paperTrader.js');

const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const paperTraderSrc = src('server/paperTrader.js');
const traderEvalSrc = src('server/traderEval.js');
const routesSrc = src('server/routes.js');
const motor = ['client/src/kalshi.js', 'client/src/analysis.js', 'client/src/verdict.js', 'client/src/windowOutcome.js'].map(src);

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const approx = (a, b, tol) => Math.abs(a - b) <= tol;
const sha256 = (p) => createHash('sha256').update(readFileSync(path.join(ROOT, p))).digest('hex');

// Hashes del baseline v16.9 (tests-v16.6.mjs): liveTrader.js,
// paperAuditor.js y el motor NO se tocan en v16.10; si alguno
// cambia, falla. RE-BASELINE v16.10: kalshi.js cambió POR DISEÑO
// en v16.8 (regla 1 con tiempo restante) y el hash viejo de
// tests-v16.6.mjs ya estaba desactualizado (leftover documentado
// en v16.9); el nuevo hash se verificó contra el contenido real
// (la regla 1 con el umbral de 5 min está en el archivo).
// v17 — RE-BASELINE del coordinador: liveTrader.js cambió POR
// DISEÑO en v17 (unkill + ruta /kalshi/live/unkill + dedup por
// entradaId). Hash nuevo 3314ec54… verificado con sha256sum.
const HASH_LIVE_TRADER = '3314ec54ec628c3291e6fa20ca3a98a983a922c8539d02150dea0c3f3928ef92';
const HASH_PAPER_AUDITOR = '7bd6af9aec741b4f7e1695839f4edf77027ad40c8897210d5f4b48101452263d';
const HASH_MOTOR = {
  'client/src/kalshi.js': '82812817adee3cf71aba42090f4dc846b7a0a83230ec7b47df0e16f87c447f04',
  'client/src/analysis.js': '19ad00b9ab5fbcbf5b9fc5efbcb019b3862051424a6c256e4308c09c2c94d050',
  'client/src/verdict.js': '9104e9a67a6533bf613aa97e74a467e1fd214d0d6c43809e13e5b8615bcf068c',
  'client/src/windowOutcome.js': '2e23b9953d31de18e587ca74343d82acd6ca5a03dc6e797cdb4f083754aa3282',
};

// Anillo σ pre-sembrado: 12 valores alternos 100400/100600
// (σ ≈ 104 antes del tick, ≈ 100 tras empujar el valor actual).
const ANILLO_SEED = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 100400 : 100600));

console.log('v16.10 — 0. Guardas: vivo, auditor y motor intactos; lock roto fuera del código');
check('LIVE_TRADING_ENABLED no está puesta en el entorno de este test',
  process.env.LIVE_TRADING_ENABLED !== 'true');
check('paperTrader.js no importa liveTrader ni lee LIVE_TRADING_ENABLED',
  !paperTraderSrc.includes("require('./liveTrader')") && !paperTraderSrc.includes('require("./liveTrader")')
  && !paperTraderSrc.includes('process.env.LIVE_TRADING_ENABLED'));
check("paperTrader.js no menciona 'lock_roto' en ningún sitio (ni código ni comentarios)",
  !paperTraderSrc.includes('lock_roto'));
check("traderEval.js no menciona 'lock_roto' en ningún sitio (ni código ni comentarios)",
  !traderEvalSrc.includes('lock_roto'));
check('traderEval.js ya no usa MIN_REQ_MOVE_USD (solo queda en un comentario del encabezado que explica su retirada)',
  !/\bMIN_REQ_MOVE_USD\b/.test(traderEvalSrc.replace(/\/\/.*$/gm, '')));
check('liveTrader.js intacto (sha256 del baseline v16.9)',
  sha256('server/liveTrader.js') === HASH_LIVE_TRADER);
check('paperAuditor.js intacto (sha256 del baseline)',
  sha256('server/paperAuditor.js') === HASH_PAPER_AUDITOR);
check('motor del cliente intacto (kalshi.js, analysis.js, verdict.js, windowOutcome.js)',
  Object.entries(HASH_MOTOR).every(([p, h]) => sha256(p) === h));
check('el motor no menciona al trader (kalshi.js, analysis.js, verdict.js, windowOutcome.js)',
  motor.every((m) => !m.includes('paperTrader') && !m.includes('paper-trader')));
check('routes.js expone el snapshot del trader por spread (evaluaciones llega a la API sin tocar routes)',
  routesSrc.includes('const snap = paperTrader.getSnapshot(req.user.id);')
  && routesSrc.includes('res.json({ ...snap, kalshiConnected: true })'));
check('MAX_EVALUACIONES es 20 y el estado nace con el anillo vacío',
  pt.MAX_EVALUACIONES === 20 && Array.isArray(pt.crearEstadoTrader().evaluaciones)
  && pt.crearEstadoTrader().evaluaciones.length === 0);

console.log('v16.10 — 1. evaluarSalida pura: sin lock roto; ganancia, stop y fin de ventana intactos');
{
  const base = { lado: 'yes', segundosRestantes: 30, valorNeto: 0.45, costoTotal: 0.50 };
  check('(c) el lock roto YA NO vende: SÍ con neto 0.45 (sin ganancia ni stop) se MANTIENE a R=30',
    pt.evaluarSalida(base).accion === 'mantener');
  check('(c) el lock roto YA NO vende: NO con neto 0.45 se MANTIENE a R=30',
    pt.evaluarSalida({ ...base, lado: 'no' }).accion === 'mantener');
  check('(c) los args viejos (salto, twapBloqueado, targetPrice) se ignoran: con salto −50 sigue mantener',
    pt.evaluarSalida({ ...base, salto: -50, twapBloqueado: 99990, targetPrice: 100000 }).accion === 'mantener');
  check('(c) a R=1 con neto<costo vende por FIN DE VENTANA (no por lock): la regla (d) no depende del salto',
    pt.evaluarSalida({ ...base, segundosRestantes: 1 }).motivo === 'fin_ventana');
  check('(d) ganancia: neto 0.52 (≥ costo+0.02) vende; 0.5199 mantiene',
    pt.evaluarSalida({ ...base, valorNeto: 0.52 }).motivo === 'ganancia'
    && pt.evaluarSalida({ ...base, valorNeto: 0.5199 }).accion === 'mantener');
  check('(e) stop-loss: neto 0.25 (≤ 50% del costo) vende; 0.26 mantiene',
    pt.evaluarSalida({ ...base, valorNeto: 0.25 }).motivo === 'stop_loss'
    && pt.evaluarSalida({ ...base, valorNeto: 0.26 }).accion === 'mantener');
  check('(f) fin de ventana R=3: neto 0.40 (< costo) vende; neto 0.51 (ganando, sin llegar a +0.02) mantiene; R=4 con 0.40 mantiene',
    pt.evaluarSalida({ ...base, segundosRestantes: 3, valorNeto: 0.40 }).motivo === 'fin_ventana'
    && pt.evaluarSalida({ ...base, segundosRestantes: 3, valorNeto: 0.51 }).accion === 'mantener'
    && pt.evaluarSalida({ ...base, segundosRestantes: 4, valorNeto: 0.40 }).accion === 'mantener');
  check('sin valor neto (sin precio de salida) siempre mantiene',
    pt.evaluarSalida({ ...base, valorNeto: null }).accion === 'mantener');
}

console.log('v16.10 — 2. evaluarEntrada pura: motivos que el tick registra');
{
  const q = { yesAskDollars: 0.90, yesBidDollars: 0.89, noAskDollars: 0.10 };
  const sinEv = pt.evaluarEntrada({ pYes: null, pNo: null, quote: q, entradasHoy: 0 });
  check("evaluarEntrada sin p (sin sigma) rechaza con sin_ev_valido y campos null",
    sinEv.entrar === false && sinEv.motivo === 'sin_ev_valido'
    && sinEv.lado === null && sinEv.p === null && sinEv.ev === null && sinEv.ask === null);
  const notional = pt.evaluarEntrada({ pYes: 0.99, pNo: 0.01, quote: q, entradasHoy: 0, maxNotionalUsd: 0.5 });
  check('evaluarEntrada con tope de notional $0.50 y ask $0.90 rechaza con max_notional (con lado/p/ev/ask)',
    notional.entrar === false && notional.motivo === 'max_notional'
    && notional.lado === 'yes' && notional.ask === 0.9 && notional.ev > 0.015,
    `ev=${notional.ev}`);
}

// --- Ayudas de tick (patrón tests-v16.6.mjs §8) ---
const { crearEstadoTrader, startTrader, stopTrader, tickTrader, getSnapshot, _traders } = pt;
const limpiar = (uid) => { _traders.delete(uid); };
const persistCalls = [];
pt.setPersistencia(async (uid, estado) => {
  persistCalls.push({ uid, estado: JSON.parse(JSON.stringify(estado)) });
});

// Escenario de ventana con stubs: tick t=0 descubre el contrato;
// tras él se pre-siembran anillo σ y quote fresca, y el tick t=1
// evalúa con R = closeSegs − 1 exacto.
async function escenario(u, { closeSegs, precio = 100500, ask = 0.80, bid = 0.82, noAsk = 0.20, anillo = ANILLO_SEED } = {}) {
  const base = (Math.floor(Date.now() / 1000) + 5) * 1000;
  const closeMs = base + closeSegs * 1000;
  const ticker = `KXBTC15M-TEST-V1610-${u}`;
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
  _traders.set(u, est);
  await tickTrader(u, relojMs, deps); // t=0: descubrimiento
  if (anillo) est.anillo = [...anillo];
  est.quoteActual = { yesAskDollars: ask, yesBidDollars: bidActual, noAskDollars: noAsk, ticker, fetchedAt: base };
  return {
    deps, contrato, ticker, est, base,
    get reloj() { return relojMs; },
    setPrecio(v) { precioActual = v; },
    setBid(v) { bidActual = v; },
    async tick(t) { relojMs = base + t * 1000; const s = await tickTrader(u, relojMs, deps); await sleep(5); return s; },
    snap: () => getSnapshot(u),
  };
}

console.log('v16.10 — 3. Tick: entrada evaluada y posible a R>60 (R=600 y R=900) + ultimaEntrada');
{
  // (a1) R=600 exacto: ventana de 601 s, entrada en el tick t=1.
  const u = 999101;
  const sc = await escenario(u, { closeSegs: 601 });
  const snap = await sc.tick(1);
  check('(a) entrada a R=600: posición SÍ a $0.80, segundosRestantesEntrada=600, entradasHoy=1',
    snap.posicionAbierta && snap.posicionAbierta.lado === 'yes'
    && snap.posicionAbierta.askEntrada === 0.8 && snap.posicionAbierta.segundosRestantesEntrada === 600
    && snap.entradasHoy === 1,
    JSON.stringify(snap.posicionAbierta));
  check('(a) a R>60 NO hay muestras del minuto final (muestras vacías) pero el anillo σ tiene ≥10',
    sc.est.muestras.size === 0 && sc.est.anillo.length >= 10,
    `muestras=${sc.est.muestras.size} anillo=${sc.est.anillo.length}`);
  check('(a) la entrada a R=600 produce ultimaEntrada (camino live v16.9) con quoteFetchedAt fresca',
    snap.ultimaEntrada && snap.ultimaEntrada.ticker === sc.ticker && snap.ultimaEntrada.lado === 'yes'
    && snap.ultimaEntrada.ask === 0.8 && snap.ultimaEntrada.quoteFetchedAt === sc.base,
    JSON.stringify(snap.ultimaEntrada));
  check("(a) el anillo registra la entrada: motivo 'entrada', R=600, lado yes, p≈1, ev≈0.1888, ask 0.80",
    snap.evaluaciones.length === 1 && snap.evaluaciones[0].motivo === 'entrada'
    && snap.evaluaciones[0].R === 600 && snap.evaluaciones[0].lado === 'yes'
    && snap.evaluaciones[0].p > 0.999 && approx(snap.evaluaciones[0].ev, 0.1888, 1e-4)
    && snap.evaluaciones[0].ask === 0.8 && typeof snap.evaluaciones[0].at === 'string',
    JSON.stringify(snap.evaluaciones[0]));
  limpiar(u);

  // (a2) R=900 exacto: ventana de 901 s, entrada en el tick t=1.
  const u2 = 999102;
  const sc2 = await escenario(u2, { closeSegs: 901 });
  const snap2 = await sc2.tick(1);
  check('(a) entrada a R=900: posición SÍ a $0.80, segundosRestantesEntrada=900, ultimaEntrada presente',
    snap2.posicionAbierta && snap2.posicionAbierta.lado === 'yes'
    && snap2.posicionAbierta.segundosRestantesEntrada === 900
    && snap2.ultimaEntrada && snap2.ultimaEntrada.ticker === sc2.ticker,
    JSON.stringify(snap2.posicionAbierta));
  check("(a) el anillo a R=900 registra 'entrada' con R=900",
    snap2.evaluaciones.length === 1 && snap2.evaluaciones[0].motivo === 'entrada'
    && snap2.evaluaciones[0].R === 900,
    JSON.stringify(snap2.evaluaciones[0]));
  limpiar(u2);
}

console.log('v16.10 — 4. Tick: a R>60 con EV≤$0.015 no entra y queda ev_bajo; anillo con tope 20');
{
  const u = 999103;
  // ask 0.99 con p≈1: EV ≈ 0.0093 < 0.015 → ev_bajo.
  const sc = await escenario(u, { closeSegs: 601, ask: 0.99, bid: 0.98, noAsk: 0.01 });
  let snap = await sc.tick(1);
  check('(b) a R=600 con EV≈0.0093 no entra (sin posición, entradasHoy=0)',
    snap.posicionAbierta === null && snap.entradasHoy === 0);
  check("(b) queda registrado con motivo ev_bajo, lado yes, p≈1, ev≈0.0093, ask 0.99",
    snap.evaluaciones.length === 1 && snap.evaluaciones[0].motivo === 'ev_bajo'
    && snap.evaluaciones[0].R === 600 && snap.evaluaciones[0].lado === 'yes'
    && snap.evaluaciones[0].p > 0.999 && approx(snap.evaluaciones[0].ev, 0.0093, 1e-4)
    && snap.evaluaciones[0].ask === 0.99,
    JSON.stringify(snap.evaluaciones[0]));
  // 24 ticks más (25 evaluaciones en total): el anillo se queda en 20.
  for (let t = 2; t <= 25; t++) snap = await sc.tick(t);
  check('(g) el anillo se queda en las últimas 20 (25 evaluaciones → 20 registros)',
    snap.evaluaciones.length === 20,
    `len=${snap.evaluaciones.length}`);
  check('(g) newest first: el primer registro es más reciente (at mayor, R menor) que el último',
    snap.evaluaciones[0].at > snap.evaluaciones[19].at
    && snap.evaluaciones[0].R < snap.evaluaciones[19].R,
    `primero R=${snap.evaluaciones[0].R} último R=${snap.evaluaciones[19].R}`);
  check('(g) todos los registros llevan la forma exacta {at, R, lado, p, ev, ask, motivo} con tipos correctos',
    snap.evaluaciones.every((e) => typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at))
      && typeof e.R === 'number' && (e.lado === 'yes' || e.lado === 'no' || e.lado === null)
      && (typeof e.p === 'number' || e.p === null) && (typeof e.ev === 'number' || e.ev === null)
      && (typeof e.ask === 'number' || e.ask === null) && typeof e.motivo === 'string'));
  check('(g) entre los 20 hay rechazos ev_bajo (el motivo real, no solo bloqueos de quote)',
    snap.evaluaciones.some((e) => e.motivo === 'ev_bajo'));
  limpiar(u);
}

console.log('v16.10 — 5. Tick: la salida por lock roto YA NO vende (posición con salto roto se mantiene)');
{
  const u = 999104;
  const sc = await escenario(u, { closeSegs: 601 });
  let snap = await sc.tick(1); // entra SÍ a $0.80 a R=600
  check('tick: entra SÍ a R=600 (costo $0.8112) antes de la caída',
    snap.posicionAbierta && snap.posicionAbierta.lado === 'yes' && snap.posicionAbierta.costoTotal === 0.8112);
  check('tick: con posición abierta NO se registra nada de entrada (el anillo sigue solo con la entrada)',
    snap.evaluaciones.length === 1 && snap.evaluaciones[0].motivo === 'entrada');
  // El precio cae por debajo del target: salto +100, el lock viejo
  // estaría roto (SÍ con salto > −95). El bid sigue en 0.82: neto
  // 0.8097, sin ganancia (≥0.8312) ni stop (≤0.4056), R>3.
  sc.setPrecio(99900);
  for (let t = 2; t <= 10; t++) snap = await sc.tick(t);
  check('(c) tras la caída (salto +100) la posición SIGUE ABIERTA a R≈591: sin salida por lock roto',
    snap.posicionAbierta && snap.posicionAbierta.ticker === sc.ticker && snap.trades.length === 0,
    JSON.stringify(snap.posicionAbierta));
  check('(c) con posición abierta el anillo no crece (sigue solo la entrada, sin registros de salida)',
    snap.evaluaciones.length === 1 && snap.evaluaciones[0].motivo === 'entrada',
    `len=${snap.evaluaciones.length}`);
  check('(c) el caso real 26NOV182330-30 ya no se repetiría: entrar NO a $0.45 y que el salto venda 1 s después no existe',
    !snap.trades.some((t) => t.motivoSalida === 'lock_roto'));
  limpiar(u);
}

console.log('v16.10 — 6. Tick: ganancia sigue vendiendo a R>60 y tras la salida SE re-entra (v17)');
{
  const u = 999105;
  const sc = await escenario(u, { closeSegs: 601 });
  let snap = await sc.tick(1); // entra SÍ a $0.80 a R=600
  check('tick: entra SÍ a R=600 antes de la subida del bid',
    snap.posicionAbierta && snap.posicionAbierta.lado === 'yes');
  sc.setBid(0.90); // neto 0.8937 ≥ costo+0.02 (0.8312)
  for (let t = 2; t <= 8; t++) snap = await sc.tick(t);
  check('(d) con bid 0.90 vende por ganancia a R>60 (P&L +0.0825) y v17 RE-ENTRA: 3 trades, entradasHoy=4, posición abierta',
    snap.trades.length === 3 && snap.entradasHoy === 4 && snap.posicionAbierta
    && snap.posicionAbierta.lado === 'yes'
    && snap.trades[snap.trades.length - 1].motivoSalida === 'ganancia'
    && approx(snap.trades[snap.trades.length - 1].pnlUsd, 0.0825, 1e-4)
    && snap.trades.every((t) => t.motivoSalida === 'ganancia'),
    JSON.stringify(snap.trades[0]));
  check("(g) v17: tras cada salida el tick siguiente registra una NUEVA 'entrada' (re-entrada, sin sin_reentrada)",
    snap.evaluaciones.length === 4 && snap.evaluaciones.every((e) => e.motivo === 'entrada')
    && !snap.evaluaciones.some((e) => e.motivo === 'sin_reentrada'),
    JSON.stringify(snap.evaluaciones.slice(0, 2)));
  limpiar(u);
}

console.log('v16.10 — 7. Tick: stop-loss sigue vendiendo a R>60');
{
  const u = 999106;
  const sc = await escenario(u, { closeSegs: 601 });
  let snap = await sc.tick(1); // entra SÍ a $0.80 a R=600
  sc.setBid(0.20); // neto 0.1888 ≤ 50% del costo (0.4056)
  for (let t = 2; t <= 8; t++) snap = await sc.tick(t);
  check('(e) con bid 0.20 vende por stop_loss a R>60 (P&L −0.6224) y v17 RE-ENTRA: 3 trades, entradasHoy=4, posición abierta',
    snap.trades.length === 3 && snap.entradasHoy === 4 && snap.posicionAbierta
    && snap.posicionAbierta.lado === 'yes'
    && snap.trades[snap.trades.length - 1].motivoSalida === 'stop_loss'
    && approx(snap.trades[snap.trades.length - 1].pnlUsd, -0.6224, 1e-4)
    && snap.trades.every((t) => t.motivoSalida === 'stop_loss'),
    JSON.stringify(snap.trades[0]));
  limpiar(u);
}

console.log('v16.10 — 8. Tick: fin de ventana R≤3 (vende si pierde, mantiene si gana); muestras sí se suman en [1,60]');
{
  // (f1) bid 0.82 → neto 0.8097 < costo 0.8112: vende en R≤3.
  const u = 999107;
  const sc = await escenario(u, { closeSegs: 65, anillo: null });
  let snap = null;
  for (let t = 1; t <= 12; t++) snap = await sc.tick(t);
  check('(f) entra SÍ en el último minuto (R entre 50 y 60) sin anillo pre-sembrado',
    snap.posicionAbierta && snap.posicionAbierta.lado === 'yes'
    && snap.posicionAbierta.segundosRestantesEntrada >= 50
    && snap.posicionAbierta.segundosRestantesEntrada <= 60,
    JSON.stringify(snap.posicionAbierta));
  for (let t = 13; t <= 20; t++) snap = await sc.tick(t);
  check('(f) en el último minuto SÍ se suman muestras (≥10 tras 20 ticks)',
    sc.est.muestras.size >= 10, `muestras=${sc.est.muestras.size}`);
  for (let t = 21; t <= 55; t++) snap = await sc.tick(t);
  check('(f) a R=10 sigue abierta (neto 0.8097: sin ganancia ni stop, R>3)',
    snap.posicionAbierta && snap.posicionAbierta.ticker === sc.ticker && snap.trades.length === 0,
    `R~${65 - 55}`);
  for (let t = 56; t <= 65; t++) snap = await sc.tick(t);
  check('(f) al llegar a R≤3 vende por fin_ventana (iba perdiendo por $0.0015) y v17 RE-ENTRA dos veces más: 3 trades, todos fin_ventana −0.0015',
    snap.trades.length === 3
    && snap.trades.every((t) => t.motivoSalida === 'fin_ventana' && approx(t.pnlUsd, -0.0015, 1e-4)),
    JSON.stringify(snap.trades[0]));
  limpiar(u);

  // (f2) bid 0.83 → neto 0.8201 > costo 0.8112 (ganando sin llegar a
  // +0.02): se mantiene hasta liquidación.
  const u2 = 999108;
  const sc2 = await escenario(u2, { closeSegs: 65, bid: 0.83, anillo: null });
  let snap2 = null;
  for (let t = 1; t <= 12; t++) snap2 = await sc2.tick(t);
  check('(f) con bid 0.83 entra SÍ (neto 0.8201 > costo, ganando poco)',
    snap2.posicionAbierta && snap2.posicionAbierta.lado === 'yes');
  for (let t = 13; t <= 62; t++) snap2 = await sc2.tick(t);
  check('(f) a R=3 sigue abierta (ganando sin llegar a +0.02: ni ganancia ni fin de ventana)',
    snap2.posicionAbierta && snap2.posicionAbierta.ticker === sc2.ticker && snap2.trades.length === 0);
  for (let t = 63; t <= 65; t++) snap2 = await sc2.tick(t);
  check('(f) al cerrar la ventana pasa a pendiente-liquidacion (no se vendió por fin de ventana)',
    snap2.posicionAbierta === null && snap2.trades.length === 1
    && snap2.trades[0].estado === 'pendiente-liquidacion'
    && snap2.trades[0].motivoSalida === 'liquidacion',
    JSON.stringify(snap2.trades[0]));
  limpiar(u2);
}

console.log('v16.10 — 9. Anillo: motivos de bloqueo (sin_quote_fresca, sin_sigma, sin_tick_brti, tick_desactualizado, sin_tiempo) — v17: sin max_entradas_dia ni sin_reentrada');
{
  // sin_quote_fresca: primer tick de evaluación sin quote aún (el
  // fetch en paralelo todavía no aterrizó).
  const u = 999109;
  const base = (Math.floor(Date.now() / 1000) + 5) * 1000;
  const ticker = `KXBTC15M-TEST-V1610-${u}`;
  const contrato = { ticker, targetPrice: 100000, closeMs: base + 601 * 1000, closeIso: 'x' };
  let relojMs = base;
  const deps = {
    brtiState: () => ({ value: 100500, avg60s: null, avg15mFinal: null, updatedAt: new Date(relojMs).toISOString(), status: 'connected', error: null }),
    descubrir: async () => contrato,
    quote: async () => ({ ticker, status: 'active', result: null, expirationValue: null, yesAskDollars: 0.80, yesBidDollars: 0.82, noAskDollars: 0.20 }),
  };
  const est = crearEstadoTrader();
  est.enabled = true;
  _traders.set(u, est);
  await tickTrader(u, relojMs, deps); // descubrimiento
  relojMs = base + 1000;
  const snapSinQuote = await tickTrader(u, relojMs, deps); // sin sleep: la quote aún no aterrizó
  check("(g) sin quote fresca en el primer tick → motivo sin_quote_fresca, R=600, campos null",
    snapSinQuote.evaluaciones.length === 1 && snapSinQuote.evaluaciones[0].motivo === 'sin_quote_fresca'
    && snapSinQuote.evaluaciones[0].R === 600 && snapSinQuote.evaluaciones[0].lado === null
    && snapSinQuote.evaluaciones[0].p === null && snapSinQuote.evaluaciones[0].ev === null
    && snapSinQuote.evaluaciones[0].ask === null,
    JSON.stringify(snapSinQuote.evaluaciones[0]));
  await sleep(5);
  limpiar(u);

  // sin_sigma: quote fresca pre-sembrada pero anillo con 1 sola muestra.
  const u2 = 999110;
  const sc2 = await escenario(u2, { closeSegs: 601, anillo: [] });
  const snapSinSigma = await sc2.tick(1);
  check("(g) con quote fresca pero sin sigma (1 muestra) → motivo sin_sigma",
    snapSinSigma.posicionAbierta === null
    && snapSinSigma.evaluaciones.length === 1 && snapSinSigma.evaluaciones[0].motivo === 'sin_sigma'
    && snapSinSigma.evaluaciones[0].R === 600,
    JSON.stringify(snapSinSigma.evaluaciones[0]));
  limpiar(u2);

  // sin_tick_brti: el WS no da valor.
  const u3 = 999111;
  const base3 = (Math.floor(Date.now() / 1000) + 5) * 1000;
  const ticker3 = `KXBTC15M-TEST-V1610-${u3}`;
  const contrato3 = { ticker: ticker3, targetPrice: 100000, closeMs: base3 + 601 * 1000, closeIso: 'x' };
  let reloj3 = base3;
  const deps3 = {
    brtiState: () => null,
    descubrir: async () => contrato3,
    quote: async () => ({ ticker: ticker3, status: 'active', result: null, expirationValue: null, yesAskDollars: 0.80, yesBidDollars: 0.82, noAskDollars: 0.20 }),
  };
  const est3 = crearEstadoTrader();
  est3.enabled = true;
  _traders.set(u3, est3);
  await tickTrader(u3, reloj3, deps3);
  reloj3 = base3 + 1000;
  const snapSinTick = await tickTrader(u3, reloj3, deps3);
  check("(g) sin tick BRTI → motivo sin_tick_brti, R=600",
    snapSinTick.evaluaciones.length === 1 && snapSinTick.evaluaciones[0].motivo === 'sin_tick_brti'
    && snapSinTick.evaluaciones[0].R === 600,
    JSON.stringify(snapSinTick.evaluaciones[0]));
  limpiar(u3);

  // tick_desactualizado: tick BRTI de hace 60 s.
  const u4 = 999112;
  const base4 = (Math.floor(Date.now() / 1000) + 5) * 1000;
  const ticker4 = `KXBTC15M-TEST-V1610-${u4}`;
  const contrato4 = { ticker: ticker4, targetPrice: 100000, closeMs: base4 + 601 * 1000, closeIso: 'x' };
  let reloj4 = base4;
  const deps4 = {
    brtiState: () => ({ value: 100500, avg60s: null, avg15mFinal: null, updatedAt: new Date(reloj4 - 60000).toISOString(), status: 'connected', error: null }),
    descubrir: async () => contrato4,
    quote: async () => ({ ticker: ticker4, status: 'active', result: null, expirationValue: null, yesAskDollars: 0.80, yesBidDollars: 0.82, noAskDollars: 0.20 }),
  };
  const est4 = crearEstadoTrader();
  est4.enabled = true;
  _traders.set(u4, est4);
  await tickTrader(u4, reloj4, deps4);
  reloj4 = base4 + 1000;
  const snapViejo = await tickTrader(u4, reloj4, deps4);
  check("(g) tick BRTI desactualizado (>15 s) → motivo tick_desactualizado",
    snapViejo.evaluaciones.length === 1 && snapViejo.evaluaciones[0].motivo === 'tick_desactualizado'
    && snapViejo.evaluaciones[0].R === 600,
    JSON.stringify(snapViejo.evaluaciones[0]));
  limpiar(u4);

  // sin_tiempo: R=1 (R'=0) con todo lo demás listo.
  const u5 = 999113;
  const sc5 = await escenario(u5, { closeSegs: 2 });
  const snapSinTiempo = await sc5.tick(1);
  check("(g) a R=1 (R'=0) con quote y sigma → motivo sin_tiempo, R=1",
    snapSinTiempo.posicionAbierta === null
    && snapSinTiempo.evaluaciones.length === 1 && snapSinTiempo.evaluaciones[0].motivo === 'sin_tiempo'
    && snapSinTiempo.evaluaciones[0].R === 1,
    JSON.stringify(snapSinTiempo.evaluaciones[0]));
  limpiar(u5);

  // v17 — SIN tope de entradas/día: con 5 entradas hoy y todo lo
  // demás listo, ENTRA (entradasHoy pasa a 6) y el anillo registra
  // 'entrada', no 'max_entradas_dia'.
  const u6 = 999114;
  const sc6 = await escenario(u6, { closeSegs: 601 });
  sc6.est.entradasHoy = 5;
  const snapTope = await sc6.tick(1);
  check("(g) v17: con 5 entradas hoy ENTRA igual (entradasHoy=6, motivo 'entrada', sin max_entradas_dia)",
    snapTope.posicionAbierta !== null && snapTope.entradasHoy === 6
    && snapTope.evaluaciones.length === 1 && snapTope.evaluaciones[0].motivo === 'entrada'
    && snapTope.evaluaciones[0].lado === 'yes' && snapTope.evaluaciones[0].p > 0.999,
    JSON.stringify(snapTope.evaluaciones[0]));
  limpiar(u6);
}

console.log('v16.10 — 10. (h) 1 posición a la vez y RE-ENTRADA tras salida (v17), a cualquier R');
{
  const u = 999115;
  const sc = await escenario(u, { closeSegs: 601 });
  let snap = await sc.tick(1); // entra SÍ a R=600
  check('(h) entra 1 posición a R=600 (entradasHoy=1)',
    snap.posicionAbierta && snap.posicionAbierta.lado === 'yes' && snap.entradasHoy === 1);
  for (let t = 2; t <= 4; t++) snap = await sc.tick(t);
  check('(h) con posición abierta no se abre una segunda (1 posición, anillo sin crecer)',
    snap.posicionAbierta && snap.entradasHoy === 1 && snap.evaluaciones.length === 1);
  // El bid bajo debe estar puesto ANTES del refetch del tick t=5
  // (la quote solo se re-pide cada ≥5 s y a los 5000 ms exactos
  // sigue fresca): t=5 lo captura y t=6 lo usa para vender.
  sc.setBid(0.20); // stop_loss en el próximo tick con quote fresca
  snap = await sc.tick(5);
  check('(h) en el tick del refetch (quote vieja aún fresca) la posición sigue abierta',
    snap.posicionAbierta && snap.posicionAbierta.ticker === sc.ticker && snap.trades.length === 0);
  snap = await sc.tick(6);
  check('(h) sale por stop_loss a R=595 y v17 RE-ENTRA en el mismo tick (posición abierta, entradasHoy=2, anillo con 2 entradas)',
    snap.trades.length === 1
    && snap.trades[0].motivoSalida === 'stop_loss'
    && snap.posicionAbierta !== null && snap.posicionAbierta.lado === 'yes'
    && snap.entradasHoy === 2
    && snap.evaluaciones.length === 2 && snap.evaluaciones.every((e) => e.motivo === 'entrada')
    && snap.evaluaciones[0].R === 595 && snap.evaluaciones[1].R === 600,
    JSON.stringify(snap.evaluaciones.slice(0, 2)));
  // 10 ticks más con EV favorable (precio 100500, ask 0.80): el bucle
  // entrar→salir por stop se repite mientras el bid siga en 0.20
  // (la quote nueva con bid 0.82 solo aterriza en el refetch de t=10).
  sc.setBid(0.82);
  for (let t = 7; t <= 16; t++) snap = await sc.tick(t);
  check('(h) 10 ticks después de la salida, a R>60 y con EV favorable: 5 trades por stop_loss, posición abierta, entradasHoy=6',
    snap.trades.length === 5 && snap.posicionAbierta !== null && snap.entradasHoy === 6,
    JSON.stringify(snap.stats));
  check('(h) el anillo tiene 6 registros, todos \'entrada\' (R 591..600, newest first)',
    snap.evaluaciones.length === 6
    && snap.evaluaciones.every((e) => e.motivo === 'entrada')
    && snap.evaluaciones[0].R === 591
    && snap.evaluaciones[5].R === 600,
    `len=${snap.evaluaciones.length}`);
  limpiar(u);
}

console.log('v16.10 — 11. Persistencia y snapshot: evaluaciones en memoria, no persistidas');
{
  check('ningún estado persistido en estas pruebas lleva evaluaciones (memoria, no BD)',
    persistCalls.length > 0 && persistCalls.every((c) => !('evaluaciones' in c.estado)),
    `persistCalls=${persistCalls.length}`);
  check('la entrada de la §3 sí se persistió (trades/posición siguen persistidos)',
    persistCalls.some((c) => c.estado.posicionAbierta && c.estado.posicionAbierta.ticker.startsWith('KXBTC15M-TEST-V1610-99910')));
  const snapSinEstado = getSnapshot(999199);
  check('getSnapshot sin estado trae evaluaciones: [] (y ultimaEntrada null)',
    Array.isArray(snapSinEstado.evaluaciones) && snapSinEstado.evaluaciones.length === 0
    && snapSinEstado.ultimaEntrada === null);
  // startTrader limpia el anillo (diagnóstico de la ventana en curso).
  const u = 999116;
  const sc = await escenario(u, { closeSegs: 601, ask: 0.99, bid: 0.98, noAsk: 0.01 });
  await sc.tick(1);
  check('antes de startTrader el anillo tiene el rechazo ev_bajo',
    getSnapshot(u).evaluaciones.length === 1);
  const snapStart = startTrader(u);
  check('startTrader limpia el anillo de evaluaciones (y deja enabled:true)',
    snapStart.enabled === true && snapStart.evaluaciones.length === 0);
  const snapStop = await stopTrader(u);
  check('stopTrader apaga (enabled:false) y conserva el anillo vacío',
    snapStop.enabled === false && snapStop.evaluaciones.length === 0);
  limpiar(u);
}

console.log(`\ntests-v16.10.mjs: ${pass} pasaron, ${fail} fallaron.`);
process.exit(fail ? 1 : 0);
