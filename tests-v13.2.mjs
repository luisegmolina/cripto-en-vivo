// tests-v13.2.mjs — Dirección de posiciones Kalshi y posiciones con
// cantidad 0 (captura de Luis, 12-nov-2026 20:27, pestaña Mi cuenta
// Kalshi, v13.1).
//
// Caso de Luis: KXBTC15M-26NOV122130-30, "BTC price up in next 15
// mins?", Lado SÍ, cantidad 0 (cerrada). Él dice: "yo aposté a la
// baja". SÍ a "price up" sería SUBE, así que algo no cuadraba.
// Causa raíz (verificada contra la documentación de la API de
// Kalshi): /portfolio/positions NO trae ningún campo `side`; el lado
// va en el SIGNO de `position`/`position_fp` (>0 = SÍ, <0 = NO, 0 =
// sin posición neta). El código viejo hacía `count < 0 ? 'no' :
// 'yes'`, así que una cantidad 0 se mostraba como SÍ inventado.
// Además la UI culpaba a la dirección ("no se puede deducir") cuando
// en realidad la dirección SÍ se deducía y lo que faltaba era el
// precio para decidir.
//
// Arreglo v13.2:
//  1. El lado se resuelve por: campo explícito > signo de position /
//     position_fp (solo si != 0) > lado del último fill del ticker >
//     null (desconocido, visible, nunca inventado).
//  2. Dirección desde ticker+título+lado con \b (up/down, above/
//     below): "price up"+SÍ=SUBE, "price up"+NO=BAJA, "down"+SÍ=BAJA,
//     "down"+NO=SUBE.
//  3. Cantidad 0 fuera de la tabla de abiertas: sección aparte
//     "Posiciones cerradas / liquidadas (cantidad 0)", sin P&L ni
//     decisión. Solo cantidad > 0 va en abiertas con decisión.
//  4. Si la ventana 15m del mercado ya cerró, la tabla lo dice
//     ("Ventana cerrada") en vez de dejar la decisión en blanco.
// Uso: node tests-v13.2.mjs (después de npm --prefix client run build)

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { deriveDirection, parseTickerWindow, resolvePositionSide, signedPosition, parseTargetPrice, buildCurrentTicker, getCurrentKalshiMarket } = require('./server/kalshiServer.js');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

// 1. Dirección desde título + lado.
const UP = { ticker: 'KXBTC15M-26NOV122130-30', title: 'BTC price up in next 15 mins?' };
const DOWN = { ticker: 'KXBTC15M-26NOV122130-30', title: 'BTC price down in next 15 mins?' };
check('"price up" + SÍ = SUBE', deriveDirection({ ...UP, side: 'yes' }) === 'up');
check('"price up" + NO = BAJA', deriveDirection({ ...UP, side: 'no' }) === 'down');
check('"price down" + SÍ = BAJA', deriveDirection({ ...DOWN, side: 'yes' }) === 'down');
check('"price down" + NO = SUBE', deriveDirection({ ...DOWN, side: 'no' }) === 'up');
check('"BTC above $70,000?" + SÍ = SUBE', deriveDirection({ ticker: 'KXBTC-26NOV12', title: 'Will BTC close above $70,000?', side: 'yes' }) === 'up');
check('"BTC below $70,000?" + NO = SUBE', deriveDirection({ ticker: 'KXBTC-26NOV12', title: 'Will BTC close below $70,000?', side: 'no' }) === 'up');
check('título sin dirección = null', deriveDirection({ ticker: 'KXBTC15M-26NOV122130-30', title: 'BTC price in next 15 mins?', side: 'yes' }) === null);
check('"up" dentro de "group" no casa (límite de palabra)', deriveDirection({ ticker: 'KXBTC15M-26NOV122130-30', title: 'BTC group chat?', side: 'yes' }) === null);
check('lado desconocido + "price up" = null (no se inventa)', deriveDirection({ ...UP, side: null }) === null);

// 2. Lado: fuente de verdad = signo de position/position_fp, luego fills.
check('signedPosition lee position_fp "-22.00" como -22', signedPosition({ position_fp: '-22.00' }) === -22);
check('signedPosition lee position_fp "5.00" como 5', signedPosition({ position_fp: '5.00' }) === 5);
check('signedPosition: 0 es un valor válido, no se convierte en otra cosa', signedPosition({ position: 0, count: 3 }) === 0);
check('position +5 = SÍ (por signo)', resolvePositionSide({ rawPosition: 5, explicitSide: null, latestFillSide: null }).side === 'yes');
check('position -22 = NO (por signo)', resolvePositionSide({ rawPosition: -22, explicitSide: null, latestFillSide: null }).side === 'no');
check('position 0 + último fill NO = NO (por fills)', resolvePositionSide({ rawPosition: 0, explicitSide: null, latestFillSide: 'no' }).side === 'no'
  && resolvePositionSide({ rawPosition: 0, explicitSide: null, latestFillSide: 'no' }).sideSource === 'fill');
check('position 0 + último fill SÍ = SÍ (por fills)', resolvePositionSide({ rawPosition: 0, explicitSide: null, latestFillSide: 'yes' }).side === 'yes');
check('position 0 + sin fills = lado desconocido (null, no inventado)', (() => { const r = resolvePositionSide({ rawPosition: 0, explicitSide: null, latestFillSide: null }); return r.side === null && r.sideSource === 'unknown'; })());

// 3. El caso exacto de Luis: posición cerrada (0), título "price up",
//    último fill NO (apostó a la baja) -> lado NO, dirección BAJA.
//    El código viejo habría dado SÍ/SUBE.
{
  const side = resolvePositionSide({ rawPosition: 0, explicitSide: null, latestFillSide: 'no' });
  const dir = deriveDirection({ ...UP, side: side.side });
  check('caso de Luis: lado NO y dirección BAJA (coincide con "aposté a la baja")', side.side === 'no' && dir === 'down');
  const oldSide = 0 < 0 ? 'no' : 'yes';
  check('el código viejo daba SÍ para cantidad 0 (bug confirmado)', oldSide === 'yes');
}

// 4. Ventana del ticker (hora ET -> UTC; 12-nov-2026 ya es EST, UTC-5).
// CORRECCIÓN v13.2 (verificado en vivo): la hora del ticker es el
// CIERRE, no el inicio. ...2115-15 = ventana 21:00–21:15 ET.
{
  const w = parseTickerWindow('KXBTC15M-26NOV122115-15');
  check('parseTickerWindow: inicio 21:00 ET 12-nov-2026 = 02:00 UTC 13-nov', w && w.startMs === Date.UTC(2026, 10, 13, 2, 0), w ? String(w.startMs) : 'null');
  check('parseTickerWindow: fin 21:15 ET = 02:15 UTC', w && w.endMs === Date.UTC(2026, 10, 13, 2, 15));
  const w2 = parseTickerWindow('KXBTC15M-26NOV122130-30');
  check('parseTickerWindow del caso de Luis: inicio 21:15 ET, fin 21:30 ET = 02:30 UTC', w2 && w2.startMs === Date.UTC(2026, 10, 13, 2, 15) && w2.endMs === Date.UTC(2026, 10, 13, 2, 30));
  check('parseTickerWindow: ticker sin fecha = null', parseTickerWindow('KXBTC-26NOV12') === null);
  const closed = (endMs, nowMs) => nowMs > endMs;
  check('ventana cerrada si ahora > fin', closed(Date.UTC(2026, 10, 13, 2, 15), Date.UTC(2026, 10, 13, 2, 16)));
  check('ventana abierta si ahora < fin', !closed(Date.UTC(2026, 10, 13, 2, 15), Date.UTC(2026, 10, 13, 2, 14)));
}

// 5. Reparto abiertas/cerradas: solo cantidad > 0 va a abiertas.
{
  const sample = [{ ticker: 'A', count: 0 }, { ticker: 'B', count: 3 }, { ticker: 'C', count: 0 }, { ticker: 'D', count: 1 }];
  const open = sample.filter((p) => (p.count || 0) > 0);
  const closed = sample.filter((p) => (p.count || 0) === 0);
  check('cantidad 0 va a cerradas y no a abiertas', open.length === 2 && closed.length === 2 && open.every((p) => p.count > 0));
  check('una con cantidad > 0 va a abiertas con decisión', open.some((p) => p.ticker === 'B'));
}

// 7. Mercado actual de Kalshi (API pública): precio objetivo y SÍ/NO.
// Verificado en vivo 12-nov: mercado activo KXBTC15M-26NOV122145-45,
// yes_sub_title "Target Price: $70,487.89", floor_strike 70487.89,
// yes_ask_dollars "0.2400" (24¢), no_ask_dollars "0.7700" (77¢).
{
  check('parseTargetPrice: floor_strike manda', parseTargetPrice({ floor_strike: 70487.89, yes_sub_title: 'Target Price: $70,487.89' }) === 70487.89);
  check('parseTargetPrice: sin floor_strike se lee de yes_sub_title', parseTargetPrice({ yes_sub_title: 'Target Price: $70,487.89' }) === 70487.89);
  check('parseTargetPrice: "Target price: TBD" = null (no se inventa)', parseTargetPrice({ yes_sub_title: 'Target price: TBD' }) === null);
  check('parseTargetPrice: sin datos = null', parseTargetPrice({}) === null);
  check('buildCurrentTicker: 21:40 ET -> ventana que cierra 21:45', buildCurrentTicker(Date.UTC(2026, 10, 13, 2, 40)) === 'KXBTC15M-26NOV122145-45');
  check('buildCurrentTicker: 21:15 ET en punto -> cierra 21:30', buildCurrentTicker(Date.UTC(2026, 10, 13, 2, 15)) === 'KXBTC15M-26NOV122130-30');
  check('buildCurrentTicker: 21:59 ET -> cierra 22:00 (-00)', buildCurrentTicker(Date.UTC(2026, 10, 13, 2, 59)) === 'KXBTC15M-26NOV122200-00');
  const sampleMarket = {
    ticker: 'KXBTC15M-26NOV122145-45', title: 'BTC price up in next 15 mins?',
    yes_sub_title: 'Target Price: $70,487.89', floor_strike: 70487.89,
    yes_bid_dollars: '0.2300', yes_ask_dollars: '0.2400',
    no_bid_dollars: '0.7600', no_ask_dollars: '0.7700', last_price_dollars: '0.2400',
    status: 'active', close_time: '2026-11-13T02:45:00Z', open_time: '2026-11-13T02:30:00Z',
  };
  const stubOk = async (url) => {
    if (!url.includes('KXBTC15M-26NOV122145-45')) throw new Error(`ticker inesperado en URL: ${url}`);
    return { market: sampleMarket };
  };
  const m = await getCurrentKalshiMarket({ nowMs: Date.UTC(2026, 10, 13, 2, 40), fetchFn: stubOk, skipCache: true });
  check('getCurrentKalshiMarket: parsea el mercado actual (stub)', m && m.source === 'kalshi' && m.ticker === 'KXBTC15M-26NOV122145-45');
  check('getCurrentKalshiMarket: precio objetivo $70,487.89', m && m.targetPrice === 70487.89);
  check('getCurrentKalshiMarket: SÍ 24¢ (ask) / NO 77¢ (ask)', m && m.yesAskCents === 24 && m.noAskCents === 77);
  check('getCurrentKalshiMarket: SÍ bid 23¢ / NO bid 76¢', m && m.yesBidCents === 23 && m.noBidCents === 76);
  const stubFail = async () => { throw new Error('Kalshi no responde'); };
  const mFail = await getCurrentKalshiMarket({ nowMs: Date.UTC(2026, 10, 13, 2, 40), fetchFn: stubFail, skipCache: true });
  check('getCurrentKalshiMarket: si Kalshi falla devuelve null (el cliente cae a Coinbase)', mFail === null);
  const app = readFileSync('./client/src/App.jsx', 'utf8');
  check('cliente: pestaña Kalshi muestra "Precio objetivo (Kalshi)"', app.includes('Precio objetivo (Kalshi)'));
  check('cliente: muestra "Precio SÍ / NO (Kalshi)"', app.includes('Precio SÍ / NO (Kalshi)'));
  check('cliente: aviso BRTI (liquidación, no Coinbase)', app.includes('CF Benchmarks BRTI') && app.includes('no con Coinbase'));
  check('cliente: aviso de caída a Coinbase ("precio de referencia de Coinbase, no de Kalshi")', app.toLowerCase().includes('precio de referencia de coinbase, no de kalshi'));
  check('cliente: usa el objetivo de Kalshi como referencia (kalshiTargetPrice)', app.includes('kalshiTargetPrice'));
  const appSrv = readFileSync('./server/app.js', 'utf8');
  check('servidor: ruta pública GET /api/kalshi-market', appSrv.includes("'/api/kalshi-market'"));
  check('servidor: la ruta cae a source coinbase si Kalshi falla', appSrv.includes("source: 'coinbase'"));
}

// 6. Chequeos estáticos: el cliente y el servidor llevan el arreglo.
{
  const kc = readFileSync('./client/src/KalshiConnect.jsx', 'utf8');
  check('cliente: sección "Posiciones cerradas / liquidadas"', kc.includes('Posiciones cerradas / liquidadas'));
  check('cliente: separa openPositions/closedPositions', kc.includes('openPositions') && kc.includes('closedPositions'));
  check('cliente: muestra "Ventana cerrada"', kc.includes('Ventana cerrada'));
  check('cliente: distingue "Sin precio medio o actual" de "no se pudo deducir"', kc.includes('Sin precio medio o actual'));
  check('cliente: marca el lado recuperado de fills ("según tus operaciones")', kc.includes('según tus operaciones'));
  check('cliente: lado desconocido visible ("sin verificar")', kc.includes('sin verificar'));
  check('cliente: ya no usa el mensaje viejo que culpaba a la dirección', !kc.includes('no se puede deducir si esta posición es a que SUBE o a que BAJA por el ticker/título'));
  check('cliente: la tabla de abiertas itera openPositions, no todas', kc.includes('openPositions.map'));
  const srv = readFileSync('./server/kalshiServer.js', 'utf8');
  check('servidor: lee position_fp además de position', srv.includes('position_fp'));
  check('servidor: documenta la fuente de verdad del lado', srv.includes('FUENTE DE VERDAD DEL LADO'));
  check('servidor: nunca usa `count < 0 ? \'no\' : \'yes\'` para el lado (fuera de comentarios)', !srv.replace(/\/\/.*$/gm, '').includes("count < 0 ? 'no' : 'yes'"));
  check('servidor: exporta resolvePositionSide y signedPosition', srv.includes('resolvePositionSide') && srv.includes('signedPosition'));
}

console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
