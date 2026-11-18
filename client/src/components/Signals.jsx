// Signals.jsx — v16.0: §4 Radar de Movimiento del Mercado (1m, 5m, 15m, 1h)
// + Simulador opcional plegado para no estorbar la vista principal.
import { strengthForScore } from '../kalshi.js';
import { isCoinFlip } from '../stats.js';

export default function Signals({
  kalshiVerdict, kalshiWeakSignal, kalshiScore, kalshiProbAdj,
  kalshiBacktest, kalshiRecent, kalshiReasons,
  kalshiEntryPrice, onKalshiEntryPrice, kalshiDir, onKalshiDir,
  kalshiAmount, onKalshiAmount, onSaveKalshiPosition, onClearKalshiPosition,
  kalshiMsg, kalshiDecision, kalshiPrice, kalshiEntryNum, kalshiExitPrice,
  kalshiAtr, currency, currencySym, fmt, marketMovement = null,
}) {
  return (
    <>
      <div className="section-header">
        <h2>4 · Radar de Señales y Movimiento del Mercado</h2>
        <span className="muted">ATR 15m: <b>{kalshiAtr ? fmt(kalshiAtr, currency) : '—'}</b></span>
      </div>

      <div className="verdict-main">
        <div className={`verdict-word ${kalshiVerdict.key === 'up' ? 'up' : kalshiVerdict.key === 'down' ? 'down' : ''}`}>
          {kalshiVerdict.icon} {kalshiVerdict.label}{kalshiWeakSignal && (<span> · ⚠️ SEÑAL DÉBIL</span>)}
        </div>
        <div className="verdict-meta">
          <span>Puntuación 15m: <b>{kalshiScore}</b></span>
          <span>Fuerza: <b>{strengthForScore(kalshiScore)}</b></span>
          <span>Índice de coincidencia: <b>{kalshiProbAdj}/100</b></span>
        </div>
      </div>

      {marketMovement && (
        <>
          <div className="stats">
            <div>
              <span>Impulso en vivo</span>
              <b className={marketMovement.dir === 'up' ? 'up' : marketMovement.dir === 'down' ? 'down' : ''}>
                {marketMovement.speedLabel} ({marketMovement.impulseScore >= 0 ? `+${marketMovement.impulseScore}` : marketMovement.impulseScore})
              </b>
            </div>
            <div>
              <span>Vela 15m actual</span>
              <b className={marketMovement.candleDelta != null ? (marketMovement.candleDelta >= 0 ? 'up' : 'down') : ''}>
                {marketMovement.candleDelta != null ? `${marketMovement.candleDelta >= 0 ? '+' : '−'}${fmt(Math.abs(marketMovement.candleDelta), currency)} (${marketMovement.candleDeltaPct >= 0 ? '+' : ''}${marketMovement.candleDeltaPct.toFixed(2)}%)` : '—'}
              </b>
            </div>
            <div>
              <span>Avance 3 velas</span>
              <b className={marketMovement.roc3Pct != null ? (marketMovement.roc3Pct >= 0 ? 'up' : 'down') : ''}>
                {marketMovement.roc3Pct != null ? `${marketMovement.roc3Pct >= 0 ? '+' : ''}${marketMovement.roc3Pct.toFixed(2)}%` : '—'}
              </b>
            </div>
            <div>
              <span>Alineación temporal</span>
              <b>{marketMovement.upTfs} alcistas · {marketMovement.downTfs} bajistas</b>
            </div>
          </div>

          <div className="tf-matrix" aria-label="Plazos (1m / 5m / 15m / 1h)">
            {marketMovement.tfBreakdown.map((t) => (
              <div key={t.tf} className={`tf-pill ${t.dir === 'up' ? 'tf-up' : t.dir === 'down' ? 'tf-down' : ''}`}>
                <small>{t.tf}</small>
                <b>{t.label}</b>
              </div>
            ))}
          </div>
        </>
      )}

      {kalshiBacktest.total >= 5 && kalshiBacktest.ci95 && (
        <p className="muted">
          Medido como liquida Kalshi: acertó {kalshiBacktest.wins} de {kalshiBacktest.total} ({kalshiBacktest.pct}%; IC 95%: {kalshiBacktest.ci95.low}–{kalshiBacktest.ci95.high}%).{isCoinFlip(kalshiBacktest.ci95) ? ' Con estas muestras no se distingue de lanzar una moneda.' : ''}
        </p>
      )}
      {kalshiWeakSignal && (
        <p className="warn">⚠️ SEÑAL DÉBIL — Últimas {kalshiRecent.total} ventanas con señal clara: acertó {kalshiRecent.wins} ({Math.round(kalshiRecent.rate * 100)}%). Está fallando últimamente: reduce el tamaño de apuesta. Medido como liquida Kalshi.</p>
      )}

      {/* v16.0 (restaurado por Muse al verificar): el ZIP recibía kalshiReasons
          pero nunca lo renderizaba, y quitaba el pie del índice. Ambos son
          información honesta: las razones de la señal y que el índice NO es
          una probabilidad de ganar. */}
      {kalshiReasons.length > 0 && (
        <ul className="reasons">
          {kalshiReasons.map((r, i) => (
            <li key={i} className={`reason-${r.dir}`}><b>{r.icon}</b> {r.text}</li>
          ))}
        </ul>
      )}
      <p className="muted">* Índice propio (puntuación + timeframes que coinciden). NO es una probabilidad de ganar y NO es la probabilidad oficial de Kalshi. Una señal que acertó ~56% en 1h puede fallar en 15 minutos.</p>

      {/* Simulador virtual plegado para que no estorbe la pantalla */}
      <details className="account-details">
        <summary>🧮 Simulador manual: ¿Cobro o me quedo?</summary>
        <h3>¿Cobro o me quedo?</h3>
        <div className="row" style={{ marginTop: 8 }}>
          <label>Entrada ({currencySym}): <input type="number" min="0" step="1" value={kalshiEntryPrice} placeholder={kalshiPrice ? String(Math.round(kalshiPrice)) : ''} onChange={(e) => onKalshiEntryPrice(e.target.value)} /></label>
          <label>Dirección: <select value={kalshiDir} onChange={(e) => onKalshiDir(e.target.value)}>
            <option value="up">Aposté a que SUBE</option>
            <option value="down">Aposté a que BAJA</option>
          </select></label>
          <label>Cantidad ({currencySym}): <input type="number" min="1" step="10" value={kalshiAmount} onChange={(e) => onKalshiAmount(e.target.value)} /></label>
          <button className="primary" onClick={onSaveKalshiPosition}>Guardar</button>
          <button onClick={onClearKalshiPosition}>Borrar</button>
        </div>
        {kalshiMsg && <p className="muted">{kalshiMsg}</p>}
        <div className="signal" style={{ borderColor: kalshiDecision.color }}>
          <b style={{ color: kalshiDecision.color }}>{kalshiDecision.label} — {kalshiDecision.title}</b>
          <span>{kalshiDecision.text}</span>
          {kalshiDecision.pnl != null && (
            <span>P&amp;L virtual: <b className={kalshiDecision.pnl >= 0 ? 'up' : 'down'}>{kalshiDecision.pnl >= 0 ? '+' : ''}{fmt(kalshiDecision.pnl, currency)} ({kalshiDecision.pnlPct >= 0 ? '+' : ''}{kalshiDecision.pnlPct.toFixed(2)}%)</b></span>
          )}
          {kalshiExitPrice && (
            <span>Nivel sugerido de salida: <b>{fmt(kalshiExitPrice, currency)}</b></span>
          )}
        </div>
      </details>
    </>
  );
}
