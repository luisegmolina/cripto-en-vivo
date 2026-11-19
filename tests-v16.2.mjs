// tests-v16.2.mjs — Bot en vivo APAGADO por defecto (v16.2).
// NADA de esto envía órdenes reales: la red está stubbeada y las
// credenciales son una clave Ed25519 generada en el propio test.
// Uso: node tests-v16.2.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const trader = require('./server/liveTrader.js');
const auditor = require('./server/paperAuditor.js');
const {
  isLiveEnabled, calcularPerdidaPotencial, dayKey, crearEstadoTrader,
  resetDiaSiCambio, verificarLimites, evaluarDecision, enviarOrdenReal,
  kill, arm, handleViableSignal, getSnapshot, setPersistencia,
  setCargarEstado, _traders,
} = trader;
const { evaluarSenalPapel, construirPayloadOrdenV2 } = auditor;

const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const app = src('client/src/App.jsx');
const liveTraderJsx = src('client/src/components/LiveTrader.jsx');
const liveTraderSrc = src('server/liveTrader.js');
const routesSrc = src('server/routes.js');
const kalshiServerSrc = src('server/kalshiServer.js');
const dbSrc = src('server/db.js');
const schemaSql = src('server/schema.sql');
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

// Señal viable real (misma que tests-v16.1): NO a 20¢, viable.
const baseSenal = {
  ticker: 'KXBTC15M-26NOV181430-00', targetPrice: 63000, twapBloqueado: 62900,
  muestrasCapturadas: 51, ticksPerdidos: 0, segundosRestantes: 10, brtiValue: 62900,
  yesAskDollars: 0.80, noAskDollars: 0.20,
};
const senalViable = evaluarSenalPapel(baseSenal);

console.log('v16.2 — 1. Interruptor global LIVE_TRADING_ENABLED (por defecto apagado)');
check('sin env -> live apagado', isLiveEnabled() === false);
process.env.LIVE_TRADING_ENABLED = 'false';
check("'false' -> apagado", isLiveEnabled() === false);
process.env.LIVE_TRADING_ENABLED = '1';
check("'1' -> apagado (solo vale exactamente 'true')", isLiveEnabled() === false);
liveOn();
check("'true' -> encendido", isLiveEnabled() === true);
liveOff();

console.log('v16.2 — 2. enviarOrdenReal rechaza con live apagado SIN tocar la red');
{
  let llamadasRed = 0;
  const fetchQueFalla = async () => { llamadasRed++; throw new Error('NO DEBERÍA LLAMARSE A LA RED'); };
  const r = await enviarOrdenReal({
    keyId: 'falsa', privateKeyPem: 'falsa',
    payload: { ticker: 'KXBTC15M-26NOV181430-00' }, fetchFn: fetchQueFalla,
  });
  check('live apagado -> sent=false, reason live_disabled, 0 llamadas de red',
    r.sent === false && r.reason === 'live_disabled' && r.touchedNetwork === false && llamadasRed === 0);
}

console.log('v16.2 — 3. Con live encendido, el envío usa la firma real (Ed25519 generada en el test)');
{
  liveOn();
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  let capturado = null;
  const fetchStub = async (url, opts) => {
    capturado = { url, opts };
    return { ok: true, status: 201, json: async () => ({ order: { id: 'orden-falsa-1', client_order_id: 'c-1' } }) };
  };
  const payload = { ticker: 'KXBTC15M-26NOV181430-00', client_order_id: 'c-1', side: 'ask', count: '2.00', price: '0.8000', time_in_force: 'immediate_or_cancel', self_trade_prevention_type: 'taker_at_cross' };
  const r = await enviarOrdenReal({ keyId: 'key-falsa-1234', privateKeyPem: pem, payload, fetchFn: fetchStub });
  check('live encendido + clave válida -> sent=true, POST al endpoint V2 de órdenes',
    r.sent === true && r.touchedNetwork === true &&
    capturado && capturado.url === 'https://api.elections.kalshi.com/trade-api/v2/portfolio/events/orders' &&
    capturado.opts.method === 'POST');
  check('la petición lleva KALSHI-ACCESS-KEY, TIMESTAMP y SIGNATURE (firma RSA-PSS/Ed25519 reutilizada)',
    capturado && capturado.opts.headers['KALSHI-ACCESS-KEY'] === 'key-falsa-1234' &&
    typeof capturado.opts.headers['KALSHI-ACCESS-TIMESTAMP'] === 'string' &&
    typeof capturado.opts.headers['KALSHI-ACCESS-SIGNATURE'] === 'string' &&
    capturado.opts.headers['KALSHI-ACCESS-SIGNATURE'].length > 10);
  check('el body es el payload V2 tal cual (sin price_dollars ni size)',
    capturado && JSON.parse(capturado.opts.body).ticker === 'KXBTC15M-26NOV181430-00' &&
    !('price_dollars' in JSON.parse(capturado.opts.body)) && !('size' in JSON.parse(capturado.opts.body)));
  liveOff();
}

console.log('v16.2 — 4. Payload V2 reutilizado del auditor (no duplicado)');
check('la señal viable trae ordenV2Preview correcto (NO: ask, count "2.00", price "0.8000")',
  senalViable && senalViable.viableDespuesDeComision === true &&
  senalViable.ordenV2Preview.endpoint === '/trade-api/v2/portfolio/events/orders' &&
  senalViable.ordenV2Preview.payload.side === 'ask' &&
  senalViable.ordenV2Preview.payload.count === '2.00' &&
  senalViable.ordenV2Preview.payload.price === '0.8000' &&
  senalViable.ordenV2Preview.payload.time_in_force === 'immediate_or_cancel' &&
  senalViable.ordenV2Preview.payload.self_trade_prevention_type === 'taker_at_cross');
check('liveTrader re-exporta construirPayloadOrdenV2 del auditor (misma función, sin copia)',
  trader.construirPayloadOrdenV2 === construirPayloadOrdenV2);

console.log('v16.2 — 5. Pérdida potencial (peor caso) y decisión pura');
check('pérdida potencial a 16¢ + fee × 2 = $0.3388',
  cerca(calcularPerdidaPotencial({ askPriceDollars: 0.16, feePerContractDollars: 0.009408, contractsQty: 2 }), 0.3388, 0.0001));
check('pérdida potencial con números inválidos = null (bloquea)',
  calcularPerdidaPotencial({ askPriceDollars: 1.5, feePerContractDollars: 0, contractsQty: 2 }) === null &&
  calcularPerdidaPotencial({ askPriceDollars: 0.16, feePerContractDollars: 0, contractsQty: 0 }) === null);
{
  const est = crearEstadoTrader();
  check('live apagado + señal viable -> would-send (live_disabled)',
    evaluarDecision({ liveEnabled: false, estado: est, senal: senalViable }).action === 'would-send');
  check('live encendido + no armado -> blocked not_armed',
    evaluarDecision({ liveEnabled: true, estado: est, senal: senalViable }).reason === 'not_armed');
  est.armed = true;
  const d = evaluarDecision({ liveEnabled: true, estado: est, senal: senalViable });
  check('live encendido + armado + límites OK -> send, con pérdida potencial',
    d.action === 'send' && d.perdidaPotencialUsd != null && d.perdidaPotencialUsd > 0);
  est.killed = true;
  check('kill -> blocked killed aunque live esté encendido',
    evaluarDecision({ liveEnabled: true, estado: est, senal: senalViable }).reason === 'killed');
  check('kill -> blocked killed aunque live esté apagado (matar es matar)',
    evaluarDecision({ liveEnabled: false, estado: est, senal: senalViable }).reason === 'killed');
  check('señal NO viable -> ignore',
    evaluarDecision({ liveEnabled: true, estado: crearEstadoTrader(), senal: { ...senalViable, viableDespuesDeComision: false } }).action === 'ignore');
}

console.log('v16.2 — 6. Límites duros bloquean');
{
  const estBase = () => { const e = crearEstadoTrader(); e.armed = true; e.day = dayKey(); return e; };
  const e1 = estBase(); e1.ordersToday = 5;
  check('5 órdenes/día -> blocked max_orders_per_day',
    verificarLimites(e1, senalViable).reason === 'max_orders_per_day');
  const e2 = estBase(); e2.potentialLossTodayUsd = 19.90;
  check('pérdida potencial $19.90 + ~$0.42 > $20 -> blocked max_daily_loss',
    verificarLimites(e2, senalViable).reason === 'max_daily_loss');
  const e3 = estBase(); e3.consecutiveErrors = 3;
  check('3 errores consecutivos -> blocked max_consecutive_errors',
    verificarLimites(e3, senalViable).reason === 'max_consecutive_errors');
  const senalQty3 = { ...senalViable, ordenV2Preview: { ...senalViable.ordenV2Preview, payload: { ...senalViable.ordenV2Preview.payload, count: '3.00' } } };
  check('3 contratos por orden (> máx. 2) -> blocked max_contracts_per_order',
    verificarLimites(estBase(), senalQty3).reason === 'max_contracts_per_order');
  const e4 = estBase();
  check('reset de día: contadores a 0 al cambiar de día',
    (() => { e4.ordersToday = 5; e4.potentialLossTodayUsd = 10; resetDiaSiCambio(e4, '2999-01-01'); return e4.ordersToday === 0 && e4.potentialLossTodayUsd === 0 && e4.day === '2999-01-01'; })());
}

console.log('v16.2 — 7. handleViableSignal con live apagado: would-send SIN enviar nada');
const persistidos = [];
setPersistencia(async (userId, estado) => { persistidos.push({ userId, estado }); });
setCargarEstado(async () => null);
{
  liveOff();
  let llamadasEnvio = 0;
  const sendStub = async () => { llamadasEnvio++; return { sent: true }; };
  const entry = await handleViableSignal(991001, senalViable, { sendFn: sendStub, credsProvider: async () => ({ keyId: 'x', privateKeyPem: 'y' }) });
  check('live apagado -> entry would-send, sendFn 0 llamadas, log con 1 entrada',
    entry.action === 'would-send' && entry.reason === 'live_disabled' && llamadasEnvio === 0 &&
    _traders.get(991001).log.length === 1);
  check('would-send se persiste (hook llamado, kind live_trade_log con el log)',
    persistidos.some((p) => p.userId === 991001 && Array.isArray(p.estado.log) && p.estado.log[0].action === 'would-send'));
  const dup = await handleViableSignal(991001, senalViable, { sendFn: sendStub });
  check('segunda vez el mismo ticker -> duplicate, no se duplica el log',
    dup.action === 'duplicate' && _traders.get(991001).log.length === 1);
}

console.log('v16.2 — 8. handleViableSignal con live encendido + armado: envía 1 vez');
{
  liveOn();
  let llamadasEnvio = 0;
  const sendStub = async () => { llamadasEnvio++; return { sent: true, order: { client_order_id: 'c-1' } }; };
  await arm(991002);
  const entry = await handleViableSignal(991002, { ...senalViable, ticker: 'KXBTC15M-26NOV181430-15' }, {
    sendFn: sendStub, credsProvider: async () => ({ keyId: 'key-falsa', privateKeyPem: 'pem-falso' }),
  });
  const est = _traders.get(991002);
  check('live encendido + armado -> entry sent, sendFn 1 llamada, órdenes hoy = 1',
    entry.action === 'sent' && llamadasEnvio === 1 && est.ordersToday === 1);
  check('tras envío OK: errores consecutivos a 0 y pérdida potencial sumada',
    est.consecutiveErrors === 0 && est.potentialLossTodayUsd > 0);
  liveOff();
}

console.log('v16.2 — 9. Errores consecutivos: 3 fallos auto-detienen (kill)');
{
  liveOn();
  let llamadasEnvio = 0;
  const sendFalla = async () => { llamadasEnvio++; throw new Error('Kalshi HTTP 500'); };
  await arm(991003);
  for (let i = 0; i < 3; i++) {
    await handleViableSignal(991003, { ...senalViable, ticker: `KXBTC15M-26NOV181430-${10 + i}` }, {
      sendFn: sendFalla, credsProvider: async () => ({ keyId: 'k', privateKeyPem: 'p' }),
    });
  }
  const est = _traders.get(991003);
  check('3 envíos fallidos -> killed=true, motivo max_consecutive_errors, desarmado',
    est.killed === true && est.killReason === 'max_consecutive_errors' && est.armed === false);
  const cuarto = await handleViableSignal(991003, { ...senalViable, ticker: 'KXBTC15M-26NOV181430-99' }, {
    sendFn: sendFalla, credsProvider: async () => ({ keyId: 'k', privateKeyPem: 'p' }),
  });
  check('4º intento con kill activo -> blocked killed, sin 4ª llamada de red',
    cuarto.action === 'blocked' && cuarto.reason === 'killed' && llamadasEnvio === 3);
  liveOff();
}

console.log('v16.2 — 10. Kill switch manual');
{
  await arm(991004);
  const snap = await kill(991004, 'manual');
  check('kill manual -> killed, desarmado, motivo manual, snapshot lo refleja',
    snap.killed === true && snap.killReason === 'manual' && snap.armed === false && snap.liveEnabled === false);
  const snap2 = getSnapshot(991004);
  check('getSnapshot sin live: liveEnabled false, límites con los defaults (2/5/$20/3)',
    snap2.limits.maxContractsPerOrder === 2 && snap2.limits.maxOrdersPerDay === 5 &&
    snap2.limits.maxDailyLossUsd === 20 && snap2.limits.maxConsecutiveErrors === 3);
}

console.log('v16.2 — 11. Rutas: enable 403 sin la env, status/kill siempre, nada de órdenes directas');
check('routes.js expone GET /kalshi/live/status, POST /kalshi/live/kill y POST /kalshi/live/enable',
  routesSrc.includes("'/kalshi/live/status'") && routesSrc.includes("'/kalshi/live/kill'") &&
  routesSrc.includes("'/kalshi/live/enable'"));
check('enable devuelve 403 mientras LIVE_TRADING_ENABLED no sea true (el interruptor manda)',
  routesSrc.includes("status(403)") && routesSrc.includes('LIVE_TRADING_ENABLED') &&
  routesSrc.includes('isLiveEnabled()'));
check('routes.js no contiene fetch a Kalshi ni la ruta de órdenes (el POST vive solo en liveTrader.js; actualizado por diseño en v16.3: el comentario de cabecera documenta la ruta, se ignoran los comentarios)',
  (() => { const sinComentarios = routesSrc.replace(/\/\/.*$/gm, ''); return !sinComentarios.includes('portfolio/events/orders') && !sinComentarios.includes('portfolio/orders') && !sinComentarios.includes('fetch('); })());
check('desconectar Kalshi también mata el trader',
  routesSrc.includes("liveTrader.kill(req.user.id, 'kalshi_disconnected')"));

console.log('v16.2 — 12. Persistencia live_trade_log y cableado del cliente');
check('db.js y schema.sql admiten kind live_trade_log (CHECK + migración DROP/ADD)',
  dbSrc.includes("'live_trade_log'") && dbSrc.includes('DROP CONSTRAINT IF EXISTS cev_user_data_kind_check') &&
  schemaSql.includes("'live_trade_log'"));
check('App.jsx monta §7 LiveTrader después de PaperAudit y antes de AccountBox, con VERSION_LABEL v16.10 (actualizado por diseño en v16.10)',
  app.includes("import LiveTrader from './components/LiveTrader.jsx'") &&
  app.includes("const VERSION_LABEL = 'v16.10") &&
  app.indexOf('<LiveTrader user={user} fmt={fmt} />') > app.indexOf('<PaperAudit user={user} fmt={fmt} />') &&
  app.indexOf('<LiveTrader user={user} fmt={fmt} />') < app.indexOf('<AccountBox'));
check('LiveTrader.jsx: §7 con título dinámico según live/armed/killed (v16.7, ya no hay título fijo "APAGADO"), sondeo status cada 2 s, botón Detener (kill), Armar deshabilitado sin live',
  liveTraderJsx.includes('7 · Bot en vivo — {tituloEstado}') &&
  liveTraderJsx.includes("const tituloEstado = !live ? 'APAGADO'") &&
  liveTraderJsx.includes("killed ? 'DETENIDO'") &&
  liveTraderJsx.includes("armed ? 'ARMADO'") &&
  !liveTraderJsx.includes('<h2>7 · Bot en vivo — APAGADO</h2>') &&
  liveTraderJsx.includes("apiAuth('/api/kalshi/live/status')") && liveTraderJsx.includes('2000') &&
  liveTraderJsx.includes("'/api/kalshi/live/kill'") && liveTraderJsx.includes('Detener (kill switch)') &&
  liveTraderJsx.includes('APAGADO — no envía órdenes') &&
  liveTraderJsx.includes('es imposible que se envíe una orden real') &&
  liveTraderJsx.includes('enviará una orden REAL') &&
  liveTraderJsx.includes('SIN ARMAR') &&
  liveTraderJsx.includes('DETENIDO por el kill switch'));
check('LiveTrader.jsx no envía órdenes ni toca Kalshi directamente (solo status/kill/enable)',
  !liveTraderJsx.includes('portfolio/events/orders') && !liveTraderJsx.includes('fetch('));

console.log('v16.2 — 13. Solo el trader escribe: motor y solo-lectura intactos');
check('kalshiServer.js sigue solo lectura: READ_ONLY_PATHS intacto y sin POST',
  kalshiServerSrc.includes("'/trade-api/v2/portfolio/positions'") &&
  kalshiServerSrc.includes("'/trade-api/v2/portfolio/balance'") &&
  kalshiServerSrc.includes("'/trade-api/v2/portfolio/fills'") &&
  !/method:\s*['"]POST['"]/.test(kalshiServerSrc));
check('liveTrader.js es el único archivo con el POST de órdenes (además del preview del auditor)',
  liveTraderSrc.includes("'/trade-api/v2/portfolio/events/orders'") &&
  liveTraderSrc.includes('LIVE_TRADING_ENABLED'));
check('el motor no menciona al trader (kalshi.js, analysis.js, verdict.js, windowOutcome.js intactos)',
  ['client/src/kalshi.js', 'client/src/analysis.js', 'client/src/verdict.js', 'client/src/windowOutcome.js']
    .every((p) => !src(p).includes('liveTrader') && !src(p).includes('live_trade')));
check('liveTrader.js no contiene credenciales reales ni PEM hardcodeado',
  !liveTraderSrc.includes('-----BEGIN') && !liveTraderSrc.includes('LIVE_TRADING_ENABLED=true'));
check('VERSION.txt documenta v16.2 (solo local, sin desplegar ni pushear)',
  versionTxt.includes('v16.2') && versionTxt.includes('Bot en vivo (APAGADO') &&
  versionTxt.includes('SOLO LOCAL'));

// Restaurar la env como estaba.
if (envOriginal === undefined) delete process.env.LIVE_TRADING_ENABLED;
else process.env.LIVE_TRADING_ENABLED = envOriginal;

console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
