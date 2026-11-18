// PaperAudit.jsx — v16.1: §6 Auditor en papel — Sniper BRTI (sin dinero real).
// Solo LEE el estado del auditor del servidor (GET /api/kalshi/paper-audit
// cada 2 s) y pide Iniciar/Detener. Nunca envía órdenes a Kalshi ni toca
// dinero real: la señal que muestra es una simulación en papel.
// Avisos honestos: el auditor solo corre mientras el servidor está
// despierto (Render gratis duerme tras 15 min sin tráfico y el WS BRTI
// se cierra a los 5 min sin sondeo), y el backtest del motor sigue en
// ~46%: todavía no hay edge demostrado.
import { useEffect, useState } from 'react';
import { apiAuth } from '../auth.js';

function visibleInterval(fn, ms) {
  const t = setInterval(() => { if (!document.hidden) fn(); }, ms);
  const onVisible = () => { if (!document.hidden) fn(); };
  document.addEventListener('visibilitychange', onVisible);
  return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
}

function fmtNum(n, dec = 2) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toFixed(dec);
}

export default function PaperAudit({ user, fmt }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!user) { setData(null); return; }
    let alive = true;
    const load = async () => {
      try {
        const d = await apiAuth('/api/kalshi/paper-audit');
        if (alive) { setData(d); setError(''); }
      } catch (e) { if (alive) setError(String(e.message || e)); }
    };
    load();
    const stop = visibleInterval(load, 2000);
    return () => { alive = false; stop(); };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function accion(ruta, okMsg) {
    setBusy(true); setError(''); setMsg('');
    try {
      const d = await apiAuth(ruta, { method: 'POST', body: {} });
      setData(d); setMsg(okMsg);
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }

  const stats = data?.stats || {
    ventanas: 0, senales: 0, viables: 0, viablesLiquidadas: 0, aciertosEnViables: 0,
    prediccionCorrecta: 0, prediccionTotal: 0, errorMedioAbsUSD: null, errorMaxAbsUSD: null,
  };
  const resultados = Array.isArray(data?.resultados) ? data.resultados : [];
  const sim = data?.simulacion || null;
  const contrato = data?.contrato || null;

  return (
    <section className="card">
      <div className="section-header">
        <h2>6 · Auditor en papel — Sniper BRTI (sin dinero real)</h2>
        <span className="badge">{data?.enabled ? '● Activo' : '○ Parado'}</span>
      </div>

      {!user && (
        <p className="muted">Entra con tu cuenta para usar el auditor en papel. Sin sesión no hay BRTI en vivo que auditar.</p>
      )}

      {user && data && data.kalshiConnected === false && (
        <p className="warn">⚠️ Kalshi no conectado: conecta tu cuenta Kalshi abajo para auditar en papel. Sin BRTI en vivo no hay nada que medir.</p>
      )}

      {error && <div className="error">{error}</div>}
      {msg && <p className="muted">{msg}</p>}

      <div className="stats">
        <div>
          <span>Contrato actual</span>
          <b>{contrato ? contrato.ticker : '—'}</b>
        </div>
        <div>
          <span>Precio objetivo (BRTI)</span>
          <b>{contrato && contrato.targetPrice != null ? fmt(contrato.targetPrice, 'USD') : '—'}</b>
        </div>
        <div>
          <span>TWAP bloqueado (minuto final)</span>
          <b>{data?.twapBloqueado != null ? fmt(data.twapBloqueado, 'USD') : '—'}</b>
        </div>
        <div>
          <span>Ticks (muestras / esperados)</span>
          <b>{data?.muestrasCapturadas ?? 0}{data?.ticksEsperados != null ? ` / ${data.ticksEsperados}` : ''}{data?.ticksPerdidos != null ? ` · perdidos: ${data.ticksPerdidos}` : ''}</b>
        </div>
        <div>
          <span>Salto requerido para revertir</span>
          <b className={data?.saltoRequeridoUSD != null ? (data.saltoRequeridoUSD >= 0 ? 'up' : 'down') : ''}>
            {data?.saltoRequeridoUSD != null ? `${data.saltoRequeridoUSD > 0 ? '+' : ''}$${fmtNum(data.saltoRequeridoUSD)}` : '—'}
          </b>
        </div>
        <div>
          <span>Ask SÍ / NO (Kalshi)</span>
          <b>{data?.yesAskDollars != null || data?.noAskDollars != null ? `SÍ $${fmtNum(data.yesAskDollars, 4)} · NO $${fmtNum(data.noAskDollars, 4)}` : '—'}</b>
        </div>
      </div>

      {data?.ultimoError && <p className="warn">⚠️ {data.ultimoError}</p>}

      {sim ? (
        <div className="signal" style={{ borderColor: sim.viableDespuesDeComision ? '#10b981' : '#f59e0b' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>📝 Señal en papel: {sim.direccionElegida === 'yes' ? 'SÍ (SUBE)' : 'NO (BAJA)'}</b>
            <span className="muted">T-{sim.segundosRestantes}s · {sim.ticker}</span>
          </div>
          <span>
            Ask: ${sim.askPriceDollars} · Fee: ${sim.feePerContractDollars} · Break-even: {sim.breakEvenProb}% · Neto/contrato si gana: ${sim.netProfitIfWinPerContract} ·{' '}
            <b className={sim.viableDespuesDeComision ? 'up' : 'down'}>{sim.viableDespuesDeComision ? 'Viable después de comisión' : 'No viable después de comisión'}</b>
          </span>
          <span className="muted">
            Vista previa (NO enviada): {sim.ordenV2Preview?.payload?.side === 'bid' ? 'comprar SÍ' : 'vender SÍ'} a ${sim.ordenV2Preview?.payload?.price} × {sim.ordenV2Preview?.payload?.count} contratos, {sim.ordenV2Preview?.payload?.time_in_force}.
          </span>
        </div>
      ) : (
        <p className="muted">Sin señal en papel en esta ventana (se evalúa solo entre T-18 y T-3, con salto requerido ≥ $95 y como mucho 2 ticks perdidos).</p>
      )}

      <div className="row" style={{ marginTop: '10px' }}>
        <button className="primary" disabled={busy || !user || data?.kalshiConnected === false || data?.enabled} onClick={() => accion('/api/kalshi/paper-audit/start', 'Auditor en papel iniciado. Solo corre mientras el servidor está despierto.')}>▶ Iniciar auditor</button>
        <button disabled={busy || !user || !data?.enabled} onClick={() => accion('/api/kalshi/paper-audit/stop', 'Auditor en papel detenido. Los resultados quedan guardados.')}>■ Detener</button>
      </div>

      <h3>Últimas auditorías ({stats.ventanas})</h3>
      <p className="muted">
        Ventanas: {stats.ventanas} · Señales en papel: {stats.senales} · Viables tras comisión: {stats.viables}
        {stats.viablesLiquidadas > 0 ? ` (aciertos en viables: ${stats.aciertosEnViables}/${stats.viablesLiquidadas})` : ''} · Acierto de la predicción local: {stats.prediccionCorrecta}/{stats.prediccionTotal}
        {stats.prediccionTotal > 0 ? ` (${Math.round((stats.prediccionCorrecta / stats.prediccionTotal) * 100)}%)` : ' (sin ventanas liquidadas todavía)'}
        {stats.errorMedioAbsUSD != null ? ` · Error |TWAP−Oficial| medio: $${fmtNum(stats.errorMedioAbsUSD)} (máx: $${fmtNum(stats.errorMaxAbsUSD)})` : ''}
      </p>
      {resultados.length === 0 ? (
        <p className="muted">Aún no hay ventanas auditadas. Inicia el auditor y deja pasar al menos una ventana de 15 minutos.</p>
      ) : (
        <div className="audit-table-wrap">
          <table className="audit-table">
            <thead>
              <tr>
                <th>Ventana</th>
                <th>Objetivo</th>
                <th>TWAP local</th>
                <th>Oficial</th>
                <th>Error</th>
                <th>Predicción vs resultado</th>
                <th>Señal</th>
                <th>Viable</th>
              </tr>
            </thead>
            <tbody>
              {resultados.map((r) => (
                <tr key={`${r.ticker}-${r.closedAt || ''}`}>
                  <td>{r.ticker ? r.ticker.replace('KXBTC15M-', '') : '—'}</td>
                  <td className="num">{r.targetPrice != null ? fmt(r.targetPrice, 'USD') : '—'}</td>
                  <td className="num">{r.twapLocal != null ? fmt(r.twapLocal, 'USD') : '—'}</td>
                  <td className="num">{r.brtiLiquidacionOficial != null ? fmt(r.brtiLiquidacionOficial, 'USD') : '—'}</td>
                  <td className="num">{r.errorTwapVsOficial != null ? `${r.errorTwapVsOficial > 0 ? '+' : ''}$${fmtNum(r.errorTwapVsOficial)}` : '—'}</td>
                  <td>{r.prediccionLocal ? `${r.prediccionLocal === 'yes' ? 'SÍ' : 'NO'} vs ${r.resultadoOficialKalshi === 'pendiente' ? 'pendiente' : (r.resultadoOficialKalshi === 'yes' ? 'SÍ' : 'NO')}` : '—'}</td>
                  <td>{r.simulacion ? (r.simulacion.direccionElegida === 'yes' ? 'SÍ' : 'NO') : '—'}</td>
                  <td>{r.simulacion ? (r.simulacion.viableDespuesDeComision ? 'Sí' : 'No') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="warn">
        ⚠️ Papel solamente: el auditor nunca envía órdenes a Kalshi y nunca mueve dinero real.
        Solo corre mientras el servidor está despierto: en Render gratis el servicio duerme tras 15 min sin tráfico
        y el WS BRTI se cierra a los 5 min sin sondeo. El backtest honesto del motor sigue en ~46%:
        todavía no hay edge demostrado, esto solo mide si el sniper lo tiene.
      </p>
    </section>
  );
}
