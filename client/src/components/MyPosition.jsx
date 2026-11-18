// MyPosition.jsx — v15.3: §1 Mi posición en vivo. Solo presenta: el P&L
// se recalcula con cada tick BRTI (cada 2 s); las posiciones se
// refrescan cada 30 s (KalshiConnect). P&L estimado = liquidación si la
// ventana cerrara ahora según BRTI ($1 si vas ganando, $0 si vas
// perdiendo, menos el precio medio, por contrato). El P&L "si vendes
// ahora" es el del precio del contrato, lo que Kalshi te pagaría hoy.
import { brtiPositionOutcome, estimateSettlementPnl } from '../kalshi.js';

export default function MyPosition({ user, realDecisions, brtiArgs, fmt }) {
  return (
    <>
      <h2>1 · Mi posición en vivo</h2>
      {!user ? (
        <p className="muted">Entra con tu cuenta y conecta Kalshi para ver tu posición en vivo aquí.</p>
      ) : realDecisions.length === 0 ? (
        <p className="muted">Sin posición abierta en Kalshi ahora mismo: no hay nada que vigilar. Cuando abras una, aparecerá aquí con su P&L en vivo.</p>
      ) : (
        <div>
          {realDecisions.map((d, i) => {
            const out = brtiPositionOutcome({ dir: d.dir, ...brtiArgs });
            const pnlEst = estimateSettlementPnl({ dir: d.dir, ...brtiArgs, avgPriceCents: d.avgPriceCents, count: d.count });
            const canLose = out && (!out.winning || out.nearLine);
            return (
              <div key={`${d.ticker || ''}-${i}`} className="signal" style={{ borderColor: out ? (out.winning ? '#22c55e' : '#ef4444') : '#94a3b8' }}>
                <b>{d.ticker || '—'} — {d.side === 'yes' ? 'SÍ' : d.side === 'no' ? 'NO' : '—'} · Apuesta: {d.dir === 'up' ? '▲ SUBE' : d.dir === 'down' ? '▼ BAJA' : '—'}</b>
                <span>Precio medio: {d.avgPriceCents != null ? `${d.avgPriceCents}¢` : '—'} · Cantidad: {d.count} contrato(s) · Precio actual del contrato: {d.currentPriceCents != null ? `${d.currentPriceCents}¢` : '—'}</span>
                {pnlEst ? (
                  <span>P&L estimado si la ventana cerrara ahora según BRTI: <b className={pnlEst.pnlUsd >= 0 ? 'up' : 'down'}>{pnlEst.pnlUsd >= 0 ? '+' : ''}{fmt(pnlEst.pnlUsd, 'USD')}</b> · el contrato valdría ${pnlEst.estValueCents / 100} si liquida así</span>
                ) : (
                  <span className="muted">Sin P&L estimado: falta el promedio de 60 s, el objetivo o el precio medio. El valor instantáneo no liquida.</span>
                )}
                {d.decision && d.decision.pnl != null && (
                  <span>Si vendes ahora en Kalshi (precio del contrato): <b className={d.decision.pnl >= 0 ? 'up' : 'down'}>{d.decision.pnl >= 0 ? '+' : ''}{fmt(d.decision.pnl, 'USD')}</b></span>
                )}
                {out ? (
                  <span><b style={{ color: out.winning ? '#22c55e' : '#ef4444' }}>{out.winning ? '✓ VAS GANANDO según BRTI' : '✗ VAS PERDIENDO según BRTI'}</b>{canLose && (<span> · <b>⚠️ PUEDES PERDER</b>: {out.winning ? 'estás a menos de $30 del objetivo y la ventana puede darse la vuelta' : 'el BRTI está en tu contra'}</span>)}</span>
                ) : (
                  <span className="muted">Sin promedio de 60 s: no se puede saber si vas ganando o perdiendo. El valor instantáneo no liquida y no se usa para decidir.</span>
                )}
                {!d.decision && (
                  <span className="muted">Sin decisión por precio del contrato: falta el precio medio o el actual — comprueba la posición en Kalshi.</span>
                )}
              </div>
            );
          })}
          <p className="muted">Posiciones actualizadas cada 30 s; el P&L se recalcula con cada tick BRTI (cada 2 s).</p>
        </div>
      )}
    </>
  );
}
