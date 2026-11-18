// paper_sniper.js — AUDITORÍA EN PAPEL (sin dinero real, sin llaves de Kalshi)
// ============================================================================
// Qué hace: audita si existe edge neto en KXBTC15M usando el BRTI oficial de
// tu app cripto-en-vivo, sin enviar ninguna orden a Kalshi.
//
// Correcciones aplicadas frente a las versiones anteriores:
//  1. NO usa Coinbase spot. Lee BRTI desde GET /api/kalshi/brti de tu
//     servidor (server/brti.js -> WS wss://external-api-ws.kalshi.com/
//     trade-api/ws/v2, canal cfbenchmarks_value, index_ids ["BRTI"]).
//     No existe /api/brti (da 404). La ruta real exige JWT.
//  2. NO reconstruye el promedio desde avg60s ni avg15mFinal. Esos dos
//     campos se loguean SOLO como diagnóstico. El promedio bloqueado se
//     construye muestreando `value` (tick BRTI instantáneo) 1 vez por
//     segundo dentro del minuto final, en un Map por segundo epoch.
//     avg60s es trailing 60s (incluye segundos de ANTES del minuto
//     final), así que `avg60s * N` NO es la suma bloqueada. Tu propia
//     app (client/src/kalshi.js, brtiWinning) decide con avg60s, nunca
//     con avg15mFinal, y avg15mFinal se retiene aunque el tick no lo
//     traiga: no se usa como input del salto requerido.
//  3. Deduplica por updatedAt. Si el servidor no ha recibido tick nuevo
//     del WS, no cuenta el mismo `value` dos veces como si fueran dos
//     segundos distintos. Ese segundo queda como tick perdido y, si
//     faltan >2 ticks, no se registra señal.
//  4. Reloj anclado al segundo exacto de cierre. Si el script arranca
//     con un contrato al que le quedan <=60s, lo descarta y espera la
//     siguiente ventana para tener los 60 ticks completos.
//  5. Payload V2 real verificado contra docs.kalshi.com (Create Order
//     V2, actualizado 2026-11-18): POST /trade-api/v2/portfolio/
//     events/orders, single-book perspectiva YES. Campos: ticker,
//     client_order_id, side ("bid"|"ask"), count ("2.00"), price
//     ("0.8500"), time_in_force, self_trade_prevention_type.
//     NO son `price_dollars` / `size` / `action` / `yes_price_dollars`.
//     `bid` = comprar YES, `ask` = vender YES (= comprar NO a 1-price).
//     time_in_force es `immediate_or_cancel`: una orden sniper no debe
//     quedar resting pasada la liquidación. Esto es SOLO preview en
//     papel: este script NUNCA hace POST a Kalshi.
//  6. Consulta puntual al ticker exacto: GET /trade-api/v2/markets/
//     ${ticker} (no la lista), y verifica quote.ticker === contrato.
//     La lista solo se usa cada 15s para descubrir el próximo ticker.
//  7. JWT: CEV_JWT dura 7 días (server/auth.js, expiresIn '7d'). Si da
//     401, el script PARA con mensaje claro para volver a loguearte.
//     No hace loop infinito con token caducado.
//
// Cómo sacar CEV_JWT (solo local, nunca lo subas a Git ni a Render):
//   1. Entra a https://cripto-en-vivo.onrender.com con tu cuenta
//      (con Kalshi ya conectado en el panel).
//   2. En la consola del navegador (F12): localStorage.getItem('cev_token_v1')
//   3. En tu terminal:
//      Linux/macOS:  export CEV_JWT='pega-aqui-el-token'
//      Windows PowerShell:  $env:CEV_JWT='pega-aqui-el-token'
//   4. Corre:  node paper_sniper.js
//   5. Déjalo 10-20 ventanas (~2.5-5 h). Revisa paper_results.jsonl:
//      - twapLocal vs brtiLiquidacionOficial: si difiere >$1-2, el
//        muestreo tiene ruido y la señal no es fiable.
//      - viableDespuesDeComision: solo cuenta si ask + fee deja
//        ganancia neta >= MIN_NET_EDGE_DOLLARS.
//
// REGLA DURA: papel solamente. No hay envío de órdenes, no hay clave
// privada en este archivo, no se toca el fondo de emergencia.
const fs = require('fs');
const crypto = require('crypto');

// ================= 1. CONFIGURACIÓN EXACTA =================
const CONFIG = {
  BASE_URL: 'https://api.elections.kalshi.com',
  SERIES_TICKER: 'KXBTC15M',
  BRTI_FEED_URL: process.env.BRTI_FEED_URL || 'https://cripto-en-vivo.onrender.com/api/kalshi/brti',
  CEV_JWT: process.env.CEV_JWT || '',
  CONTRACTS_QTY: 2.00,
  MIN_REQ_MOVE_USD: 95,
  MIN_NET_EDGE_DOLLARS: 0.015,
  LOG_FILE: './paper_results.jsonl'
};

if (!CONFIG.CEV_JWT) {
  console.error('❌ Falta CEV_JWT. Sácalo con localStorage.getItem(\'cev_token_v1\') en cripto-en-vivo (ya logueado) y exporta CEV_JWT en tu terminal local. Dura 7 días.');
  process.exit(1);
}

// Comisión taker Kalshi: 0.07 * P * (1 - P) por contrato
function calcularComisionPorContrato(precioDollars) {
  return 0.07 * precioDollars * (1 - precioDollars);
}

// Payload V2 real (solo preview, no se envía):
// docs.kalshi.com/api-reference/orders/create-order-v2
// side "bid" = comprar YES, side "ask" = vender YES (= comprar NO a 1-price)
function construirPayloadOrdenV2(ticker, direccion, askPriceDollars, qty) {
  const isYes = direccion === 'yes';
  // Comprar YES -> bid a yesAsk. Comprar NO -> ask a (1 - noAsk).
  const yesBookPrice = isYes ? askPriceDollars : (1 - askPriceDollars);
  return {
    endpoint: '/trade-api/v2/portfolio/events/orders',
    payload: {
      ticker: ticker,
      client_order_id: crypto.randomUUID(),
      side: isYes ? 'bid' : 'ask',
      count: qty.toFixed(2), // "2.00"
      price: yesBookPrice.toFixed(4), // "0.8500", siempre en perspectiva YES
      time_in_force: 'immediate_or_cancel',
      self_trade_prevention_type: 'taker_at_cross'
    }
  };
}

// ================= 2. LECTURA DE BRTI Y MERCADO ESPECÍFICO =================
async function obtenerEstadoBRTI() {
  const res = await fetch(CONFIG.BRTI_FEED_URL, {
    headers: { Authorization: `Bearer ${CONFIG.CEV_JWT}` }
  });
  if (res.status === 401) {
    const err = new Error('AUTH_401: CEV_JWT caducado o inválido. Vuelve a entrar a cripto-en-vivo y exporta un CEV_JWT nuevo (localStorage cev_token_v1).');
    err.code = 'AUTH_401';
    throw err;
  }
  if (!res.ok) {
    throw new Error(`GET /api/kalshi/brti devolvió HTTP ${res.status}`);
  }
  const data = await res.json();
  // Sin Kalshi conectado o dato stale, no se audita en falso.
  if (!data.connected || data.stale || data.source !== 'kalshi') {
    return null;
  }
  return {
    value: Number(data.value),
    avg60s: Number(data.avg60s),
    avg15mFinal: Number(data.avg15mFinal),
    updatedAt: data.updatedAt || null
  };
}

// Solo cada 15s cuando no hay contrato activo, para descubrir el próximo ticker
async function descubrirProximoContrato() {
  const url = `${CONFIG.BASE_URL}/trade-api/v2/markets?series_ticker=${CONFIG.SERIES_TICKER}&status=open`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} al listar serie`);
  const data = await res.json();

  const ahora = Date.now();
  const abiertos = (data.markets || [])
    .filter(m => new Date(m.close_time).getTime() > ahora)
    .sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime());

  if (abiertos.length === 0) return null;
  const m = abiertos[0];

  return {
    ticker: m.ticker,
    targetPrice: Number(m.floor_strike ?? m.strike_price),
    closeMs: new Date(m.close_time).getTime(),
    closeIso: m.close_time
  };
}

// Consulta directa al ticker fijo para garantizar que el libro corresponde a contrato.ticker
async function obtenerQuoteContrato(ticker) {
  const url = `${CONFIG.BASE_URL}/trade-api/v2/markets/${encodeURIComponent(ticker)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const { market: m } = await res.json();
  if (!m) return null;

  const yesAsk = m.yes_ask_dollars != null ? parseFloat(m.yes_ask_dollars) : null;
  const yesBid = m.yes_bid_dollars != null ? parseFloat(m.yes_bid_dollars) : null;
  const noAsk = m.no_ask_dollars != null
    ? parseFloat(m.no_ask_dollars)
    : (yesBid !== null ? +(1 - yesBid).toFixed(4) : null);

  return {
    ticker: m.ticker,
    status: m.status,
    result: m.result || null,
    expirationValue: m.expiration_value != null ? Number(m.expiration_value) : null,
    yesAskDollars: yesAsk,
    yesBidDollars: yesBid,
    noAskDollars: noAsk
  };
}

// ================= 3. MOTOR DE AUDITORÍA EN PAPEL =================
let contrato = null;
let ultimoDescubrimientoMs = 0;
let ultimoHeartbeatBrtiMs = 0;
let simulacionRegistrada = null;
let ultimoBrtiValido = null;
let muestrasPorSegundo = new Map(); // epochSecond -> BRTI value (solo ticks frescos)
let ultimoUpdatedAtVisto = null;

async function cicloPorSegundo() {
  const ahoraMs = Date.now();
  const segActualEpoch = Math.floor(ahoraMs / 1000);

  try {
    // 1. Descubrir contrato cada 15 segundos si no hay uno cargado
    if (!contrato) {
      if (ahoraMs - ultimoDescubrimientoMs < 15000) return;
      ultimoDescubrimientoMs = ahoraMs;

      const nuevo = await descubrirProximoContrato();
      if (!nuevo || isNaN(nuevo.targetPrice)) return;

      const segParaCierre = Math.floor(nuevo.closeMs / 1000) - segActualEpoch;
      if (segParaCierre <= 60) {
        console.log(`⚠️ [${nuevo.ticker}] Ya está dentro del último minuto (${segParaCierre}s). Esperando la siguiente ventana para tener los 60 ticks completos.`);
        return;
      }

      contrato = nuevo;
      muestrasPorSegundo = new Map();
      ultimoUpdatedAtVisto = null;
      simulacionRegistrada = null;
      ultimoBrtiValido = null;
      console.log(`\n🎯 [PAPER] Contrato fijado: ${contrato.ticker} | Target BRTI: $${contrato.targetPrice.toFixed(2)} | Cierre: ${contrato.closeIso}`);
      return;
    }

    const closeEpochSec = Math.floor(contrato.closeMs / 1000);
    const R = closeEpochSec - segActualEpoch; // Segundos reales restantes hasta el cierre

    // 2. Fuera del último minuto: sondear /api/kalshi/brti cada 30s
    //    para que server/brti.js no cierre el WS por inactividad de 5 min.
    if (R > 60) {
      if (ahoraMs - ultimoHeartbeatBrtiMs >= 30000) {
        ultimoHeartbeatBrtiMs = ahoraMs;
        const brti = await obtenerEstadoBRTI();
        const valStr = brti && !isNaN(brti.value) ? `$${brti.value.toFixed(2)}` : 'conectando...';
        process.stdout.write(`\r⏳ [${contrato.ticker}] Faltan ${R}s | BRTI: ${valStr} | Target: $${contrato.targetPrice.toFixed(2)}   `);
      }
      return;
    }

    // 3. Ventana del último minuto (T-60 a T-1)
    if (R >= 1 && R <= 60) {
      const [brti, quote] = await Promise.all([
        obtenerEstadoBRTI(),
        obtenerQuoteContrato(contrato.ticker)
      ]);

      if (!brti || isNaN(brti.value)) {
        console.log(`⚠️ [T-${R}s] Feed /api/kalshi/brti desconectado o stale. No se suma muestra.`);
        return;
      }
      ultimoBrtiValido = brti;

      // Solo suma la muestra si el tick es fresco (updatedAt cambió).
      // Si el WS no empujó tick nuevo, este segundo queda como perdido.
      const esTickFresco = brti.updatedAt !== ultimoUpdatedAtVisto;
      if (esTickFresco) {
        ultimoUpdatedAtVisto = brti.updatedAt;
        muestrasPorSegundo.set(segActualEpoch, brti.value);
      }

      const ticks = Array.from(muestrasPorSegundo.values());
      const N = ticks.length;
      const ticksEsperados = 61 - R; // segundos transcurridos en el minuto final, incluyendo el actual
      const ticksPerdidos = Math.max(ticksEsperados - N, 0);
      const sumaAcumulada = ticks.reduce((a, b) => a + b, 0);
      const promedioBloqueado = N > 0 ? sumaAcumulada / N : NaN;
      const segundosRestantesReales = Math.max(R - 1, 0);

      const totalMuestrasEfectivas = N + segundosRestantesReales;
      const brtiRequeridoRestante = segundosRestantesReales > 0 && N > 0
        ? ((contrato.targetPrice * totalMuestrasEfectivas) - sumaAcumulada) / segundosRestantesReales
        : promedioBloqueado;
      const saltoRequeridoUSD = brtiRequeridoRestante - brti.value;

      const yesAsk = quote?.yesAskDollars ?? null;
      const noAsk = quote?.noAskDollars ?? null;

      console.log(
        `[T-${R}s | Ticks: ${N}/${ticksEsperados} (perdidos:${ticksPerdidos}${esTickFresco ? '' : ', dup'})] BRTI: $${brti.value.toFixed(2)} | TWAP bloqueado: $${isNaN(promedioBloqueado) ? 'N/A' : promedioBloqueado.toFixed(2)} | avg60s(diag): $${isNaN(brti.avg60s) ? 'N/A' : brti.avg60s.toFixed(2)} | avg15mFinal(diag): $${isNaN(brti.avg15mFinal) ? 'N/A' : brti.avg15mFinal.toFixed(2)} | Salto req: ${saltoRequeridoUSD > 0 ? '+' : ''}$${saltoRequeridoUSD.toFixed(2)} | Ask YES: $${yesAsk?.toFixed(4) ?? 'N/A'} | Ask NO: $${noAsk?.toFixed(4) ?? 'N/A'}`
      );

      // Evaluar señal en papel entre T-18s y T-3s, solo con <=2 ticks perdidos
      if (!simulacionRegistrada && R <= 18 && R >= 3 && ticksPerdidos <= 2 && quote?.ticker === contrato.ticker) {
        let direccion = null;
        let askDisponible = null;

        if (saltoRequeridoUSD <= -CONFIG.MIN_REQ_MOVE_USD) {
          direccion = 'yes';
          askDisponible = yesAsk;
        } else if (saltoRequeridoUSD >= CONFIG.MIN_REQ_MOVE_USD) {
          direccion = 'no';
          askDisponible = noAsk;
        }

        if (direccion && askDisponible !== null && askDisponible > 0 && askDisponible < 1.00) {
          const fee = calcularComisionPorContrato(askDisponible);
          const costoTotal = askDisponible + fee;
          const gananciaNeta = 1.00 - costoTotal;

          simulacionRegistrada = {
            timestamp: new Date().toISOString(),
            ticker: contrato.ticker,
            segundosRestantes: R,
            direccionElegida: direccion,
            targetPrice: contrato.targetPrice,
            brtiValue: brti.value,
            brtiAvg60s: isNaN(brti.avg60s) ? null : +brti.avg60s.toFixed(2),
            brtiAvg15mFinal: isNaN(brti.avg15mFinal) ? null : +brti.avg15mFinal.toFixed(2),
            twapBloqueado: +promedioBloqueado.toFixed(2),
            muestrasCapturadas: N,
            ticksPerdidos: ticksPerdidos,
            saltoRequeridoUSD: +saltoRequeridoUSD.toFixed(2),
            askPriceDollars: askDisponible.toFixed(4),
            feePerContractDollars: +fee.toFixed(4),
            breakEvenProb: +(costoTotal * 100).toFixed(2),
            netProfitIfWinPerContract: +gananciaNeta.toFixed(4),
            viableDespuesDeComision: gananciaNeta >= CONFIG.MIN_NET_EDGE_DOLLARS,
            ordenV2Preview: construirPayloadOrdenV2(contrato.ticker, direccion, askDisponible, CONFIG.CONTRACTS_QTY)
          };

          console.log(
            `\n📝 [SEÑAL EN PAPEL - ${direccion.toUpperCase()}] Ask: $${askDisponible.toFixed(4)} | Fee: $${fee.toFixed(4)} | Break-Even: ${(costoTotal * 100).toFixed(2)}% | Neto/contrato: $${gananciaNeta.toFixed(4)} | Viable: ${simulacionRegistrada.viableDespuesDeComision ? 'SÍ' : 'NO'}`
          );
        }
      }
      return;
    }

    // 4. Cierre de ventana (R <= 0): comparar TWAP local contra liquidación oficial
    if (R <= 0) {
      const tickerCerrado = contrato.ticker;
      const targetCerrado = contrato.targetPrice;
      const ticks = Array.from(muestrasPorSegundo.values());
      const twapLocal = ticks.length > 0 ? ticks.reduce((a, b) => a + b, 0) / ticks.length : NaN;
      const snapshotCierre = ultimoBrtiValido;
      const sim = simulacionRegistrada;

      contrato = null;
      ultimoDescubrimientoMs = 0;

      console.log(`\n🏁 [${tickerCerrado}] Cerrado. TWAP local (${ticks.length} muestras): $${isNaN(twapLocal) ? 'N/A' : twapLocal.toFixed(2)}. Verificando liquidación en 15s...`);

      const registrarResultado = (oficial, intento) => {
        const registro = {
          ticker: tickerCerrado,
          targetPrice: targetCerrado,
          muestrasCapturadas: ticks.length,
          twapLocal: isNaN(twapLocal) ? null : +twapLocal.toFixed(2),
          prediccionLocal: isNaN(twapLocal) ? null : (twapLocal >= targetCerrado ? 'yes' : 'no'),
          avg60sCapturado: snapshotCierre && !isNaN(snapshotCierre.avg60s) ? +snapshotCierre.avg60s.toFixed(2) : null,
          avg15mFinalCapturado: snapshotCierre && !isNaN(snapshotCierre.avg15mFinal) ? +snapshotCierre.avg15mFinal.toFixed(2) : null,
          resultadoOficialKalshi: oficial?.result || 'pendiente',
          brtiLiquidacionOficial: oficial?.expirationValue ?? null,
          errorTwapVsOficial: (oficial?.expirationValue != null && !isNaN(twapLocal))
            ? +(twapLocal - oficial.expirationValue).toFixed(2)
            : null,
          intentoLiquidacionSeg: intento,
          simulacion: sim
        };
        fs.appendFileSync(CONFIG.LOG_FILE, JSON.stringify(registro) + '\n');
        console.log(`📊 [AUDITORÍA ${intento}s] ${tickerCerrado} -> TWAP local: $${registro.twapLocal} (${registro.prediccionLocal}) | Oficial Kalshi: ${registro.brtiLiquidacionOficial} (${registro.resultadoOficialKalshi}) | Error: ${registro.errorTwapVsOficial ?? 'N/A'}`);
      };

      setTimeout(async () => {
        let oficial = null;
        try { oficial = await obtenerQuoteContrato(tickerCerrado); } catch { oficial = null; }
        if (oficial && oficial.result && oficial.expirationValue != null) {
          registrarResultado(oficial, 15);
        } else {
          console.log(`⏳ [${tickerCerrado}] Liquidación oficial aún pendiente a los 15s. Reintentando a los 45s...`);
          setTimeout(async () => {
            let oficial45 = null;
            try { oficial45 = await obtenerQuoteContrato(tickerCerrado); } catch { oficial45 = null; }
            registrarResultado(oficial45 || oficial, 45);
          }, 30000);
        }
      }, 15000);
    }
  } catch (err) {
    if (err && err.code === 'AUTH_401') {
      console.error(`\n❌ ${err.message}`);
      console.error('El script se detiene. No sigas con token caducado.');
      process.exit(1);
    }
    console.error('❌ Error en ciclo:', err.message);
  }
}

// Sincronizar al borde del segundo del sistema
const msHastaProximoSegundo = 1000 - (Date.now() % 1000);
setTimeout(() => {
  cicloPorSegundo();
  setInterval(cicloPorSegundo, 1000);
}, msHastaProximoSegundo);
