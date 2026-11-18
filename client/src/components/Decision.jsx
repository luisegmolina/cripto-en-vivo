// Decision.jsx — v15.3 / v15.5: §2 Decisión (SAL AHORA / AGUANTA / INVIERTE MÁS)
// y plan exacto de apuesta (contrato SÍ/NO, precio en centavos, ventaja y niveles).
// Sugerencia educativa, nunca una orden: la app no opera por ti.
import { strengthForScore } from '../kalshi.js';

function MarketRecBox({ marketRec, kalshiScore, kalshiReasons, marketMovement, betPlan }) {
  const effectiveSide = marketRec.key !== 'wait' ? marketRec.key : (betPlan && betPlan.betSide ? betPlan.betSide : 'wait');
  const color = effectiveSide === 'up' ? '#22c55e' : effectiveSide === 'down' ? '#ef4444' : '#94a3b8';
  const warnings = marketRec.warnings || [];
  return (
    <div className="signal" style={{ borderColor: color }}>
      <b style={{ color, fontSize: 30 }}>A qué apostar en esta ventana: {marketRec.label}</b>
      <span>{marketRec.reason}</span>
      {betPlan && (
        <>
          <span><b>Cuál debería ser tu apuesta en Kalshi:</b> <b style={{ color }}>{betPlan.actionHeadline}</b> · {betPlan.contractLabel}</span>
          <span><b>Precio y ventaja del contrato:</b> {betPlan.priceVerdict}</span>
          <span className="warn">⚠️ La ventaja (Edge/EV) se calcula con la probabilidad estimada por la puntuación de la señal, no con el acierto medido: el backtest honesto 15m acierta ~46% (no se distingue de una moneda). No es una ganancia garantizada.</span>
          <span><b>Plan de entrada:</b> {betPlan.entryRule}</span>
          <span><b>Cuándo cobrar / salir:</b> {betPlan.takeProfitRule} {betPlan.stopLossRule}</span>
        </>
      )}
      {marketMovement && (
        <span><b>Movimiento del mercado ahora:</b> {marketMovement.summary}</span>
      )}
      {warnings.map((w, i) => (
        <span key={i} className="warn">⚠️ {w}</span>
      ))}
      <span>Fuerza de la señal 15m: <b>{strengthForScore(kalshiScore)} (puntuación {kalshiScore} / −100 a +100)</b></span>
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
      <h2>2 · Decisión</h2>
      {!user ? (
        <>
          <MarketRecBox marketRec={marketRec} kalshiScore={kalshiScore} kalshiReasons={kalshiReasons} marketMovement={marketMovement} betPlan={betPlan} />
          <p className="muted">Sin sesión: la caja de arriba es lo que dice el mercado ahora. Entra y conecta Kalshi para que la app te diga si salir, aguantar o invertir más según tu posición.</p>
        </>
      ) : !firstRealDecision ? (
        <>
          <MarketRecBox marketRec={marketRec} kalshiScore={kalshiScore} kalshiReasons={kalshiReasons} marketMovement={marketMovement} betPlan={betPlan} />
          <p className="muted">Sin posición abierta en Kalshi ahora mismo: no hay decisión que tomar sobre una posición. Cuando abras una, aparecerá aquí.</p>
        </>
      ) : liveDecisionNow ? (
        <div className="signal" style={{ borderColor: liveDecisionNow.color }}>
          <b style={{ color: liveDecisionNow.color, fontSize: 26 }}>{liveDecisionNow.label}</b>
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
