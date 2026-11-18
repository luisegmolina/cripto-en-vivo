// Decision.jsx — v15.3: §2 Decisión (SAL AHORA / AGUANTA / INVIERTE MÁS).
// Sugerencia educativa, nunca una orden: la app no opera por ti.
// Reglas en kalshi.js (liveDecision): contrato ≤15¢ o BRTI + señal en
// contra -> SAL; ganando + señal fuerte a favor + contrato ≤40¢ ->
// INVIERTE MÁS (con aviso de más riesgo); ganando + señal a favor ->
// AGUANTA; resto -> AGUANTA CON CUIDADO.
//
// v15.3 (pedido de Luis): SIN POSICIÓN ABIERTA la §2 sigue diciendo
// "sin posición abierta" y no inventa ninguna decisión de posición
// (SAL/AGUANTA) — pero SÍ muestra, en una caja aparte y sin ambigüedad,
// lo que dice el mercado: la señal 15m traducida a "Apuesta a la
// SUBIDA" / "Apuesta a la BAJADA" / "ESPERAR", con su fuerza y sus
// razones (marketRecommendation en kalshi.js: señal débil o
// conflictiva -> ESPERAR, nunca inventa un lado). Con posición
// abierta esta caja NO aparece: manda la decisión de la posición.
import { strengthForScore } from '../kalshi.js';

function MarketRecBox({ marketRec, kalshiScore, kalshiReasons }) {
  const color = marketRec.key === 'up' ? '#22c55e' : marketRec.key === 'down' ? '#ef4444' : '#94a3b8';
  return (
    <div className="signal" style={{ borderColor: color }}>
      <span className="muted">Sin posición abierta — lo que dice el mercado ahora:</span>
      <b style={{ color, fontSize: 26 }}>{marketRec.label}</b>
      <span>{marketRec.reason}</span>
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

export default function Decision({ user, firstRealDecision, liveDecisionNow, marketRec, kalshiScore, kalshiReasons }) {
  return (
    <>
      <h2>2 · Decisión</h2>
      {!user ? (
        <>
          <p className="muted">Entra y conecta Kalshi para que la app te diga si salir, aguantar o invertir más según tu posición.</p>
          <MarketRecBox marketRec={marketRec} kalshiScore={kalshiScore} kalshiReasons={kalshiReasons} />
        </>
      ) : !firstRealDecision ? (
        <>
          <p className="muted">Sin posición abierta en Kalshi ahora mismo: no hay decisión que tomar. Cuando abras una, aparecerá aquí.</p>
          <MarketRecBox marketRec={marketRec} kalshiScore={kalshiScore} kalshiReasons={kalshiReasons} />
        </>
      ) : liveDecisionNow ? (
        <div className="signal" style={{ borderColor: liveDecisionNow.color }}>
          <b style={{ color: liveDecisionNow.color, fontSize: 26 }}>{liveDecisionNow.label}</b>
          <span>{liveDecisionNow.reason}</span>
          <span>Tu posición: <b>{firstRealDecision.ticker} — {firstRealDecision.side === 'yes' ? 'SÍ' : firstRealDecision.side === 'no' ? 'NO' : '—'} ({firstRealDecision.count} contrato(s), {firstRealDecision.currentPriceCents}¢ ahora)</b></span>
          {liveDecisionNow.key === 'add' && (
            <span className="warn">⚠️ Invertir más aumenta el riesgo: si la ventana se da la vuelta, pierdes más de lo que llevas. Solo con dinero que te sobre.</span>
          )}
          <span className="muted">Sugerencia educativa, nunca una orden: la app no opera por ti. Decide y opera tú en Kalshi.</span>
        </div>
      ) : null}
    </>
  );
}
