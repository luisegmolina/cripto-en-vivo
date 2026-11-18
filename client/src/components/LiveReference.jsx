// LiveReference.jsx — v15.3: §3 Referencia en tiempo real (BRTI, objetivo,
// diferencia, cuenta atrás, SÍ/NO). Solo presenta: los datos llegan por
// props desde App.jsx; la lógica (sondeos, promedio de 60 s) no vive aquí.
import { fmtClock, fmtCountdown } from '../kalshi.js';

export default function LiveReference({ symbol, currency, kalshiWin, kalshiTargetPrice, kalshiMarket, kalshiPrice, kalshiRefSource, brti, brtiDiff, brtiDiffPct, fmt, user }) {
  return (
    <>
      <p className="verdict-kicker">MODO KALSHI 15 MIN · {symbol} · VENTANA DE 15 MINUTOS · EDUCATIVO, NO ES RECOMENDACIÓN DE APUESTA</p>
      <h2>3 · Referencia en tiempo real — BTC · ventana 15 min</h2>
      <div className="stats">
        <div><span>Ventana actual</span><b>{fmtClock(kalshiWin.startMs)} – {fmtClock(kalshiWin.endMs)}</b></div>
        <div><span>Cierra en</span><b className="countdown">{fmtCountdown(kalshiWin.remainingMs)}</b></div>
        <div><span>Precio objetivo (Kalshi)</span><b>{kalshiTargetPrice ? fmt(kalshiTargetPrice, currency) : '—'}</b></div>
        <div><span>Precio SÍ / NO (Kalshi)</span><b>{kalshiMarket && kalshiMarket.source === 'kalshi' && kalshiMarket.yesAskCents != null ? `SÍ ${kalshiMarket.yesAskCents}¢ · NO ${kalshiMarket.noAskCents ?? '—'}¢` : '—'}</b></div>
      </div>
      <div className="score-bar" aria-hidden="true"><div style={{ width: `${kalshiWin.elapsedPct}%`, background: '#f59e0b' }} /></div>
      <p className="muted">Precio objetivo: el precio contra el que se liquida esta ventana. El precio SÍ/NO es lo que cuesta el contrato en centavos, no la probabilidad de acierto de la señal.</p>
      <p className="muted">Cómo liquida Kalshi: el objetivo es el promedio de 60 s antes de la apertura; el cierre se compara contra ese objetivo con el promedio de 60 s antes del cierre. El valor instantáneo que parpadea no liquida.</p>
      {kalshiRefSource !== 'kalshi' && (
        <p className="warn">⚠️ Precio de referencia de Coinbase, no de Kalshi: la API pública de Kalshi no devolvió el mercado actual, así que la referencia es la apertura de la vela 15m de Coinbase.</p>
      )}

      {/* v13.5: VALOR EN VIVO DE KALSHI (BRTI) — el número que
          liquida la ventana, no Coinbase. El promedio de 60 s es
          el que decide: si al cerrar está por encima del objetivo
          gana SÍ, si no gana NO. GANANDO/PERDIENDO se calcula
          contra ese promedio para tu primera posición real
          abierta; sin posición real, solo se dice si el BRTI está
          por encima o por debajo del objetivo. Sin Kalshi
          conectado o sin dato del WS, se muestra Coinbase con
          aviso, nunca en blanco y nunca un número inventado. */}
      {brti == null ? (
        <p className="muted">Cargando valor en vivo de Kalshi (BRTI)…</p>
      ) : brti.source === 'kalshi' && brti.value != null ? (
        <div className="signal" style={{ borderColor: brtiDiff != null && brtiDiff >= 0 ? '#22c55e' : brtiDiff != null ? '#ef4444' : '#94a3b8' }}>
          <b style={{ fontSize: 26 }}>BRTI ahora: {fmt(brti.value, currency)}</b>
          <span>Promedio de 60 s (el que liquida): <b>{brti.avg60s != null ? fmt(brti.avg60s, currency) : '— (aún no disponible: sin promedio no se puede saber si vas ganando; el valor instantáneo no liquida)'}</b>{brti.avg15mFinal != null && (<> · Promedio final de la ventana: <b>{fmt(brti.avg15mFinal, currency)}</b></>)}</span>
          {kalshiTargetPrice && brtiDiff != null && (
            <span>Diferencia contra el objetivo {fmt(kalshiTargetPrice, currency)}: <b className={brtiDiff >= 0 ? 'up' : 'down'}>{brtiDiff >= 0 ? '+' : '−'}{fmt(Math.abs(brtiDiff), currency)} ({brtiDiffPct >= 0 ? '+' : ''}{brtiDiffPct.toFixed(3)}%)</b> · referencia: promedio de 60 s</span>
          )}
          {kalshiTargetPrice && brtiDiff == null && (
            <span className="muted">Promedio de 60 s no disponible: sin él no se puede saber si vas ganando ni la diferencia contra el objetivo. El valor instantáneo de arriba no liquida.</span>
          )}
          <span className="muted">Fuente: BRTI en vivo (Kalshi). Actualizado: {brti.updatedAt ? new Date(brti.updatedAt).toLocaleTimeString('es-US', { hour12: false }) : '—'}{brti.stale ? ' · ⚠️ Dato con más de 15 s: puede estar desactualizado.' : ''}</span>
        </div>
      ) : (
        <div className="signal" style={{ borderColor: '#f59e0b' }}>
          <b style={{ fontSize: 22 }}>⚠️ Sin valor en vivo de Kalshi</b>
          <span>{user ? (brti.status === 'error' ? `El WebSocket de Kalshi no está dando el valor (${brti.error || 'sin dato'})` : 'Aún no llega el primer tick de Kalshi') : 'Entra con tu cuenta y conecta Kalshi para ver el valor en vivo que liquida'} — se muestra el precio de Coinbase mientras tanto.</span>
          <span>Precio de Coinbase ahora: <b>{kalshiPrice ? fmt(kalshiPrice, currency) : '—'}</b> · puede diferir del de liquidación (BRTI).</span>
          <span className="muted">Actualizado: {brti.updatedAt ? new Date(brti.updatedAt).toLocaleTimeString('es-US', { hour12: false }) : '—'}</span>
        </div>
      )}
    </>
  );
}
