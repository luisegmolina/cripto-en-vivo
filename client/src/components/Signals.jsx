// Signals.jsx — v15.3 / v15.5: §4 Señales del mercado (veredicto 15m, fuerza,
// índice de coincidencia, desglose multitemporal en vivo, aviso de señal débil,
// backtest 15m medido como liquida Kalshi, razones) + ¿Cobro o me quedo? (posición virtual).
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
      <h2>4 · Señales del mercado</h2>
      <div className="verdict-main">
        <div className="verdict-word">{kalshiVerdict.icon} {kalshiVerdict.label}{kalshiWeakSignal && (<span> · ⚠️ SEÑAL DÉBIL</span>)}</div>
        <div className="verdict-meta">
          <span>Puntuación 15m: <b>{kalshiScore}</b> / −100 a +100</span>
          <span>Fuerza: <b>{strengthForScore(kalshiScore)}</b></span>
          <span>Índice de coincidencia: <b>{kalshiProbAdj}/100*</b></span>
        </div>
      </div>
      {marketMovement && (
        <div className="stats">
          <div><span>Impulso en vivo</span><b>{marketMovement.speedLabel} ({marketMovement.impulseScore >= 0 ? `+${marketMovement.impulseScore}` : marketMovement.impulseScore})</b></div>
          <div><span>Vela 15m actual</span><b>{marketMovement.candleDelta != null ? `${marketMovement.candleDelta >= 0 ? '+' : '−'}${fmt(Math.abs(marketMovement.candleDelta), currency)} (${marketMovement.candleDeltaPct >= 0 ? '+' : ''}${marketMovement.candleDeltaPct.toFixed(2)}%)` : '—'}</b></div>
          <div><span>Avance 3 velas</span><b>{marketMovement.roc3Pct != null ? `${marketMovement.roc3Pct >= 0 ? '+' : ''}${marketMovement.roc3Pct.toFixed(2)}%` : '—'}</b></div>
          <div><span>Plazos (1m / 5m / 15m / 1h)</span><b>{marketMovement.tfBreakdown.map((t) => `${t.tf}: ${t.label}`).join(' · ')}</b></div>
        </div>
      )}
      <p className="muted">* Índice propio (puntuación + timeframes que coinciden). NO es una probabilidad de ganar y NO es la probabilidad oficial de Kalshi. Una señal que acertó ~56% en 1h puede fallar en 15 minutos.</p>
      {kalshiBacktest.total >= 5 && kalshiBacktest.ci95 && (
        <p className="muted">Medido como liquida Kalshi (señal calculada ANTES de abrir cada ventana): acertó {kalshiBacktest.wins} de {kalshiBacktest.total} ({kalshiBacktest.pct}%; margen al 95%: {kalshiBacktest.ci95.low}–{kalshiBacktest.ci95.high}%).{isCoinFlip(kalshiBacktest.ci95) ? ' Con estas muestras no se distingue de lanzar una moneda.' : ''}</p>
      )}
      {kalshiWeakSignal && (
        <p className="warn">⚠️ SEÑAL DÉBIL — Últimas {kalshiRecent.total} ventanas con señal clara de 15 min: la señal solo acertó {kalshiRecent.wins} ({Math.round(kalshiRecent.rate * 100)}%). Está fallando últimamente: el índice se bajó a {kalshiProbAdj} y no conviene apostar fuerte por ella. Medido como liquida Kalshi: cierre de cada ventana contra su apertura, no contra la vela siguiente.</p>
      )}
      {kalshiReasons.length > 0 && (
        <ul className="reasons">
          {kalshiReasons.map((r, i) => (
            <li key={i} className={`reason-${r.dir}`}><b>{r.icon}</b> {r.text}</li>
          ))}
        </ul>
      )}

      <h3>¿Cobro o me quedo?</h3>
      <div className="row">
        <label>Precio de entrada ({currencySym}): <input type="number" min="0" step="1" value={kalshiEntryPrice} placeholder={kalshiPrice ? String(Math.round(kalshiPrice)) : ''} onChange={(e) => onKalshiEntryPrice(e.target.value)} /></label>
        <label>Dirección: <select value={kalshiDir} onChange={(e) => onKalshiDir(e.target.value)}>
          <option value="up">Aposté a que SUBE</option>
          <option value="down">Aposté a que BAJA</option>
        </select></label>
        <label>Cantidad virtual ({currencySym}): <input type="number" min="1" step="10" value={kalshiAmount} onChange={(e) => onKalshiAmount(e.target.value)} /></label>
        <button onClick={onSaveKalshiPosition}>Guardar mi posición virtual</button>
        <button onClick={onClearKalshiPosition}>Borrar posición</button>
      </div>
      {kalshiMsg && <p className="muted">{kalshiMsg}</p>}
      <div className="signal" style={{ borderColor: kalshiDecision.color }}>
        <b style={{ color: kalshiDecision.color, fontSize: 26 }}>{kalshiDecision.label}</b>
        <span><b>{kalshiDecision.title}</b></span>
        <span>{kalshiDecision.text}</span>
        {kalshiDecision.pnl != null && (
          <span>Tu posición virtual: <b className={kalshiDecision.pnl >= 0 ? 'up' : 'down'}>{kalshiDecision.pnl >= 0 ? '+' : ''}{fmt(kalshiDecision.pnl, currency)} ({kalshiDecision.pnlPct >= 0 ? '+' : ''}{kalshiDecision.pnlPct.toFixed(2)}%)</b> · precio ahora {kalshiPrice ? fmt(kalshiPrice, currency) : '—'} · entrada {fmt(kalshiEntryNum, currency)}</span>
        )}
        {kalshiExitPrice && (
          <span>Precio sugerido para cobrar/salir: <b>{fmt(kalshiExitPrice, currency)}</b> {kalshiDecision.key === 'hold' || kalshiDecision.key === 'hold-careful' ? `(objetivo a 1 ATR 15m, ${kalshiAtr ? fmt(kalshiAtr, currency) : '—'})` : '(precio actual)'}</span>
        )}
      </div>
      <p className="muted">Regla simple: si vas ganando y la señal se dio la vuelta, cobra. Si vas perdiendo y la señal va en tu contra, sal. Si la señal sigue a tu favor, aguanta hasta el cierre de la ventana. Todo virtual: nada de esto mueve dinero real ni tu cuenta de Kalshi.</p>
    </>
  );
}
