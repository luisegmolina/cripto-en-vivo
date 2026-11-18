// MyPosition.jsx — v16.0: §1 Estado de Posición en Vivo (discreto si no hay posición,
// prominente si tienes contratos abiertos en Kalshi).
import { brtiPositionOutcome, estimateSettlementPnl } from '../kalshi.js';

export default function MyPosition({ user, realDecisions, brtiArgs, fmt }) {
  return (
    <>
      <div className="section-header">
        <h2>1 · Mi posición en vivo</h2>
        {user && realDecisions.length > 0 && <span className="version-pill">{realDecisions.length} ABIERTA(S)</span>}
      </div>
      {!user ? (
        <p className="muted">Modo directo sin sesión: mira abajo en <b>§2 Decisión</b> cuál debe ser tu apuesta en esta ventana (conecta Kalshi abajo si quieres ver tus contratos reales aquí).</p>
      ) : realDecisions.length === 0 ? (
        <p className="muted">Sin posición abierta en Kalshi ahora mismo: revisa en <b>§2 Decisión</b> qué contrato apostar en esta ventana.</p>
      ) : (
        <div>
          {realDecisions.map((d, i) => {
            const out = brtiPositionOutcome({ dir: d.dir, ...brtiArgs });
            const pnlEst = estimateSettlementPnl({ dir: d.dir, ...brtiArgs, avgPriceCents: d.avgPriceCents, count: d.count });
            const canLose = out && (!out.winning || out.nearLine);
            return (
              <div key={`${d.ticker || ''}-${i}`} className="signal" style={{ borderColor: out ? (out.winning ? '#10b981' : '#f43f5e') : '#334155' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b>{d.ticker || '—'} — {d.side === 'yes' ? 'SÍ' : d.side === 'no' ? 'NO' : '—'} · Apuesta: {d.dir === 'up' ? '▲ SUBE' : d.dir === 'down' ? '▼ BAJA' : '—'}</b>
                  <span>Precio medio: <b>{d.avgPriceCents != null ? `${d.avgPriceCents}¢` : '—'}</b> · Contratos: <b>{d.count}</b> · Ahora: <b>{d.currentPriceCents != null ? `${d.currentPriceCents}¢` : '—'}</b></span>
                </div>
                {pnlEst ? (
                  <span>P&amp;L estimado si la ventana cerrara ahora según BRTI: <b className={pnlEst.pnlUsd >= 0 ? 'up' : 'down'}>{pnlEst.pnlUsd >= 0 ? '+' : ''}{fmt(pnlEst.pnlUsd, 'USD')}</b> (liquidación a ${pnlEst.estValueCents / 100})</span>
                ) : (
                  <span className="muted">Sin P&amp;L estimado: esperando promedio de 60 s.</span>
                )}
                {d.decision && d.decision.pnl != null && (
                  <span>Si vendes ahora en Kalshi (precio del contrato): <b className={d.decision.pnl >= 0 ? 'up' : 'down'}>{d.decision.pnl >= 0 ? '+' : ''}{fmt(d.decision.pnl, 'USD')}</b></span>
                )}
                {out ? (
                  <span>
                    <b style={{ color: out.winning ? '#34d399' : '#fb7185' }}>{out.winning ? '✓ VAS GANANDO según BRTI' : '✗ VAS PERDIENDO según BRTI'}</b>
                    {canLose && (<span> · <b>⚠️ PUEDES PERDER</b>: {out.winning ? 'a menos de $30 del objetivo' : 'el BRTI está en tu contra'}</span>)}
                  </span>
                ) : (
                  <span className="muted">Sin promedio de 60 s: esperando dato de liquidación.</span>
                )}
              </div>
            );
          })}
          <p className="muted">El P&amp;L se recalcula con cada tick BRTI (cada 2 s).</p>
        </div>
      )}
    </>
  );
}
