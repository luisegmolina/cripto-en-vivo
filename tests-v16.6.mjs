// tests-v16.6.mjs — Trader continuo en papel (SERVIDOR).
// NADA de esto toca la red de Kalshi para enviar órdenes ni enciende
// live: las únicas llamadas externas son GET públicos (descubrir/
// quote, siempre con stubs en las pruebas de tick) y el servidor
// local de la sección HTTP. Sin credenciales reales en ningún test:
// el admin y el usuario son de prueba, el JWT_SECRET es de prueba y
// la BD es el modo archivo local (con respaldo y restauración).
// Uso: node tests-v16.6.mjs
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const pt = require('./server/paperTrader.js');
const { hashPassword } = require('./server/auth.js');

const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const paperTraderSrc = src('server/paperTrader.js');
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

// Hashes ANTES del cambio (baseline 18-nov-2026): liveTrader.js y
// paperAuditor.js no se tocan en v16.6; si alguno cambia, falla.
const HASH_LIVE_TRADER = 'f490139913e0430d13272929646199e6b00dbe6a15bae9305a3fe00178b16b60';
const HASH_PAPER_AUDITOR = '7bd6af9aec741b4f7e1695839f4edf77027ad40c8897210d5f4b48101452263d';
const HASH_MOTOR = {
  'client/src/kalshi.js': '7eb7beef78e7f22d24face676aeac4455b1d9b24eedb2b345969149d6a24211b',
  'client/src/analysis.js': '19ad00b9ab5fbcbf5b9fc5efbcb019b3862051424a6c256e4308c09c2c94d050',
  'client/src/verdict.js': '9104e9a67a6533bf613aa97e74a467e1fd214d0d6c43809e13e5b8615bcf068c',
  'client/src/windowOutcome.js': '2e23b9953d31de18e587ca74343d82acd6ca5a03dc6e797cdb4f083754aa3282',
};

console.log('v16.6 — 1. Funciones puras: normalCdf, salto, probabilidad, sigma, EV');
check('normalCdf: Φ(0)=0.5, Φ(1)=0.8413, Φ(1.96)=0.9750, Φ(−1)=1−Φ(1)',
  approx(pt.normalCdf(0), 0.5, 1e-6)
  && approx(pt.normalCdf(1), 0.8413447, 5e-4)
  && approx(pt.normalCdf(1.96), 0.9750021, 5e-4)
  && approx(pt.normalCdf(-1), 1 - pt.normalCdf(1), 1e-9));
{
  // R>60: n=0, R'=60, reqAvg=target, salto=target−v.
  const r = pt.calcularSaltoRequerido({ targetPrice: 100000, n: 40, suma: 4000000, segundosRestantes: 61, brtiValue: 99900 });
  check('calcularSaltoRequerido con R>60: n=0, R\'=60, salto=target−v (=100)',
    r.Rprima === 60 && r.reqAvg === 100000 && r.salto === 100);
  // R=31, n=10, S=1000020: R'=30, reqAvg=99999.33, salto=−0.67.
  const r2 = pt.calcularSaltoRequerido({ targetPrice: 100000, n: 10, suma: 1000020, segundosRestantes: 31, brtiValue: 100000 });
  check('calcularSaltoRequerido con muestras: R\'=30, reqAvg≈99999.33, salto≈−0.67',
    r2.Rprima === 30 && approx(r2.reqAvg, 99999.3333, 0.01) && approx(r2.salto, -0.6667, 0.01));
  const r3 = pt.calcularSaltoRequerido({ targetPrice: 100000, n: 59, suma: 5900000, segundosRestantes: 1, brtiValue: 100000 });
  check('calcularSaltoRequerido con R=1: R\'=0, salto null (lo decide el TWAP)',
    r3.Rprima === 0 && r3.salto === null && r3.reqAvg === null);
}
{
  // Salto FIJO −$2, σ=$3: p(R'=60)≈1, p(R'=1)≈0.75. OJO: con salto
  // fijo, p_yes BAJA de ~1 a 0.75 al bajar R' (tiende a 0.5); lo que
  // sube al bajar R' con TWAP bloqueado es p con salto RECOMPUTADO
  // (ver el test 1b de abajo y el de decaimiento).
  const p60 = pt.calcularProbabilidad({ salto: -2, segundosRestantesEfectivos: 60, sigma: 3 });
  const p1 = pt.calcularProbabilidad({ salto: -2, segundosRestantesEfectivos: 1, sigma: 3 });
  check('calcularProbabilidad salto fijo −$2 σ=$3: p(R\'=60)≈1, p(R\'=1)≈0.7475',
    p60.pYes > 0.999 && approx(p1.pYes, 0.7475, 0.002) && approx(p1.pNo, 1 - 0.7475, 0.002),
    `p60=${p60.pYes} p1=${p1.pYes}`);
  const pCeroArriba = pt.calcularProbabilidad({ salto: null, segundosRestantesEfectivos: 0, sigma: 3, twapBloqueado: 100010, targetPrice: 100000 });
  const pCeroAbajo = pt.calcularProbabilidad({ salto: null, segundosRestantesEfectivos: 0, sigma: 3, twapBloqueado: 99990, targetPrice: 100000 });
  check('calcularProbabilidad con R\'=0: TWAP≥target → p=1; TWAP<target → p=0',
    pCeroArriba.pYes === 1 && pCeroAbajo.pYes === 0);
  const pSinSigma = pt.calcularProbabilidad({ salto: -2, segundosRestantesEfectivos: 30, sigma: null });
  check('calcularProbabilidad sin sigma: p null (no se entra sin sigma)',
    pSinSigma.pYes === null && pSinSigma.pNo === null);
}
{
  // 1b. Con TWAP bloqueado POR ENCIMA del target (salto recomputado),
  // p_yes SÍ sube cuando R' baja: mismo S/n/target/v/sigma.
  const f = (Rp) => {
    const s = pt.calcularSaltoRequerido({ targetPrice: 100000, n: 10, suma: 1000020, segundosRestantes: Rp + 1, brtiValue: 100000 });
    return pt.calcularProbabilidad({ salto: s.salto, segundosRestantesEfectivos: Rp, sigma: 3 });
  };
  const p59 = f(59);
  const p1 = f(1);
  check('TWAP bloqueado por encima del target: p(R\'=59)≈0.807 < p(R\'=1)≈1 (p sube al bajar R\')',
    p59.pYes > 0.80 && p59.pYes < 0.82 && p1.pYes > 0.999 && p1.pYes > p59.pYes,
    `p59=${p59.pYes} p1=${p1.pYes}`);
}
check('calcularSigmaAnillo: <10 muestras → null; 12 constantes → suelo $1; 1..12 → 3.6056',
  pt.calcularSigmaAnillo([1, 2, 3]) === null
  && pt.calcularSigmaAnillo(Array(12).fill(100010)) === 1
  && approx(pt.calcularSigmaAnillo([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 3.605551275, 1e-6));
{
  // EV con p=0.99 a 97/98/99¢ (fee = 0.07×a×(1−a)).
  const ev97 = pt.calcularEV({ p: 0.99, askDollars: 0.97 });
  const ev98 = pt.calcularEV({ p: 0.99, askDollars: 0.98 });
  const ev99 = pt.calcularEV({ p: 0.99, askDollars: 0.99 });
  check('calcularEV p=0.99: 97¢ → +0.017963; 98¢ → +0.008628; 99¢ → −0.000693',
    approx(ev97, 0.017963, 1e-6) && approx(ev98, 0.008628, 1e-6) && approx(ev99, -0.000693, 1e-6),
    `ev97=${ev97} ev98=${ev98} ev99=${ev99}`);
  const fee08 = 0.07 * 0.8 * 0.2;
  check('calcularEV a precio justo (a=p): EV = −fee exactamente',
    approx(pt.calcularEV({ p: 0.8, askDollars: 0.8 }), -fee08, 1e-9)
    && approx(pt.calcularEV({ p: 0.5, askDollars: 0.5 }), -(0.07 * 0.5 * 0.5), 1e-9));
  check('calcularEV con ask inválido (0, 1, null) → null',
    pt.calcularEV({ p: 0.9, askDollars: 0 }) === null
    && pt.calcularEV({ p: 0.9, askDollars: 1 }) === null
    && pt.calcularEV({ p: 0.9, askDollars: null }) === null);
}
{
  const q = { yesAskDollars: 0.8, yesBidDollars: 0.3, noAskDollars: 0.7 };
  check('precioSalida SÍ → yesBid (0.30); NO → 1−yesAsk (0.20)',
    pt.precioSalida({ lado: 'yes', quote: q }) === 0.3
    && approx(pt.precioSalida({ lado: 'no', quote: q }), 0.2, 1e-9));
  check('precioSalida NO sin yesAsk → null (sin precio no se sale)',
    pt.precioSalida({ lado: 'no', quote: { yesAskDollars: null, yesBidDollars: 0.3 } }) === null
    && pt.precioSalida({ lado: 'yes', quote: { yesBidDollars: null } }) === null);
  check('valorNetoSalida: 0.30 → 0.2853 (precio − fee); null → null',
    approx(pt.valorNetoSalida(0.30), 0.2853, 1e-4) && pt.valorNetoSalida(null) === null);
  check('calcularHoldPnl: gana → 1−costo; pierde → −costo; sin resultado → null',
    approx(pt.calcularHoldPnl({ lado: 'yes', costoTotal: 0.8112, resultadoOficial: 'yes' }), 0.1888, 1e-4)
    && approx(pt.calcularHoldPnl({ lado: 'yes', costoTotal: 0.8112, resultadoOficial: 'no' }), -0.8112, 1e-4)
    && pt.calcularHoldPnl({ lado: 'yes', costoTotal: 0.8112, resultadoOficial: null }) === null);
}

console.log('v16.6 — 2. Entrada: solo con EV > umbral');
{
  const q = { yesAskDollars: 0.90, yesBidDollars: 0.89, noAskDollars: 0.10 };
  const ok = pt.evaluarEntrada({ pYes: 0.99, pNo: 0.01, quote: q, entradasHoy: 0 });
  check('evaluarEntrada con EV alto entra por el SÍ (EV≈0.0837 > 0.015)',
    ok.entrar === true && ok.lado === 'yes' && approx(ok.ev, 0.0837, 1e-4), `ev=${ok.ev}`);
  const okNo = pt.evaluarEntrada({ pYes: 0.01, pNo: 0.99, quote: q, entradasHoy: 0 });
  check('evaluarEntrada con el NO favorecido entra por el NO',
    okNo.entrar === true && okNo.lado === 'no' && okNo.ev > 0.015, `ev=${okNo.ev}`);
  const bajo = pt.evaluarEntrada({ pYes: 0.5, pNo: 0.5, quote: { yesAskDollars: 0.5, yesBidDollars: 0.49, noAskDollars: 0.5 }, entradasHoy: 0 });
  check('evaluarEntrada con EV bajo (p=0.5, ask=0.50 → EV<0) rechaza con ev_bajo',
    bajo.entrar === false && bajo.motivo === 'ev_bajo', `ev=${bajo.ev}`);
  const sinQuote = pt.evaluarEntrada({ pYes: 0.99, pNo: 0.01, quote: q, quoteFresca: false, entradasHoy: 0 });
  check('evaluarEntrada sin quote fresca rechaza con sin_quote_fresca',
    sinQuote.entrar === false && sinQuote.motivo === 'sin_quote_fresca');
  const tope = pt.evaluarEntrada({ pYes: 0.99, pNo: 0.01, quote: q, entradasHoy: 5 });
  check('evaluarEntrada con 5 entradas hoy rechaza con max_entradas_dia',
    tope.entrar === false && tope.motivo === 'max_entradas_dia');
  const notional = pt.evaluarEntrada({ pYes: 0.99, pNo: 0.01, quote: q, entradasHoy: 0, maxNotionalUsd: 0.5 });
  check('evaluarEntrada con tope de notional $0.50 y ask $0.90 rechaza con max_notional',
    notional.entrar === false && notional.motivo === 'max_notional');
  const sinEv = pt.evaluarEntrada({ pYes: null, pNo: null, quote: q, entradasHoy: 0 });
  check('evaluarEntrada sin p (sin sigma) rechaza con sin_ev_valido',
    sinEv.entrar === false && sinEv.motivo === 'sin_ev_valido');
}

console.log('v16.6 — 3. Salida: cada regla (costo $0.50)');
{
  const base = { lado: 'yes', twapBloqueado: 100010, targetPrice: 100000, segundosRestantes: 30, valorNeto: 0.45, costoTotal: 0.50 };
  check('(a) lock roto SÍ: salto −50 (> −95) vende; salto −96 mantiene',
    pt.evaluarSalida({ ...base, salto: -50 }).motivo === 'lock_roto'
    && pt.evaluarSalida({ ...base, salto: -96 }).accion === 'mantener');
  check('(a) lock roto NO: salto +50 (< 95) vende; salto +96 mantiene',
    pt.evaluarSalida({ ...base, lado: 'no', salto: 50 }).motivo === 'lock_roto'
    && pt.evaluarSalida({ ...base, lado: 'no', salto: 96 }).accion === 'mantener');
  check('(b) ganancia: neto 0.52 (≥ costo+0.02) vende; 0.5199 mantiene',
    pt.evaluarSalida({ ...base, salto: -200, valorNeto: 0.52 }).motivo === 'ganancia'
    && pt.evaluarSalida({ ...base, salto: -200, valorNeto: 0.5199 }).accion === 'mantener');
  check('(c) stop-loss: neto 0.25 (≤ 50% del costo) vende; 0.26 mantiene',
    pt.evaluarSalida({ ...base, salto: -200, valorNeto: 0.25 }).motivo === 'stop_loss'
    && pt.evaluarSalida({ ...base, salto: -200, valorNeto: 0.26 }).accion === 'mantener');
  check('(d) fin de ventana R=3: neto 0.40 (< costo) vende; neto 0.51 (ganando, sin llegar a +0.02) mantiene; R=4 con 0.40 mantiene',
    pt.evaluarSalida({ ...base, salto: -200, segundosRestantes: 3, valorNeto: 0.40 }).motivo === 'fin_ventana'
    && pt.evaluarSalida({ ...base, salto: -200, segundosRestantes: 3, valorNeto: 0.51 }).accion === 'mantener'
    && pt.evaluarSalida({ ...base, salto: -200, segundosRestantes: 4, valorNeto: 0.40 }).accion === 'mantener');
  check('sin valor neto (sin precio de salida) siempre mantiene',
    pt.evaluarSalida({ ...base, salto: -50, valorNeto: null }).accion === 'mantener');
  check('prioridad: lock roto gana a ganancia (salto −50 + neto 0.60 → lock_roto)',
    pt.evaluarSalida({ ...base, salto: -50, valorNeto: 0.60 }).motivo === 'lock_roto');
  check('R\'=0 (salto null): TWAP<target con SÍ → lock_roto; TWAP≥target y neto<costo en R=1 → fin_ventana',
    pt.evaluarSalida({ ...base, salto: null, twapBloqueado: 99990, segundosRestantes: 1, valorNeto: 0.45 }).motivo === 'lock_roto'
    && pt.evaluarSalida({ ...base, salto: null, twapBloqueado: 100010, segundosRestantes: 1, valorNeto: 0.45 }).motivo === 'fin_ventana');
}

console.log('v16.6 — 4. Stats: con salidas vs manteniendo');
{
  const trades = [
    { ticker: 'T1', estado: 'cerrado', motivoSalida: 'lock_roto', pnlUsd: -0.5259, holdPnlUsd: 0.1888 },
    { ticker: 'T2', estado: 'cerrado', motivoSalida: 'liquidacion', pnlUsd: 0.1411, holdPnlUsd: 0.1411 },
    { ticker: 'T3', estado: 'pendiente-liquidacion', motivoSalida: 'liquidacion', pnlUsd: null, holdPnlUsd: null },
    { ticker: 'T4', estado: 'cerrado', motivoSalida: 'ganancia', pnlUsd: 0.03, holdPnlUsd: null },
  ];
  const st = pt.calcularStats(trades, 3);
  check('calcularStats: 3 cerrados, 2 ganados, pnl total −0.3548, con salidas −0.4959, manteniendo +0.1888 (parcial), 1 hold pendiente, 1 pendiente de liquidación',
    st.trades === 3 && st.ganados === 2 && st.perdidos === 1
    && approx(st.pnlTotalUsd, -0.3548, 1e-4)
    && approx(st.pnlConSalidasUsd, -0.4959, 1e-4)
    && approx(st.pnlManteniendoUsd, 0.1888, 1e-4)
    && st.holdPendientes === 1 && st.pendientesLiquidacion === 1 && st.entradasHoy === 3,
    JSON.stringify(st));
}

console.log('v16.6 — 5. Decaimiento (formulación CORRECTA: a ask fijo el EV SUBE cuando R baja)');
{
  // TWAP bloqueado por encima del target: target=100000, n=10,
  // S=1000020, v=100000, σ=$3. La p del SÍ sube al bajar R'.
  const prob = (Rp) => {
    const s = pt.calcularSaltoRequerido({ targetPrice: 100000, n: 10, suma: 1000020, segundosRestantes: Rp + 1, brtiValue: 100000 });
    return { salto: s.salto, ...pt.calcularProbabilidad({ salto: s.salto, segundosRestantesEfectivos: Rp, sigma: 3 }) };
  };
  const a59 = prob(59);
  const a1 = prob(1);
  check('p sube al bajar R\': p(R\'=59)≈0.807 < p(R\'=1)≈1',
    a59.pYes > 0.80 && a59.pYes < 0.82 && a1.pYes > 0.999,
    `p59=${a59.pYes} p1=${a1.pYes}`);
  // A ASK FIJO ($0.80) el EV SUBE cuando R baja, porque p sube.
  const ev59 = pt.calcularEV({ p: a59.pYes, askDollars: 0.80 });
  const ev1 = pt.calcularEV({ p: a1.pYes, askDollars: 0.80 });
  check('a ask fijo $0.80 el EV SUBE cuando R baja (EV(R\'=1) > EV(R\'=59)) — NO cae',
    ev1 > ev59 && ev1 > 0.18 && ev59 < 0,
    `ev59=${ev59} ev1=${ev1}`);
  // Lo que decae es el PRECIO DE MERCADO: el ask justo (a = p) sube
  // hacia $1 y la ganancia máxima (1 − ask − fee) se achica.
  const gananciaJusta = (p) => 1 - p - (0.07 * p * (1 - p));
  const g59 = gananciaJusta(a59.pYes);
  const g1 = gananciaJusta(a1.pYes);
  check('el ask justo sube hacia $1 (0.807 → ~1) y la ganancia a precio justo se achica (0.18 → ~0)',
    a1.pYes > a59.pYes && g1 < g59 && g59 > 0.17 && g59 < 0.19 && g1 < 0.001,
    `askJusto59=${a59.pYes} askJusto1=${a1.pYes} g59=${g59} g1=${g1}`);
  // A precio justo, EV = −fee exactamente (sin filo solo queda comisión).
  const fee59 = 0.07 * a59.pYes * (1 - a59.pYes);
  const fee1 = 0.07 * a1.pYes * (1 - a1.pYes);
  check('EV a precio justo = −fee (R\'=59 y R\'=1)',
    approx(pt.calcularEV({ p: a59.pYes, askDollars: a59.pYes }), -fee59, 1e-9)
    && approx(pt.calcularEV({ p: a1.pYes, askDollars: a1.pYes }), -fee1, 1e-9));
}

console.log('v16.6 — 6. Guardas de papel: live apagado, auditor y trader intactos, motor intacto');
check('LIVE_TRADING_ENABLED no está puesta en el entorno de este test',
  process.env.LIVE_TRADING_ENABLED !== 'true');
check('paperTrader.js no importa liveTrader ni lee LIVE_TRADING_ENABLED (las menciones en comentarios no cuentan)',
  !paperTraderSrc.includes("require('./liveTrader')") && !paperTraderSrc.includes('require("./liveTrader")')
  && !paperTraderSrc.includes('process.env.LIVE_TRADING_ENABLED'));
check('paperTrader.js no tiene ningún POST a Kalshi (sin events/orders, sin method POST, sin fetch directo)',
  !paperTraderSrc.includes('events/orders') && !paperTraderSrc.includes("method: 'POST'")
  && !paperTraderSrc.includes('method: "POST"') && !/[^a-zA-Z]fetch\(/.test(paperTraderSrc));
check('paperTrader.js reutiliza paperAuditor (comisión, TWAP, descubrir, quote) y brti',
  paperTraderSrc.includes("require('./paperAuditor')") && paperTraderSrc.includes("require('./brti')")
  && paperTraderSrc.includes('calcularComisionPorContrato') && paperTraderSrc.includes('descubrirProximoContrato')
  && paperTraderSrc.includes('obtenerQuoteContrato'));
check('paperAuditor.js intacto (sha256 del baseline)',
  sha256('server/paperAuditor.js') === HASH_PAPER_AUDITOR);
check('liveTrader.js intacto (sha256 del baseline)',
  sha256('server/liveTrader.js') === HASH_LIVE_TRADER);
check('motor del cliente intacto (kalshi.js, analysis.js, verdict.js, windowOutcome.js)',
  Object.entries(HASH_MOTOR).every(([p, h]) => sha256(p) === h));
check('VERSION.txt está en v16.7 (el trabajo del cliente actualiza la versión)',
  src('VERSION.txt').startsWith('v16.7'));
check('routes.js cablea GET/POST /kalshi/paper-trader y el hook cev_paper_trades',
  routesSrc.includes("'/kalshi/paper-trader'") && routesSrc.includes('paperTrader.getSnapshot')
  && routesSrc.includes('paperTrader.startTrader') && routesSrc.includes('paperTrader.stopTrader')
  && routesSrc.includes("paperTrader.setPersistencia") && routesSrc.includes("'cev_paper_trades'"));
check('el motor no menciona el trader (kalshi.js, analysis.js, verdict.js, windowOutcome.js)',
  motor.every((m) => !m.includes('paperTrader') && !m.includes('paper-trader')));

console.log('v16.6 — 7. HTTP real: health, auth del trader, snapshot');
process.env.JWT_SECRET = 'test-jwt-secret-v16-6';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.LIVE_TRADING_ENABLED;
process.env.ADMIN_EMAIL = 'admin@ejemplo.com';
process.env.ADMIN_PASSWORD = 'AdminPass123';
const dbFile = path.join(ROOT, 'server', 'data', 'db.json');
const bak = existsSync(dbFile) ? readFileSync(dbFile) : null;
if (existsSync(dbFile)) unlinkSync(dbFile);

let server = null;
try {
  const app = require('./server/app.js');
  const db = require('./server/db.js');
  await sleep(800); // init() de routes en segundo plano (db.init + admin por env)
  await db.createUser({ email: 'user@ejemplo.com', passwordHash: await hashPassword('UserPass123'), name: 'User', role: 'user' });
  server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, extra = {}) => fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.1', ...(extra.headers || {}) },
    body: JSON.stringify(body),
  });
  const get = (p, extra = {}) => fetch(base + p, {
    headers: { 'X-Forwarded-For': '10.0.0.1', ...(extra.headers || {}) },
  });
  const jsonDe = async (r) => { try { return await r.json(); } catch { return {}; } };

  const rHealth = await get('/api/health');
  check('HTTP: GET /api/health 200 {ok:true}',
    rHealth.status === 200 && (await jsonDe(rHealth)).ok === true);
  const rLogin = await post('/api/auth/login', { email: 'user@ejemplo.com', password: 'UserPass123' });
  const tokenUser = (await jsonDe(rLogin)).token;
  check('HTTP: login del usuario de prueba (200 + token)',
    rLogin.status === 200 && typeof tokenUser === 'string');
  const rSinToken = await get('/api/kalshi/paper-trader');
  check('HTTP: GET /api/kalshi/paper-trader sin token → 401',
    rSinToken.status === 401);
  const rSnap = await get('/api/kalshi/paper-trader', { headers: { Authorization: `Bearer ${tokenUser}` } });
  const snapHttp = await jsonDe(rSnap);
  check('HTTP: GET con token y sin Kalshi → 200, kalshiConnected:false, enabled:false',
    rSnap.status === 200 && snapHttp.kalshiConnected === false && snapHttp.enabled === false);
  check('HTTP: el snapshot trae la forma exacta (enabled, contrato, posicionAbierta, trades, stats, ultimoError)',
    rSnap.status === 200 && 'enabled' in snapHttp && 'contrato' in snapHttp
    && 'posicionAbierta' in snapHttp && Array.isArray(snapHttp.trades)
    && snapHttp.stats && typeof snapHttp.stats === 'object' && 'ultimoError' in snapHttp
    && ['trades', 'ganados', 'pnlTotalUsd', 'pnlConSalidasUsd', 'pnlManteniendoUsd'].every((k) => k in snapHttp.stats),
    JSON.stringify(Object.keys(snapHttp.stats || {})));
  const rStart = await post('/api/kalshi/paper-trader/start', {}, { headers: { Authorization: `Bearer ${tokenUser}` } });
  check('HTTP: POST /kalshi/paper-trader/start sin Kalshi → 400',
    rStart.status === 400);
  const rStartSinToken = await post('/api/kalshi/paper-trader/start', {});
  check('HTTP: POST /kalshi/paper-trader/start sin token → 401',
    rStartSinToken.status === 401);
  const rStop = await post('/api/kalshi/paper-trader/stop', {}, { headers: { Authorization: `Bearer ${tokenUser}` } });
  const stopHttp = await jsonDe(rStop);
  check('HTTP: POST /kalshi/paper-trader/stop con token → 200 {ok:true}, enabled:false',
    rStop.status === 200 && stopHttp.ok === true && stopHttp.enabled === false);
} finally {
  if (server) await new Promise((r) => server.close(r));
  if (bak) writeFileSync(dbFile, bak);
  else if (existsSync(dbFile)) unlinkSync(dbFile);
}

console.log('v16.6 — 8. Tick real: ventana completa en papel (entrada → lock roto → liquidación)');
{
  const { crearEstadoTrader, startTrader, stopTrader, tickTrader, finalizarLiquidacion, getSnapshot, _traders } = pt;
  const limpiar = (uid) => { _traders.delete(uid); };
  const persistCalls = [];
  pt.setPersistencia(async (uid, estado) => {
    persistCalls.push({ uid, estado: JSON.parse(JSON.stringify(estado)) });
  });

  // 8a. Entrada por EV, salida por lock roto, sin re-entrada, y el
  // P&L con salida difiere del de mantener hasta liquidación.
  {
    const u = 999601;
    const base = (Math.floor(Date.now() / 1000) + 5) * 1000;
    const closeMs = base + 65 * 1000;
    const ticker = 'KXBTC15M-TEST-TRADER-A';
    const contrato = { ticker, targetPrice: 100000, closeMs, closeIso: 'x' };
    // Precio 100500 en las primeras muestras (TWAP $500 por encima del
    // target) y 100010 después: el salto queda ≈ −100, dentro del
    // bloqueo (≤ −95) para el SÍ. Con salto −12 el bloqueo ya estaría
    // roto y la posición no se sostendría ni un tick.
    let precioActual = 100500;
    // Bid 0.82 al entrar: neto 0.8097, entre el stop (0.4056) y la
    // ganancia (0.8312): no sale por (b) ni por (c) mientras el
    // bloqueo aguanta. En t=20 pasa a 0.30, para que el refetch de
    // ese segundo capture el bid bajo y la salida del t=21 lo use.
    let bidActual = 0.82;
    let relojMs = base;
    const deps = {
      brtiState: () => ({ value: precioActual, avg60s: null, avg15mFinal: null, updatedAt: new Date(relojMs).toISOString(), status: 'connected', error: null }),
      descubrir: async () => contrato,
      quote: async () => ({ ticker, status: 'active', result: null, expirationValue: null, yesAskDollars: 0.80, yesBidDollars: bidActual, noAskDollars: +(1 - bidActual).toFixed(2) }),
    };
    const est = crearEstadoTrader();
    est.enabled = true;
    _traders.set(u, est);
    let snap = null;
    for (let t = 0; t <= 13; t++) {
      relojMs = base + t * 1000;
      snap = await tickTrader(u, relojMs, deps);
      await sleep(5); // deja aterrizar la quote pedida en paralelo
    }
    check('tick: tras ~13 s en el minuto final hay posición abierta SÍ a $0.80 (costo $0.8112)',
      snap.posicionAbierta && snap.posicionAbierta.lado === 'yes'
      && snap.posicionAbierta.askEntrada === 0.8 && snap.posicionAbierta.costoTotal === 0.8112
      && snap.entradasHoy === 1,
      JSON.stringify(snap.posicionAbierta));
    check('tick: la entrada se persistió (hook llamado con la posición abierta)',
      persistCalls.some((c) => c.uid === u && c.estado.posicionAbierta && c.estado.posicionAbierta.ticker === ticker));
    precioActual = 100010; // el precio baja al nivel del target, el bloqueo aguanta (salto ≈ −100)
    for (let t = 14; t <= 19; t++) {
      relojMs = base + t * 1000;
      snap = await tickTrader(u, relojMs, deps);
      await sleep(5);
    }
    check('tick: con el bloqueo intacto la posición se mantiene (sin salida por ganancia ni stop)',
      snap.posicionAbierta && snap.posicionAbierta.ticker === ticker && snap.trades.length === 0);
    bidActual = 0.30; // el refetch de t=20 captura el bid bajo
    relojMs = base + 20 * 1000;
    snap = await tickTrader(u, relojMs, deps);
    await sleep(5);
    check('tick: en t=20, sin caída aún, sigue abierta (el bid bajo por sí solo no vende)',
      snap.posicionAbierta && snap.posicionAbierta.ticker === ticker);
    // El precio cae por debajo del target: el bloqueo se rompe.
    precioActual = 99900;
    for (let t = 21; t <= 30; t++) {
      relojMs = base + t * 1000;
      snap = await tickTrader(u, relojMs, deps);
      await sleep(5);
    }
    check('tick: tras la caída sale por lock_roto (no por stop, aunque el neto también lo tocaría) y no re-entra',
      snap.posicionAbierta === null && snap.trades.length === 1
      && snap.trades[0].motivoSalida === 'lock_roto' && snap.entradasHoy === 1,
      JSON.stringify(snap.trades[0]));
    check('tick: P&L de salida −0.5259 (neto 0.2853 − costo 0.8112) y holdPnl aún pendiente',
      approx(snap.trades[0].pnlUsd, -0.5259, 1e-4) && snap.trades[0].holdPnlUsd === null,
      `pnl=${snap.trades[0].pnlUsd} hold=${snap.trades[0].holdPnlUsd}`);
    for (let t = 31; t <= 65; t++) {
      relojMs = base + t * 1000;
      snap = await tickTrader(u, relojMs, deps);
      await sleep(5);
    }
    check('tick: al cerrar la ventana el trade sigue con holdPnl pendiente y no hay segunda entrada',
      snap.trades.length === 1 && snap.trades[0].holdPnlUsd === null && snap.entradasHoy === 1
      && snap.stats.holdPendientes === 1);
    const sinRes = await finalizarLiquidacion(u, { ticker, oficial: { result: null, expirationValue: null } });
    check('finalizarLiquidacion sin resultado oficial no toca nada (ok:false)',
      sinRes.ok === false && getSnapshot(u).trades[0].holdPnlUsd === null);
    const fin = await finalizarLiquidacion(u, { ticker, oficial: { result: 'yes', expirationValue: 100005 } });
    snap = getSnapshot(u);
    check('finalizarLiquidacion con resultado YES: holdPnl +0.1888 (mantener habría ganado) ≠ P&L de salida −0.5259',
      fin.ok === true && fin.actualizados === 1
      && approx(snap.trades[0].holdPnlUsd, 0.1888, 1e-4)
      && approx(snap.trades[0].pnlUsd, -0.5259, 1e-4)
      && snap.stats.pnlConSalidasUsd !== snap.stats.pnlManteniendoUsd
      && approx(snap.stats.pnlConSalidasUsd, -0.5259, 1e-4)
      && approx(snap.stats.pnlManteniendoUsd, 0.1888, 1e-4),
      JSON.stringify(snap.stats));
    check('tick: la salida y la liquidación se persistieron',
      persistCalls.filter((c) => c.uid === u).length >= 3);
    limpiar(u);
  }

  // 8b. Posición mantenida hasta el cierre: pasa a pendiente de
  // liquidación (neto por encima del costo en R≤3 → no vende por
  // fin de ventana) y se liquida al llegar el resultado oficial.
  {
    const u = 999602;
    const base = (Math.floor(Date.now() / 1000) + 5) * 1000;
    const closeMs = base + 65 * 1000;
    const ticker = 'KXBTC15M-TEST-TRADER-B';
    const contrato = { ticker, targetPrice: 100000, closeMs, closeIso: 'x' };
    // Mismo bloqueo que en 8a (muestras a 100500, luego 100010): el
    // salto queda ≈ −100 y el bloqueo del SÍ aguanta toda la ventana.
    let precioActual = 100500;
    let relojMs = base;
    const deps = {
      brtiState: () => ({ value: precioActual, avg60s: null, avg15mFinal: null, updatedAt: new Date(relojMs).toISOString(), status: 'connected', error: null }),
      descubrir: async () => contrato,
      quote: async () => ({ ticker, status: 'active', result: null, expirationValue: null, yesAskDollars: 0.85, yesBidDollars: 0.87, noAskDollars: 0.13 }),
    };
    const est = crearEstadoTrader();
    est.enabled = true;
    _traders.set(u, est);
    let snap = null;
    for (let t = 0; t <= 13; t++) {
      relojMs = base + t * 1000;
      snap = await tickTrader(u, relojMs, deps);
      await sleep(5);
    }
    precioActual = 100010;
    for (let t = 14; t <= 65; t++) {
      relojMs = base + t * 1000;
      snap = await tickTrader(u, relojMs, deps);
      await sleep(5);
    }
    check('tick: posición mantenida hasta el cierre → pendiente-liquidacion, sin P&L aún',
      snap.posicionAbierta === null && snap.trades.length === 1
      && snap.trades[0].estado === 'pendiente-liquidacion' && snap.trades[0].pnlUsd === null
      && snap.stats.pendientesLiquidacion === 1,
      JSON.stringify(snap.trades[0]));
    const fin = await finalizarLiquidacion(u, { ticker, oficial: { result: 'yes', expirationValue: 100005 } });
    snap = getSnapshot(u);
    check('finalizarLiquidacion YES liquida la posición: P&L +0.1411 (1 − costo 0.8589)',
      fin.ok === true && snap.trades[0].estado === 'cerrado'
      && approx(snap.trades[0].pnlUsd, 0.1411, 1e-4)
      && approx(snap.trades[0].holdPnlUsd, 0.1411, 1e-4)
      && snap.stats.trades === 1 && snap.stats.ganados === 1,
      JSON.stringify(snap.stats));
    limpiar(u);
  }

  // 8c. startTrader restaura trades y posición; si el contrato nuevo
  // es otro ticker, la posición restaurada pasa a pendiente.
  {
    const u = 999603;
    const hoy = new Date().toISOString().slice(0, 10);
    const snapStart = startTrader(u, {
      trades: [],
      posicionAbierta: {
        ticker: 'KXBTC15M-VIEJO', lado: 'yes', targetPrice: 100000,
        askEntrada: 0.8, feeEntrada: 0.0112, costoTotal: 0.8112,
        enteredAt: new Date().toISOString(), segundosRestantesEntrada: 30,
        pEstimada: 0.99, evEstimada: 0.18, brtiEntrada: 100010,
      },
      day: hoy, entradasHoy: 1,
    });
    check('startTrader restaura la posición abierta y el contador del día',
      snapStart.enabled === true && snapStart.posicionAbierta
      && snapStart.posicionAbierta.ticker === 'KXBTC15M-VIEJO' && snapStart.entradasHoy === 1);
    const base = (Math.floor(Date.now() / 1000) + 5) * 1000;
    const deps = {
      brtiState: () => ({ value: 100010, avg60s: null, avg15mFinal: null, updatedAt: new Date(base).toISOString(), status: 'connected', error: null }),
      descubrir: async () => ({ ticker: 'KXBTC15M-NUEVO', targetPrice: 100000, closeMs: base + 65 * 1000, closeIso: 'x' }),
      quote: async (t) => ({ ticker: t, status: 'settled', result: 'no', expirationValue: 99990, yesAskDollars: 0.8, yesBidDollars: 0.79, noAskDollars: 0.2 }),
    };
    const snap = await tickTrader(u, base, deps);
    check('tick con otro ticker: la posición restaurada pasa a pendiente-liquidacion',
      snap.posicionAbierta === null && snap.trades.length === 1
      && snap.trades[0].ticker === 'KXBTC15M-VIEJO'
      && snap.trades[0].estado === 'pendiente-liquidacion');
    const fin = await finalizarLiquidacion(u, { ticker: 'KXBTC15M-VIEJO', oficial: { result: 'no', expirationValue: 99990 } });
    const snap2 = getSnapshot(u);
    check('finalizarLiquidacion NO: la posición SÍ pierde −0.8112',
      fin.ok === true && approx(snap2.trades[0].pnlUsd, -0.8112, 1e-4));
    const snapStop = await stopTrader(u);
    check('stopTrader apaga y persiste (enabled:false)',
      snapStop.enabled === false
      && persistCalls.some((c) => c.uid === u && c.estado.trades.length === 1));
    limpiar(u);
  }
}

console.log(`\ntests-v16.6.mjs: ${pass} pasaron, ${fail} fallaron.`);
process.exit(fail ? 1 : 0);
