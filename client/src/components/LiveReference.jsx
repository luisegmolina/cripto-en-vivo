// LiveReference.jsx — v16.0: §3 Termómetro de Liquidación en Tiempo Real
// Compara el Promedio BRTI de 60 s (el único que liquida en Kalshi) contra el
// Precio Objetivo de la ventana, sin párrafos repetitivos.
import { fmtClock, fmtCountdown } from '../kalshi.js';

export default function LiveReference({ symbol, currency, kalshiWin, kalshiTargetPrice, kalshiMarket, kalshiPrice, kalshiRefSource, brti, brtiDiff, brtiDiffPct, fmt, user, marketMovement = null }) {
  return (
    <>
      <div className="section-header">
        <h2>3 · Referencia en tiempo real — {symbol} · ventana 15 min</h2>
        <span className="muted">MODO KALSHI 15 MIN · Ventana {fmtClock(kalshiWin.startMs)} – {fmtClock(kalshiWin.endMs)}</span>
      </div>

      <div className="stats">
        <div>
          <span>Cierra en</span>
          <b className="countdown">{fmtCountdown(kalshiWin.remainingMs)}</b>
        </div>
        <div>
          <span>Precio objetivo (Kalshi)</span>
          <b>{kalshiTargetPrice ? fmt(kalshiTargetPrice, currency) : '—'}</b>
        </div>
        <div>
          <span>Promedio de 60 s (el que liquida)</span>
          <b className={brtiDiff != null ? (brtiDiff >= 0 ? 'up' : 'down') : ''}>
            {brti && brti.source === 'kalshi' && brti.avg60s != null ? fmt(brti.avg60s, currency) : '—'}
          </b>
        </div>
        <div>
          <span>Precio SÍ / NO (Kalshi)</span>
          <b>{kalshiMarket && kalshiMarket.source === 'kalshi' && kalshiMarket.yesAskCents != null ? `SÍ ${kalshiMarket.yesAskCents}¢ · NO ${kalshiMarket.noAskCents ?? '—'}¢` : '—'}</b>
        </div>
      </div>

      <div className="score-bar" aria-hidden="true"><div style={{ width: `${kalshiWin.elapsedPct}%`, background: '#f59e0b' }} /></div>

      {kalshiRefSource !== 'kalshi' && (
        <p className="warn">⚠️ Precio de referencia de Coinbase, no de Kalshi: la API pública de Kalshi no devolvió el mercado actual, así que la referencia es la apertura de la vela 15m de Coinbase.</p>
      )}

      {brti == null ? (
        <p className="muted">Cargando valor en vivo de Kalshi (BRTI)…</p>
      ) : brti.source === 'kalshi' && brti.value != null ? (
        <div className="signal" style={{ borderColor: brtiDiff != null && brtiDiff >= 0 ? '#10b981' : brtiDiff != null ? '#f43f5e' : '#334155' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>BRTI ahora: {fmt(brti.value, currency)}</b>
            <span className="muted">Actualizado: {brti.updatedAt ? new Date(brti.updatedAt).toLocaleTimeString('es-US', { hour12: false }) : '—'}{brti.stale ? ' · ⚠️ Desactualizado' : ''}</span>
          </div>
          {kalshiTargetPrice && brtiDiff != null ? (
            <span>
              Diferencia contra el objetivo {fmt(kalshiTargetPrice, currency)}: <b className={brtiDiff >= 0 ? 'up' : 'down'}>{brtiDiff >= 0 ? '+' : '−'}{fmt(Math.abs(brtiDiff), currency)} ({brtiDiffPct >= 0 ? '+' : ''}{brtiDiffPct.toFixed(3)}%)</b>
              {marketMovement && marketMovement.atrMultiple != null ? ` · Colchón: ${marketMovement.atrMultiple >= 0 ? '+' : ''}${marketMovement.atrMultiple.toFixed(2)} ATR 15m` : ''}
            </span>
          ) : (
            <span className="muted">Promedio de 60 s no disponible: sin él no se puede saber si vas ganando ni la diferencia contra el objetivo.</span>
          )}
          <span className="muted">Regla Kalshi: el objetivo es el promedio de 60 s antes de la apertura y el cierre se compara contra ese objetivo con el promedio de 60 s antes del cierre.</span>
        </div>
      ) : (
        <div className="signal" style={{ borderColor: '#f59e0b' }}>
          <b>⚠️ Sin valor en vivo de Kalshi — Precio de Coinbase ahora: {kalshiPrice ? fmt(kalshiPrice, currency) : '—'}</b>
          <span className="muted">
            {user ? (brti.status === 'error' ? `WebSocket sin dato (${brti.error || 'error'})` : 'Esperando primer tick BRTI') : 'Conecta tu cuenta Kalshi abajo para recibir el índice BRTI oficial'} · Actualizado: {brti.updatedAt ? new Date(brti.updatedAt).toLocaleTimeString('es-US', { hour12: false }) : '—'}
          </span>
        </div>
      )}
    </>
  );
}
