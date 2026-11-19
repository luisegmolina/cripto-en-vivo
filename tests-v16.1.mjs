// tests-v16.1.mjs — Auditor en papel Sniper BRTI dentro de la web (v16.1).
// PAPEL SOLAMENTE: nada de esto envía órdenes a Kalshi.
// Uso: node tests-v16.1.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const auditor = require('./server/paperAuditor.js');
const {
  calcularComisionPorContrato, construirPayloadOrdenV2, calcularTwapBloqueado,
  debeDescartarContrato, evaluarSenalPapel, finalizarVentana, calcularStats,
  crearEstadoAuditor, tickAuditor, _auditors,
} = auditor;

const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const app = src('client/src/App.jsx');
const paperAuditJsx = src('client/src/components/PaperAudit.jsx');
const paperAuditorSrc = src('server/paperAuditor.js');
const routesSrc = src('server/routes.js');
const kalshiServerSrc = src('server/kalshiServer.js');
const dbSrc = src('server/db.js');
const schemaSql = src('server/schema.sql');
const versionTxt = src('VERSION.txt');
const css = src('client/src/index.css');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const cerca = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

console.log('v16.1 — 1. Comisión taker 0.07 * P * (1 - P)');
check('fee a 50¢ = 1.75¢ (máximo de la curva)', cerca(calcularComisionPorContrato(0.50), 0.0175));
check('fee a 85¢ = 0.8925¢', cerca(calcularComisionPorContrato(0.85), 0.008925));
check('fee a 98¢ = 0.1372¢', cerca(calcularComisionPorContrato(0.98), 0.001372));
check('fee en los extremos (0 / 1) = 0', calcularComisionPorContrato(0) === 0 && calcularComisionPorContrato(1) === 0);

console.log('v16.1 — 2. Payload V2 (solo preview, verificado contra docs.kalshi.com)');
const pYes = construirPayloadOrdenV2('KXBTC15M-26NOV181430-T62757.41', 'yes', 0.85, 2);
check('preview YES: endpoint V2, side bid, count "2.00", price "0.8500"',
  pYes.endpoint === '/trade-api/v2/portfolio/events/orders' &&
  pYes.payload.side === 'bid' && pYes.payload.count === '2.00' && pYes.payload.price === '0.8500');
const pNo = construirPayloadOrdenV2('KXBTC15M-26NOV181430-T62757.41', 'no', 0.15, 2);
check('preview NO: side ask a 1-noAsk ("0.8500"), comprar NO = vender SÍ',
  pNo.payload.side === 'ask' && pNo.payload.price === '0.8500');
check('preview trae time_in_force immediate_or_cancel, self_trade_prevention taker_at_cross y client_order_id',
  pYes.payload.time_in_force === 'immediate_or_cancel' &&
  pYes.payload.self_trade_prevention_type === 'taker_at_cross' &&
  typeof pYes.payload.client_order_id === 'string' && pYes.payload.client_order_id.length >= 32);
check('preview NO usa price_dollars / size / action / yes_price_dollars',
  !('price_dollars' in pYes.payload) && !('size' in pYes.payload) &&
  !('action' in pYes.payload) && !('yes_price_dollars' in pYes.payload));

console.log('v16.1 — 3. TWAP bloqueado desde el Map de muestras');
const mapa = new Map([[1000, 63000], [1001, 63100], [1002, 62900]]);
const tw = calcularTwapBloqueado(mapa);
check('TWAP de 3 muestras = 63000', tw.n === 3 && tw.twap === 63000);
check('TWAP sin muestras = null, n = 0', calcularTwapBloqueado(new Map()).twap === null && calcularTwapBloqueado(new Map()).n === 0);

console.log('v16.1 — 4. Descarte de ventana incompleta');
check('descarta con 60 s o menos (60 y 30) y acepta con 61 s o más (61 y 900)',
  debeDescartarContrato(60) === true && debeDescartarContrato(30) === true &&
  debeDescartarContrato(61) === false && debeDescartarContrato(900) === false);

console.log('v16.1 — 5. Evaluación de señal en papel (gate de ticks y break-even real)');
// OJO: con segundosRestantes=10, las muestras esperadas son 61-10=51
// (incluyendo el tick del segundo actual). Pasar 50 falsea la suma
// bloqueada y el salto requerido.
const baseSenal = {
  ticker: 'KXBTC15M-26NOV181430-T62757.41', targetPrice: 63000, twapBloqueado: 62900,
  muestrasCapturadas: 51, ticksPerdidos: 0, segundosRestantes: 10, brtiValue: 62900,
  yesAskDollars: 0.80, noAskDollars: 0.20,
};
const senalNo = evaluarSenalPapel(baseSenal);
check('salto requerido enorme a la baja dispara NO a 20¢, viable tras comisión',
  senalNo && senalNo.direccionElegida === 'no' && senalNo.askPriceDollars === '0.2000' &&
  cerca(senalNo.feePerContractDollars, 0.0112) && senalNo.viableDespuesDeComision === true &&
  senalNo.ordenV2Preview.payload.side === 'ask');
check('con 3 ticks perdidos NO hay señal (gate <= 2)', evaluarSenalPapel({ ...baseSenal, ticksPerdidos: 3 }) === null);
check('con 2 ticks perdidos SÍ hay señal (límite del gate)', evaluarSenalPapel({ ...baseSenal, ticksPerdidos: 2 }) !== null);
// Verificación de ecuación dimensionalmente exacta (totalMuestrasEfectivas = N + segundosRestantesReales):
// Con R=10 (segundosRestantesReales=9) y 2 ticks perdidos (muestrasCapturadas=49 -> totalMuestrasEfectivas=58):
// Si twapBloqueado = targetPrice (63000) y brtiValue = 63000, el salto requerido debe ser exactamente $0.00 (no inflado por usar 60 fijo).
const senalSinInflar = evaluarSenalPapel({
  ...baseSenal, targetPrice: 63000, twapBloqueado: 63000, brtiValue: 63000,
  muestrasCapturadas: 49, ticksPerdidos: 2, segundosRestantes: 10,
});
check('ecuación totalMuestrasEfectivas (N + R - 1): 2 ticks perdidos con TWAP === Target da salto $0 y no dispara señal falsa',
  senalSinInflar === null);
check('fuera de T-18 a T-3 NO hay señal (R=20 y R=2)', evaluarSenalPapel({ ...baseSenal, segundosRestantes: 20 }) === null && evaluarSenalPapel({ ...baseSenal, segundosRestantes: 2 }) === null);
check('sin salto suficiente NO hay señal (TWAP = objetivo)', evaluarSenalPapel({ ...baseSenal, twapBloqueado: 63000, brtiValue: 63000 }) === null);
// Corrección a la especificación inicial: a 98¢ el neto es 1 - 0.98 - 0.07*0.98*0.02
// = $0.0186, MAYOR que el mínimo $0.015, así que SÍ es viable. El cruce real
// está en ~98.35¢: a 99¢ el neto es $0.0093 < $0.015 y NO es viable.
const senal98 = evaluarSenalPapel({ ...baseSenal, twapBloqueado: 63100, brtiValue: 63100, yesAskDollars: 0.98, noAskDollars: 0.02 });
check('ask 98¢ SÍ es viable (neto $0.0186 >= $0.015): la especificación decía lo contrario y estaba mal',
  senal98 && senal98.direccionElegida === 'yes' && senal98.viableDespuesDeComision === true && cerca(senal98.netProfitIfWinPerContract, 0.0186, 0.0001));
const senal99 = evaluarSenalPapel({ ...baseSenal, twapBloqueado: 63100, brtiValue: 63100, yesAskDollars: 0.99, noAskDollars: 0.01 });
check('ask 99¢ NO es viable (neto $0.0093 < $0.015), aunque la dirección sea correcta',
  senal99 && senal99.direccionElegida === 'yes' && senal99.viableDespuesDeComision === false && cerca(senal99.netProfitIfWinPerContract, 0.0093, 0.0001));

console.log('v16.1 — 6. Cierre de ventana contra liquidación oficial');
const estadoCierre = {
  contrato: { ticker: 'KXBTC15M-26NOV181430-T62757.41', targetPrice: 63000 },
  muestras: new Map([[1, 63010], [2, 63020], [3, 63000]]),
  simulacion: null,
  ultimoBrti: { avg60s: 63005, avg15mFinal: 63008 },
};
const reg = finalizarVentana(estadoCierre, { result: 'yes', expirationValue: 63012 });
check('registro: TWAP 63010, predicción yes, error TWAP-oficial -2',
  reg.twapLocal === 63010 && reg.prediccionLocal === 'yes' &&
  reg.brtiLiquidacionOficial === 63012 && reg.errorTwapVsOficial === -2 &&
  reg.resultadoOficialKalshi === 'yes');
check('stats: ventanas, señales, viables y acierto de predicción local',
  (() => {
    const s = calcularStats([
      { simulacion: { viableDespuesDeComision: true, direccionElegida: 'yes' }, prediccionLocal: 'yes', resultadoOficialKalshi: 'yes' },
      { simulacion: null, prediccionLocal: 'no', resultadoOficialKalshi: 'yes' },
      { simulacion: { viableDespuesDeComision: false, direccionElegida: 'no' }, prediccionLocal: null, resultadoOficialKalshi: 'pendiente' },
    ]);
    return s.ventanas === 3 && s.senales === 2 && s.viables === 1 && s.prediccionCorrecta === 1 && s.prediccionTotal === 2;
  })());

console.log('v16.1 — 7. Tick del auditor con stubs (sin red, sin Kalshi real)');
const ahora = Date.now();
const segAhora = Math.floor(ahora / 1000);
// 7a. Descubrir un contrato que cierra en 30 s -> se descarta.
{
  const est = crearEstadoAuditor();
  est.enabled = true;
  _auditors.set(999001, est);
  await tickAuditor(999001, ahora, {
    descubrir: async () => ({ ticker: 'KXBTC15M-26NOV181430-T62757.41', targetPrice: 62757.41, closeMs: ahora + 30000, closeIso: 'x' }),
  });
  check('tick descarta contrato con 30 s restantes (ventana incompleta)',
    est.contrato === null && /descartado/.test(est.ultimoError || ''));
  _auditors.delete(999001);
}
// 7b. Minuto final con 50 muestras previas + tick fresco -> señal NO viable.
{
  const est = crearEstadoAuditor();
  est.enabled = true;
  est.contrato = { ticker: 'KXBTC15M-26NOV181430-T62757.41', targetPrice: 63000, closeMs: (segAhora + 10) * 1000, closeIso: 'x' };
  for (let i = 1; i <= 50; i++) est.muestras.set(segAhora - i, 62900);
  est.ultimoUpdatedAt = 'tick-viejo';
  _auditors.set(999002, est);
  const tickIso = new Date(ahora).toISOString();
  await tickAuditor(999002, ahora, {
    brtiState: () => ({ value: 62900, avg60s: 62950, avg15mFinal: null, updatedAt: tickIso, status: 'connected', error: null }),
    quote: async () => ({ ticker: 'KXBTC15M-26NOV181430-T62757.41', status: 'active', result: null, expirationValue: null, yesAskDollars: 0.80, yesBidDollars: 0.79, noAskDollars: 0.20 }),
  });
  // v16.3 (actualizado por diseño): el tick muestrea sin esperar a la
  // quote; la señal se evalúa al llegar la quote (en paralelo). Se
  // espera a que aterrice antes de afirmar.
  await new Promise((r) => setTimeout(r, 10));
  check('tick en T-10 con 51 muestras registra señal NO viable (TWAP 62900 vs objetivo 63000)',
    est.simulacion && est.simulacion.direccionElegida === 'no' && est.simulacion.viableDespuesDeComision === true);
  check('tick guarda avg60s/avg15mFinal solo como diagnóstico, no como TWAP',
    est.ultimoBrti && est.ultimoBrti.avg60s === 62950 && est.twapActual === 62900);
  // 7c. Mismo segundo, mismo updatedAt -> dedup: no suma otra muestra.
  const nAntes = est.muestras.size;
  await tickAuditor(999002, ahora, {
    brtiState: () => ({ value: 62900, avg60s: 62950, avg15mFinal: null, updatedAt: tickIso, status: 'connected', error: null }),
    quote: async () => ({ ticker: 'KXBTC15M-26NOV181430-T62757.41', status: 'active', result: null, expirationValue: null, yesAskDollars: 0.80, yesBidDollars: 0.79, noAskDollars: 0.20 }),
  });
  check('segundo tick con el mismo updatedAt no duplica la muestra (dedup)',
    est.muestras.size === nAntes);
  _auditors.delete(999002);
}

console.log('v16.1 — 8. Papel solamente: ni una escritura a Kalshi');
check('paperAuditor.js no tiene method POST/PUT/DELETE a Kalshi',
  !/method:\s*['"]POST['"]/.test(paperAuditorSrc) && !/method:\s*['"]PUT['"]/.test(paperAuditorSrc) && !/method:\s*['"]DELETE['"]/.test(paperAuditorSrc));
check('paperAuditor.js no contiene la ruta v1 /portfolio/orders',
  !paperAuditorSrc.includes('/trade-api/v2/portfolio/orders'));
check('la única aparición de portfolio/events/orders en paperAuditor.js es la vista previa',
  (paperAuditorSrc.match(/portfolio\/events\/orders/g) || []).length === 1);
check('routes.js no contiene ninguna ruta de órdenes ni fetch a Kalshi (actualizado por diseño en v16.3: el comentario de cabecera documenta la ruta, se ignoran los comentarios)',
  (() => { const sinComentarios = routesSrc.replace(/\/\/.*$/gm, ''); return !sinComentarios.includes('portfolio/orders') && !sinComentarios.includes('portfolio/events/orders') && !sinComentarios.includes('fetch('); })());
check('kalshiServer.js sigue solo lectura: READ_ONLY_PATHS intacto y sin POST',
  kalshiServerSrc.includes("'/trade-api/v2/portfolio/positions'") &&
  kalshiServerSrc.includes("'/trade-api/v2/portfolio/balance'") &&
  kalshiServerSrc.includes("'/trade-api/v2/portfolio/fills'") &&
  !/method:\s*['"]POST['"]/.test(kalshiServerSrc));

console.log('v16.1 — 9. Cableado: rutas, persistencia, cliente y versión');
check('routes.js expone GET /kalshi/paper-audit y POST start/stop con ensureBrti y 400 sin Kalshi',
  routesSrc.includes("'/kalshi/paper-audit'") && routesSrc.includes("'/kalshi/paper-audit/start'") &&
  routesSrc.includes("'/kalshi/paper-audit/stop'") && routesSrc.includes('brti.ensureBrti(req.user.id') &&
  routesSrc.includes('Conecta primero tu cuenta Kalshi'));
check('db.js y schema.sql admiten kind paper_audit (CHECK + migración DROP/ADD)',
  dbSrc.includes("'paper_audit'") && dbSrc.includes('DROP CONSTRAINT IF EXISTS cev_user_data_kind_check') &&
  schemaSql.includes("'paper_audit'"));
check('App.jsx monta §6 PaperAudit después de ChartSection y antes de AccountBox, con VERSION_LABEL v16.3 (actualizado por diseño en v16.3)',
  app.includes("import PaperAudit from './components/PaperAudit.jsx'") &&
  app.includes('const VERSION_LABEL = \'v16.3') &&
  app.indexOf('<PaperAudit user={user} fmt={fmt} />') > app.indexOf('<ChartSection') &&
  app.indexOf('<PaperAudit user={user} fmt={fmt} />') < app.indexOf('<AccountBox'));
check('PaperAudit.jsx: §6, sondeo cada 2 s, botones Iniciar/Detener, tabla y aviso de papel solamente',
  paperAuditJsx.includes('6 · Auditor en papel — Sniper BRTI (sin dinero real)') &&
  paperAuditJsx.includes("apiAuth('/api/kalshi/paper-audit')") && paperAuditJsx.includes('2000') &&
  paperAuditJsx.includes('Iniciar auditor') && paperAuditJsx.includes('Detener') &&
  paperAuditJsx.includes('Papel solamente') && paperAuditJsx.includes('nunca envía órdenes') &&
  paperAuditJsx.includes('Render gratis duerme'));
check('index.css trae estilos mínimos .audit-table y VERSION.txt documenta v16.1',
  css.includes('.audit-table') && versionTxt.includes('v16.1') && versionTxt.includes('paper_audit'));
check('el motor de señal no menciona al auditor (kalshi.js, analysis.js, verdict.js, windowOutcome.js intactos)',
  ['client/src/kalshi.js', 'client/src/analysis.js', 'client/src/verdict.js', 'client/src/windowOutcome.js']
    .every((p) => !src(p).includes('paperAuditor') && !src(p).includes('paper_audit')));

console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
