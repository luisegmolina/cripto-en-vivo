// tests-v16.3.mjs — Arranque auto + watchdog + historial (v16.3).
// NADA de esto envía órdenes reales ni toca la red de Kalshi: el WS
// BRTI se prueba con conexiones falsas en memoria y la cotización con
// stubs. Sin credenciales reales en ningún test.
// Uso: node tests-v16.3.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const auditor = require('./server/paperAuditor.js');
const brti = require('./server/brti.js');
const routes = require('./server/routes.js');
const trader = require('./server/liveTrader.js');
const {
  crearEstadoAuditor, startAuditor, stopAuditor, getSnapshot, tickAuditor,
  calcularStats, compactarRegistro, actualizarHistorial, evaluarSenalConQuote,
  setAutostart, isAutostart, setPersistenciaHistorial,
  MAX_RESULTADOS, _auditors,
} = auditor;
const { verificarVariablesArranque, registroCerrado } = routes;

const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const app = src('client/src/App.jsx');
const kalshiConnectJsx = src('client/src/KalshiConnect.jsx');
const paperAuditJsx = src('client/src/components/PaperAudit.jsx');
const auditorSrc = src('server/paperAuditor.js');
const brtiSrc = src('server/brti.js');
const routesSrc = src('server/routes.js');
const appJs = src('server/app.js');
const dbSrc = src('server/db.js');
const schemaSql = src('server/schema.sql');
const versionTxt = src('VERSION.txt');
const motor = ['client/src/kalshi.js', 'client/src/analysis.js', 'client/src/verdict.js', 'client/src/windowOutcome.js'].map(src);

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const cerca = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const limpiar = (uid) => { _auditors.delete(uid); };
const uid = (n) => 163000 + n;

console.log('v16.3 — 1. Arranque automático: flag por usuario (default false)');
{
  const est = crearEstadoAuditor();
  check('el estado nuevo trae autostart=false por defecto (nunca true)',
    est.autostart === false && est.historial.length === 0);
  const u = uid(1);
  check('isAutostart=false sin estado', isAutostart(u) === false);
  check('setAutostart(true) lo activa', setAutostart(u, true) === true && isAutostart(u) === true);
  check('setAutostart con valor no booleano no lo activa', setAutostart(u, 'yes') === false && isAutostart(u) === false);
  check('setAutostart(false) lo apaga', setAutostart(u, true) === true && setAutostart(u, false) === false && isAutostart(u) === false);
  limpiar(u);
}
{
  // startAuditor no resetea el flag (el toggle sobrevive a arranques).
  const u = uid(2);
  setAutostart(u, true);
  const snap = startAuditor(u);
  check('startAuditor conserva autostart=true', snap.autostart === true);
  await stopAuditor(u);
  check('stopAuditor no apaga el flag', isAutostart(u) === true);
  limpiar(u);
}
check('routes.js tiene POST /kalshi/paper-audit/autostart (JWT) que persiste el flag en paper_audit_settings',
  routesSrc.includes("router.post('/kalshi/paper-audit/autostart'") && routesSrc.includes("'paper_audit_settings'") && routesSrc.includes('paperAuditor.setAutostart'));
check('routes.js: init() llama a arrancarAutostart() tras db.init (arranque del servidor)',
  routesSrc.includes('await arrancarAutostart();') && routesSrc.indexOf('await arrancarAutostart();') > routesSrc.indexOf('await db.init();'));
check('arrancarAutostart es fail-closed por usuario: sin conexión o sin descifrado registra el motivo y sigue (nunca tumba el arranque)',
  routesSrc.includes('autostart activo pero sin conexión Kalshi, no arranca') && routesSrc.includes('no se pudo descifrar la clave de Kalshi, no arranca'));
check('arrancarAutostart abre el WS BRTI y arranca el auditor con la clave descifrada',
  routesSrc.includes('brti.ensureBrti(u.id, { keyId: conn.keyId, privateKeyPem })') && routesSrc.includes('paperAuditor.startAuditor('));
check('PaperAudit.jsx (§6) tiene el toggle de arranque automático que llama a la ruta',
  paperAuditJsx.includes('/api/kalshi/paper-audit/autostart') && paperAuditJsx.includes('Arranque automático al reiniciar el servidor'));
check('DELETE /kalshi/connect apaga el flag (desconectar no deja un autostart huérfano)',
  routesSrc.includes('paperAuditor.setAutostart(req.user.id, false);'));

console.log('v16.3 — 2. Watchdog del WebSocket BRTI');
{
  const ahora = Date.now();
  const conTick = { ws: { terminate() {} }, lastTickAt: ahora - 5000, connectedAt: ahora - 60000 };
  const sinTick = { ws: { terminate() {} }, lastTickAt: ahora - 11000, connectedAt: ahora - 60000 };
  const sinTickNunca = { ws: { terminate() {} }, lastTickAt: null, connectedAt: ahora - 16000 };
  const recienConectado = { ws: { terminate() {} }, lastTickAt: null, connectedAt: ahora - 5000 };
  check('debeReiniciarWatchdog: 5 s sin tick -> NO reinicia', brti.debeReiniciarWatchdog(conTick, ahora) === false);
  check('debeReiniciarWatchdog: 11 s sin tick -> SÍ reinicia (>10 s)', brti.debeReiniciarWatchdog(sinTick, ahora) === true);
  check('debeReiniciarWatchdog: 16 s conectado sin ningún tick -> SÍ reinicia (gracia 15 s)', brti.debeReiniciarWatchdog(sinTickNunca, ahora) === true);
  check('debeReiniciarWatchdog: 5 s conectado sin tick -> NO reinicia (dentro de la gracia)', brti.debeReiniciarWatchdog(recienConectado, ahora) === false);
  check('debeReiniciarWatchdog: sin ws -> NO reinicia', brti.debeReiniciarWatchdog({ lastTickAt: ahora - 99999 }, ahora) === false);
}
{
  // revisarWatchdog con una conexión falsa: termina el ws y marca error.
  const u = uid(3);
  let terminadas = 0;
  const entry = {
    ws: { terminate() { terminadas++; } },
    state: { status: 'connected', error: null, lastPollAt: Date.now(), value: 63000, updatedAt: new Date().toISOString() },
    backoffMs: 1000,
    reconnectTimer: null,
    creds: {},
    lastTickAt: Date.now() - 11000,
    connectedAt: Date.now() - 60000,
  };
  brti._connections.set(u, entry);
  brti.revisarWatchdog();
  check('revisarWatchdog termina el ws tras 10 s sin tick', terminadas === 1);
  check('revisarWatchdog marca status error con el motivo', entry.state.status === 'error' && /Sin ticks BRTI en 10 s/.test(entry.state.error || ''));
  brti._connections.delete(u);
}
{
  // El estado visible no miente: tick viejo -> 'stale', no 'connected'.
  const u = uid(4);
  const entry = {
    ws: { terminate() {} },
    state: { status: 'connected', error: null, lastPollAt: Date.now(), value: 63000, updatedAt: new Date().toISOString() },
    backoffMs: 1000,
    reconnectTimer: null,
    creds: {},
    lastTickAt: Date.now() - 11000,
    connectedAt: Date.now() - 60000,
  };
  brti._connections.set(u, entry);
  const st = brti.getBrtiState(u);
  check('getBrtiState con tick de hace 11 s reporta status stale (no connected)', st && st.status === 'stale');
  entry.lastTickAt = Date.now();
  const st2 = brti.getBrtiState(u);
  check('getBrtiState con tick fresco sigue en connected', st2 && st2.status === 'connected');
  brti._connections.delete(u);
}
check("el handler de 'error' del WS programa reconexión (antes solo ponía status error)",
  /ws\.on\('error'[\s\S]{0,400}scheduleReconnect\(userId, entry\)/.test(brtiSrc));
check("el handler de 'close' del WS programa reconexión (es el que dispara el watchdog al terminar)",
  /ws\.on\('close'[\s\S]{0,400}scheduleReconnect\(userId, entry\)/.test(brtiSrc));

console.log('v16.3 — 3. Muestreo desacoplado de la cotización');
{
  // 3a. Quote lenta (300 ms) en R=20..16: los ticks no esperan y no
  // se pierde ninguna muestra; la señal llega con la quote en caché.
  const u = uid(5);
  const base = Date.now();
  const closeMs = base + 15 * 60 * 1000;
  const est = crearEstadoAuditor();
  est.enabled = true;
  est.contrato = { ticker: 'KXBTC15M-TEST-T63000.00', targetPrice: 63000, closeMs, closeIso: 'x' };
  _auditors.set(u, est);
  let ahoraSim = 0;
  let quoteCalls = 0;
  const deps = {
    brtiState: () => ({ value: 62900, avg60s: 62900, avg15mFinal: null, updatedAt: new Date(ahoraSim).toISOString(), status: 'connected', error: null }),
    quote: async () => { quoteCalls++; await sleep(300); return { ticker: 'KXBTC15M-TEST-T63000.00', status: 'active', result: null, expirationValue: null, yesAskDollars: 0.80, yesBidDollars: 0.79, noAskDollars: 0.20 }; },
  };
  const t0 = Date.now();
  for (let r = 60; r >= 16; r--) {
    ahoraSim = closeMs - r * 1000;
    await tickAuditor(u, ahoraSim, deps);
  }
  const elapsed = Date.now() - t0;
  const snap = getSnapshot(u);
  check('45 ticks (R=60..16) con quote de 300 ms terminan en <1 s real (la quote no bloquea el muestreo)',
    elapsed < 1000, `tardó ${elapsed} ms`);
  check('las 45 muestras están (una por segundo, ticksPerdidos 0)',
    est.muestras.size === 45 && snap.ticksPerdidos === 0, `muestras=${est.muestras.size} perdidos=${snap.ticksPerdidos}`);
  check('la quote solo se pidió una vez (en vuelo, sin duplicados)', quoteCalls === 1);
  check('sin señal todavía: la quote aún no aterrizó (R=20 estaba fuera de 18..3)', est.simulacion === null);
  await sleep(400); // la quote aterriza; su R de pedido era 20 (fuera de rango)
  check('al aterrizar la quote pedida en R=20 no se evalúa (fuera de T-18..T-3)', est.simulacion === null && est.quoteActual != null);
  ahoraSim = closeMs - 15 * 1000;
  await tickAuditor(u, ahoraSim, deps); // R=15, quote en caché y fresca
  check('tick en R=15 con la quote ya en caché registra la señal NO viable (TWAP 62900 vs objetivo 63000)',
    est.simulacion && est.simulacion.direccionElegida === 'no' && est.simulacion.viableDespuesDeComision === true);
  limpiar(u);
}
{
  // 3b. Quote que nunca resuelve: el muestreo sigue segundo a segundo.
  const u = uid(6);
  const base = Date.now();
  const closeMs = base + 15 * 60 * 1000;
  const est = crearEstadoAuditor();
  est.enabled = true;
  est.contrato = { ticker: 'KXBTC15M-TEST-T63000.00', targetPrice: 63000, closeMs, closeIso: 'x' };
  _auditors.set(u, est);
  let ahoraSim = 0;
  const deps = {
    brtiState: () => ({ value: 62900, avg60s: 62900, avg15mFinal: null, updatedAt: new Date(ahoraSim).toISOString(), status: 'connected', error: null }),
    quote: async () => new Promise(() => {}), // cuelga para siempre
  };
  const t0 = Date.now();
  for (let r = 60; r >= 10; r--) {
    ahoraSim = closeMs - r * 1000;
    await tickAuditor(u, ahoraSim, deps);
  }
  const elapsed = Date.now() - t0;
  const snap = getSnapshot(u);
  check('51 ticks (R=60..10) con quote colgada terminan en <1 s real',
    elapsed < 1000, `tardó ${elapsed} ms`);
  check('las 51 muestras están y ticksPerdidos sigue en 0 (la quote colgada no salta segundos)',
    est.muestras.size === 51 && snap.ticksPerdidos === 0, `muestras=${est.muestras.size} perdidos=${snap.ticksPerdidos}`);
  check('sin quote no hay señal (no se inventa ninguna)', est.simulacion === null && est.quoteActual === null);
  limpiar(u);
}
{
  // 3c. evaluarSenalConQuote: evalúa al llegar la quote con el estado
  // actual; fuera de T-18..T-3 o con quote vieja no evalúa.
  const est = crearEstadoAuditor();
  est.enabled = true;
  est.contrato = { ticker: 'KXBTC15M-TEST-T63000.00', targetPrice: 63000, closeMs: (Math.floor(Date.now() / 1000) + 10) * 1000, closeIso: 'x' };
  for (let i = 1; i <= 50; i++) est.muestras.set(Math.floor(Date.now() / 1000) - i, 62900);
  est.ultimoBrti = { value: 62900 };
  const q = { ticker: 'KXBTC15M-TEST-T63000.00', yesAskDollars: 0.80, noAskDollars: 0.20, fetchedAt: Date.now() };
  const sim = evaluarSenalConQuote(est, q, Date.now());
  check('evaluarSenalConQuote en T-10 con 51 muestras registra la señal NO viable',
    sim && sim.direccionElegida === 'no' && sim.viableDespuesDeComision === true && est.simulacion === sim);
  const est2 = crearEstadoAuditor();
  est2.enabled = true;
  est2.contrato = { ticker: 'KXBTC15M-TEST-T63000.00', targetPrice: 63000, closeMs: (Math.floor(Date.now() / 1000) + 30) * 1000, closeIso: 'x' };
  est2.muestras.set(1, 62900);
  est2.ultimoBrti = { value: 62900 };
  check('evaluarSenalConQuote en T-30 no evalúa (fuera de la ventana 18..3)',
    evaluarSenalConQuote(est2, q, Date.now()) === null && est2.simulacion === null);
  const qVieja = { ...q, fetchedAt: Date.now() - 6000 };
  check('evaluarSenalConQuote con quote de hace 6 s no evalúa (frescura ≤5 s)',
    evaluarSenalConQuote(est2, qVieja, Date.now()) === null);
}

console.log('v16.3 — 4. Historial sin tope');
{
  const full = {
    ticker: 'KXBTC15M-TEST-T63000.00', targetPrice: 63000, twapLocal: 63010,
    brtiLiquidacionOficial: 63012, errorTwapVsOficial: -2, prediccionLocal: 'yes',
    resultadoOficialKalshi: 'yes', simulacion: { direccionElegida: 'yes', viableDespuesDeComision: true },
    closedAt: '2026-11-18T18:00:00.000Z',
  };
  check('compactarRegistro(null) -> null', compactarRegistro(null) === null);
  const c = compactarRegistro(full);
  check('compactarRegistro guarda solo los campos mínimos (ticker, objetivo, TWAP, oficial, error, predicción, señal, viable)',
    c && c.ticker === full.ticker && c.targetPrice === 63000 && c.twapLocal === 63010 &&
    c.brtiLiquidacionOficial === 63012 && c.errorTwapVsOficial === -2 && c.prediccionLocal === 'yes' &&
    c.senal === 'yes' && c.viable === true && c.closedAt === full.closedAt &&
    !('muestras' in c) && !('simulacion' in c));
  let hist = [];
  for (let i = 0; i < 25; i++) hist = actualizarHistorial(hist, { ...full, closedAt: `2026-11-18T18:${String(i).padStart(2, '0')}:00.000Z` });
  check('actualizarHistorial crece más allá de 20 (25 ventanas, sin tope)', hist.length === 25);
  hist = actualizarHistorial(hist, { ...full, twapLocal: 63099, closedAt: '2026-11-18T18:00:00.000Z' });
  check('misma ventana (ticker+closedAt) actualiza en su sitio, no duplica',
    hist.length === 25 && hist.find((r) => r.closedAt === '2026-11-18T18:00:00.000Z').twapLocal === 63099);
  hist = actualizarHistorial(hist, { ...full, closedAt: '2026-11-18T19:00:00.000Z' });
  check('ventana nueva sí se añade', hist.length === 26);
}
{
  // Stats sobre TODO el historial (30 compactas), no solo las últimas 20.
  const hist = [];
  for (let i = 0; i < 30; i++) {
    const acierto = i < 15; // 15 aciertos, 5 fallos en viables
    hist.push({
      ticker: 'KXBTC15M-TEST', targetPrice: 63000, twapLocal: 62900, brtiLiquidacionOficial: 62900 + i,
      errorTwapVsOficial: i, prediccionLocal: i < 20 ? 'no' : null,
      resultadoOficialKalshi: i < 20 ? (acierto ? 'no' : 'yes') : 'pendiente',
      senal: i < 20 ? 'no' : null, viable: i < 20 ? true : null,
      closedAt: `2026-11-18T18:${String(i).padStart(2, '0')}:00.000Z`,
    });
  }
  const s = calcularStats(hist);
  check('calcularStats sobre 30 compactas: ventanas 30, señales 20, viables 20',
    s.ventanas === 30 && s.senales === 20 && s.viables === 20);
  check('acierto en viables 15/20 sobre todo el historial', s.viablesLiquidadas === 20 && s.aciertosEnViables === 15);
  check('MAE $14.50 y error máximo $29.00 sobre todo el historial',
    cerca(s.errorMedioAbsUSD, 14.5) && cerca(s.errorMaxAbsUSD, 29));
  check('predicción local 15/20 sobre todo el historial', s.prediccionCorrecta === 15 && s.prediccionTotal === 20);
}
{
  // startAuditor siembra el historial desde los resultados (25 -> 25,
  // aunque la vista solo guarda 20) y lo acepta explícito (30 -> 30).
  const u = uid(7);
  const resultados = [];
  for (let i = 0; i < 25; i++) {
    resultados.push({
      ticker: 'KXBTC15M-TEST', targetPrice: 63000, twapLocal: 62900, brtiLiquidacionOficial: 62900,
      errorTwapVsOficial: 0, prediccionLocal: 'no', resultadoOficialKalshi: 'no',
      simulacion: { direccionElegida: 'no', viableDespuesDeComision: true },
      closedAt: `2026-11-18T18:${String(i).padStart(2, '0')}:00.000Z`,
    });
  }
  const snap = startAuditor(u, resultados, []);
  check('startAuditor con 25 resultados: la vista guarda 20 pero el historial siembra 25',
    snap.resultados.length === 20 && snap.historialTotal === 25 && snap.stats.ventanas === 25,
    `resultados=${snap.resultados.length} historial=${snap.historialTotal} ventanas=${snap.stats.ventanas}`);
  await stopAuditor(u);
  limpiar(u);
  const u2 = uid(8);
  const hist = [];
  for (let i = 0; i < 30; i++) hist.push({ ticker: 'KXBTC15M-TEST', targetPrice: 63000, twapLocal: 62900, brtiLiquidacionOficial: 62900, errorTwapVsOficial: 1, prediccionLocal: 'no', resultadoOficialKalshi: 'no', senal: 'no', viable: true, closedAt: `2026-11-18T18:${String(i).padStart(2, '0')}:00.000Z` });
  const snap2 = startAuditor(u2, [], hist);
  check('startAuditor con historial explícito de 30: historialTotal 30 y stats sobre 30',
    snap2.historialTotal === 30 && snap2.stats.ventanas === 30);
  await stopAuditor(u2);
  limpiar(u2);
}
{
  // El hook de persistencia del historial se llama al detener.
  const u = uid(9);
  let guardado = null;
  setPersistenciaHistorial(async (_uid, h) => { guardado = h; });
  const snap = startAuditor(u, [], [{ ticker: 'KXBTC15M-TEST', targetPrice: 63000, twapLocal: 62900, brtiLiquidacionOficial: 62900, errorTwapVsOficial: 0, prediccionLocal: 'no', resultadoOficialKalshi: 'no', senal: 'no', viable: true, closedAt: '2026-11-18T18:00:00.000Z' }]);
  await stopAuditor(u);
  check('stopAuditor persiste el historial (hook llamado con la lista)',
    Array.isArray(guardado) && guardado.length === 1 && guardado[0].ticker === 'KXBTC15M-TEST');
  setPersistenciaHistorial(null);
  limpiar(u);
  check('db.js y schema.sql admiten el kind cev_paper_windows (CHECK + migración)',
    dbSrc.includes("'cev_paper_windows'") && schemaSql.includes("'cev_paper_windows'"));
  check('§6 muestra el total de ventanas en el historial',
    paperAuditJsx.includes('Historial total:') && paperAuditJsx.includes('historialTotal'));
}

console.log('v16.3 — 5. Textos "solo lectura" corregidos');
check('App.jsx: el banner ya no dice solo lectura a secas; dice que MIENTRAS live esté apagado no opera y que con live encendido y armado sí puede',
  app.includes('APAGADO (§7)') && app.includes('sí puede enviar órdenes'));
check('App.jsx: el banner ya no contiene la frase vieja de solo lectura absoluta',
  !/esta app es de solo lectura y nunca opera por ti/i.test(app));
check('KalshiConnect.jsx: ya no dice que la app nunca compra; dice que mientras el bot esté apagado no opera',
  !/esta app nunca compra/i.test(kalshiConnectJsx) && kalshiConnectJsx.includes('Mientras el bot en vivo (§7) esté'));
check('routes.js: el comentario ya no dice solo lectura a secas',
  routesSrc.includes('MIENTRAS el bot en vivo esté apagado'));

console.log('v16.3 — 6. Registro cerrado (cuenta única)');
{
  const vacia = { listUsers: async () => [] };
  const conUno = { listUsers: async () => [{ id: 1, email: 'a@b.c' }] };
  check('registroCerrado=false sin usuarios', (await registroCerrado(vacia)) === false);
  check('registroCerrado=true con un usuario', (await registroCerrado(conUno)) === true);
}
check('POST /auth/register devuelve 403 "El registro está cerrado" si ya existe algún usuario',
  routesSrc.includes("if (await registroCerrado(db)) return res.status(403).json({ error: 'El registro está cerrado: esta app es de un solo usuario.' })"));
check('init() sigue creando el admin con db.createUser directo (no por /auth/register)',
  routesSrc.includes("await db.createUser({ email: adminEmail") && routesSrc.indexOf('await db.createUser({ email: adminEmail') < routesSrc.indexOf("router.post('/auth/register'"));

console.log('v16.3 — 7. Arranque en producción: aborta sin secretos');
{
  const prodSinNada = { NODE_ENV: 'production' };
  const prodSoloJwt = { NODE_ENV: 'production', JWT_SECRET: 'secreto' };
  const prodHex = { NODE_ENV: 'production', JWT_SECRET: 'secreto', KALSHI_ENCRYPTION_KEY: 'a'.repeat(64) };
  const prodB64 = { NODE_ENV: 'production', JWT_SECRET: 'secreto', KALSHI_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
  const prodMala = { NODE_ENV: 'production', JWT_SECRET: 'secreto', KALSHI_ENCRYPTION_KEY: 'corta' };
  const devSinNada = { NODE_ENV: 'development' };
  const t = (env) => { try { verificarVariablesArranque(env); return null; } catch (e) { return e; } };
  const e1 = t(prodSinNada);
  check('producción sin JWT_SECRET aborta con MISSING_SECRETS', e1 && e1.code === 'MISSING_SECRETS' && /JWT_SECRET/.test(e1.message));
  const e2 = t(prodSoloJwt);
  check('producción sin KALSHI_ENCRYPTION_KEY aborta con MISSING_SECRETS', e2 && e2.code === 'MISSING_SECRETS' && /KALSHI_ENCRYPTION_KEY/.test(e2.message));
  const e3 = t(prodMala);
  check('producción con clave inválida (ni hex 64 ni base64 de 32 bytes) aborta', e3 && e3.code === 'MISSING_SECRETS');
  check('producción con JWT_SECRET + hex 64 arranca', verificarVariablesArranque(prodHex) === true);
  check('producción con JWT_SECRET + base64 de 32 bytes arranca', verificarVariablesArranque(prodB64) === true);
  check('DATABASE_URL sigue siendo OPCIONAL (arranca sin ella)', verificarVariablesArranque(prodHex) === true);
  check('en desarrollo no exige nada (no rompe el modo local)', verificarVariablesArranque(devSinNada) === true && verificarVariablesArranque({}) === true);
}
check('app.js sale del proceso (exit 1) solo con MISSING_SECRETS y solo fuera de Vercel',
  appJs.includes("e.code === 'MISSING_SECRETS'") && appJs.includes('process.exit(1)'));
check('init() llama a verificarVariablesArranque() antes de db.init()',
  routesSrc.includes('verificarVariablesArranque();') && routesSrc.indexOf('verificarVariablesArranque();') < routesSrc.indexOf('await db.init();'));

console.log('v16.3 — 8. Motor intacto, denominador intacto, live sigue apagado');
check('el motor (kalshi.js, analysis.js, verdict.js, windowOutcome.js) no menciona autostart ni live',
  motor.every((m) => !m.includes('autostart') && !m.includes('liveTrader') && !m.includes('LIVE_TRADING_ENABLED')));
check('la fórmula del denominador NO cambió: totalMuestrasEfectivas = N + (R-1)',
  auditorSrc.includes('const totalMuestrasEfectivas = muestrasCapturadas + segundosRestantesReales;'));
check('paperAuditor.js no lee la env LIVE_TRADING_ENABLED en código (solo la menciona en un comentario)',
  !auditorSrc.includes('process.env.LIVE_TRADING_ENABLED') && auditorSrc.includes('// EN PAPEL; sin la env LIVE_TRADING_ENABLED y sin armar, no sale'));
check('live sigue APAGADO por defecto (isLiveEnabled false sin la env)',
  trader.isLiveEnabled() === false);
check("VERSION_LABEL es 'v16.7 — PIN del dueño y §7 dinámico' (actualizado por diseño en v16.7)",
  app.includes("const VERSION_LABEL = 'v16.7 — PIN del dueño y §7 dinámico';"));
check('VERSION.txt documenta la v16.3 con sus 7 puntos',
  versionTxt.includes('v16.3 — Arranque auto + watchdog + historial') && versionTxt.includes('Arranque automático') && versionTxt.includes('Watchdog'));

console.log(`\ntests-v16.3.mjs: ${pass} pasaron, ${fail} fallaron.`);
process.exit(fail ? 1 : 0);
