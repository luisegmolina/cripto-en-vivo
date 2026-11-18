// Decision.jsx — v16.0: HERO DE APUESTA Y DECISIÓN EN TIEMPO REAL.
// Muestra en 2 segundos qué apostar cuando no hay posición abierta (contrato
// SÍ/NO, precio en centavos, ROI, ventaja EV y niveles de entrada/cobro/salida)
// o qué hacer con la posición abierta (SAL AHORA / AGUANTA / INVIERTE MÁS).
import { strengthForScore } from '../kalshi.js';

function MarketRecBox({ marketRec, kalshiScore, kalshiReasons, marketMovement, betPlan }) {
  const effectiveSide = marketRec.key !== 'wait' ? marketRec.key : (betPlan && betPlan.betSide ? betPlan.betSide : 'wait');
  const isTactical = marketRec.key === 'wait' && Boolean(betPlan && betPlan.betSide);
  const heroClass = effectiveSide === 'up'
    ? (isTactical ? 'hero-decision hero-tactical' : 'hero-decision hero-up')
    : effectiveSide === 'down'
      ? (isTactical ? 'hero-decision hero-tactical' : 'hero-decision hero-down')
      : 'hero-decision';
  const color = effectiveSide === 'up' ? '#34d399' : effectiveSide === 'down' ? '#fb7185' : '#94a3b8';
  const warnings = marketRec.warnings || [];

  return (
    <div className={`signal ${heroClass}`} style={{ borderColor: color }}>
      <div className="section-header">
        <span className="version-pill">SEÑAL DE APUESTA · VENTANA 15M</span>
        <span>Fuerza 15m: <b>{strengthForScore(kalshiScore)} ({kalshiScore >= 0 ? `+${kalshiScore}` : kalshiScore}/100)</b></span>
      </div>

      <b className="hero-headline" style={{ color, fontSize: 30 }}>
        A qué apostar en esta ventana: {marketRec.label}
      </b>
      <span>{marketRec.reason}</span>

      {betPlan && (
        <div className="bet-grid">
          <div className="bet-kpi">
            <span>Cuál debería ser tu apuesta en Kalshi:</span>
            <b style={{ color }}>{betPlan.actionHeadline}</b>
            <small className="muted">{betPlan.contractLabel}</small>
          </div>
          <div className="bet-kpi">
            <span>Precio y ventaja del contrato:</span>
            <b>{betPlan.askCents != null ? `${betPlan.askCents}¢ → Ganas +${betPlan.profitCents}¢ (+${betPlan.roiPct}%)` : 'Esperando cotización'}</b>
            <small className="muted">{betPlan.priceVerdict}</small>
          </div>
          <div className="bet-kpi">
            <span>Plan operativo (Entrada / Salida):</span>
            <b>Cobrar ≥85¢ · Cortar ≤15¢</b>
            <small className="muted">{betPlan.entryRule}</small>
          </div>
        </div>
      )}

      {/* v16.0 (restaurado por Muse al verificar): el ZIP quitaba este aviso.
          La ventaja (Edge/EV) se calcula con la probabilidad ESTIMADA por la
          puntuación, no con el acierto MEDIDO (~46%): sin este aviso el plan
          parece una ganancia esperada real. No se quita. */}
      {betPlan && (
        <span className="warn">⚠️ La ventaja (Edge/EV) se calcula con la probabilidad estimada por la puntuación de la señal, no con el acierto medido: el backtest honesto 15m acierta ~46% (no se distingue de una moneda). No es una ganancia garantizada.</span>
      )}

      {marketMovement && (
        <span><b>Movimiento del mercado ahora:</b> {marketMovement.summary}</span>
      )}

      {warnings.map((w, i) => (
        <span key={i} className="warn">⚠️ {w}</span>
      ))}

      {kalshiReasons.length > 0 && (
        <ul className="reasons">
          {kalshiReasons.map((r, i) => (
            <li key={i} className={`reason-${r.dir}`}><b>{r.icon}</b> {r.text}</li>
          ))}
        </ul>
      )}
      <span className="muted">Sugerencia educativa, no es una orden ni una garantía: el backtest 15m no se distingue de una moneda (ver §4). Decide tú en Kalshi.</span>
    </div>
  );
}

export default function Decision({ user, firstRealDecision, liveDecisionNow, marketRec, kalshiScore, kalshiReasons, marketMovement = null, betPlan = null }) {
  return (
    <>
      <h2>2 · Decisión y Apuesta Recomendada</h2>
      {!user ? (
        <>
          <MarketRecBox marketRec={marketRec} kalshiScore={kalshiScore} kalshiReasons={kalshiReasons} marketMovement={marketMovement} betPlan={betPlan} />
          <p className="muted">Sin sesión: arriba tienes la apuesta recomendada ahora mismo. Entra y conecta Kalshi si quieres seguimiento automático de tu cartera.</p>
        </>
      ) : !firstRealDecision ? (
        <>
          <MarketRecBox marketRec={marketRec} kalshiScore={kalshiScore} kalshiReasons={kalshiReasons} marketMovement={marketMovement} betPlan={betPlan} />
          <p className="muted">Sin posición abierta en Kalshi ahora mismo: no hay decisión que tomar sobre una posición. Cuando abras una, aparecerá aquí.</p>
        </>
      ) : liveDecisionNow ? (
        <div className="signal hero-decision" style={{ borderColor: liveDecisionNow.color }}>
          <b className="hero-headline" style={{ color: liveDecisionNow.color, fontSize: 28 }}>{liveDecisionNow.label}</b>
          <span>{liveDecisionNow.reason}</span>
          <span>Tu posición: <b>{firstRealDecision.ticker} — {firstRealDecision.side === 'yes' ? 'SÍ' : firstRealDecision.side === 'no' ? 'NO' : '—'} ({firstRealDecision.count} contrato(s), {firstRealDecision.currentPriceCents}¢ ahora)</b></span>
          {marketMovement && (
            <span><b>Movimiento del mercado ahora:</b> {marketMovement.summary}</span>
          )}
          {liveDecisionNow.key === 'add' && (
            <span className="warn">⚠️ Invertir más aumenta el riesgo: si la ventana se da la vuelta, pierdes más de lo que llevas. Solo con dinero que te sobre.</span>
          )}
          <span className="muted">Sugerencia educativa, nunca una orden: la app no opera por ti. Decide y opera tú en Kalshi.</span>
        </div>
      ) : null}
    </>
  );
}
