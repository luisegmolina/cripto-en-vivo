// LiveTrader.jsx — v16.2: §7 Bot en vivo — APAGADO por defecto.
// Solo LEE el estado del bot (GET /api/kalshi/live/status cada 2 s)
// y pide Detener (kill switch). NUNCA envía órdenes desde el cliente:
// las órdenes solo salen del servidor (liveTrader) al evaluar una
// señal viable del auditor, y solo si el interruptor global
// LIVE_TRADING_ENABLED='true' está puesto en el servidor (hoy NO lo
// está: en Render es false). Con live apagado, cada señal viable se
// registra como would-send: qué se HABRÍA enviado, sin enviar nada.
// El botón "Armar" queda deshabilitado mientras live esté apagado;
// el servidor devuelve 403 si se intenta igual.
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

function accionLabel(a) {
  if (a === 'sent') return 'ENVIADA';
  if (a === 'would-send') return 'HABRÍA ENVIADO';
  if (a === 'blocked') return 'BLOQUEADA';
  if (a === 'killed') return 'DETENIDA';
  return a || '—';
}

export default function LiveTrader({ user, fmt }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!user) { setData(null); return; }
    let alive = true;
    const load = async () => {
      try {
        const d = await apiAuth('/api/kalshi/live/status');
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

  const live = data?.liveEnabled === true;
  const killed = data?.killed === true;
  const armed = data?.armed === true;
  const limits = data?.limits || { maxContractsPerOrder: 2, maxOrdersPerDay: 5, maxDailyLossUsd: 20, maxConsecutiveErrors: 3 };
  const today = data?.today || { day: null, ordersSent: 0, potentialLossUsd: 0, consecutiveErrors: 0 };
  const log = Array.isArray(data?.log) ? data.log : [];
  const estadoTxt = !live ? '⛔ APAGADO — no envía órdenes' : killed ? '■ DETENIDO (kill switch)' : armed ? '● ARMADO — puede enviar órdenes' : '○ APAGADO (sin armar)';

  return (
    <section className="card">
      <div className="section-header">
        <h2>7 · Bot en vivo — APAGADO</h2>
        <span className="badge">{estadoTxt}</span>
      </div>

      {!user && (
        <p className="muted">Entra con tu cuenta para ver el estado del bot en vivo. Sin sesión no hay nada que operar ni registrar.</p>
      )}

      {user && data && data.kalshiConnected === false && (
        <p className="warn">⚠️ Kalshi no conectado: sin credenciales no hay nada que firmar, ni en papel ni en vivo.</p>
      )}

      {error && <div className="error">{error}</div>}
      {msg && <p className="muted">{msg}</p>}

      <div className="stats">
        <div>
          <span>Interruptor global (servidor)</span>
          <b className={live ? 'up' : 'down'}>{live ? 'ENCENDIDO' : 'APAGADO'}</b>
        </div>
        <div>
          <span>Armado para operar</span>
          <b>{armed ? 'Sí' : 'No'}</b>
        </div>
        <div>
          <span>Kill switch</span>
          <b className={killed ? 'down' : ''}>{killed ? `ACTIVADO (${data?.killReason || 'manual'})` : 'Libre'}</b>
        </div>
        <div>
          <span>Órdenes enviadas hoy</span>
          <b>{today.ordersSent} / {limits.maxOrdersPerDay}</b>
        </div>
        <div>
          <span>Pérdida potencial hoy (peor caso)</span>
          <b>${fmtNum(today.potentialLossUsd)} / ${fmtNum(limits.maxDailyLossUsd)}</b>
        </div>
        <div>
          <span>Errores consecutivos</span>
          <b>{today.consecutiveErrors} / {limits.maxConsecutiveErrors}</b>
        </div>
      </div>

      <p className="muted">
        Límites duros: máx. {limits.maxContractsPerOrder} contratos por orden · máx. {limits.maxOrdersPerDay} órdenes/día ·
        pérdida potencial máx. ${fmtNum(limits.maxDailyLossUsd)}/día (peor caso, contratos a $0) ·
        {limits.maxConsecutiveErrors} errores seguidos auto-detienen el bot.
      </p>

      <div className="row" style={{ marginTop: '10px' }}>
        <button className="primary" disabled={busy || !user || !live || armed} onClick={() => accion('/api/kalshi/live/enable', 'Bot armado. Solo operará sobre señales viables del auditor, dentro de los límites.')}>▶ Armar bot en vivo</button>
        <button disabled={busy || !user || killed} onClick={() => accion('/api/kalshi/live/kill', 'Kill switch activado: el bot está detenido y desarmado.')}>■ Detener (kill switch)</button>
      </div>
      {!live && user && (
        <p className="warn">⚠️ El botón Armar está deshabilitado porque el interruptor global del servidor está APAGADO (LIVE_TRADING_ENABLED no es 'true'). Encenderlo exige cambiar la variable en el servidor Y tu decisión explícita: no se enciende solo desde la web.</p>
      )}

      <h3>Registro de decisiones ({log.length})</h3>
      {log.length === 0 ? (
        <p className="muted">Aún no hay decisiones registradas. Con live apagado, cada señal viable del auditor aparecerá aquí como "HABRÍA ENVIADO", sin enviar nada.</p>
      ) : (
        <div className="audit-table-wrap">
          <table className="audit-table">
            <thead>
              <tr>
                <th>Hora</th>
                <th>Ventana</th>
                <th>Decisión</th>
                <th>Motivo</th>
                <th>Lado</th>
                <th>Ask</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody>
              {[...log].reverse().map((e, i) => (
                <tr key={`${e.ticker || ''}-${e.at || ''}-${i}`}>
                  <td>{e.at ? new Date(e.at).toLocaleTimeString('es-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}</td>
                  <td>{e.ticker ? e.ticker.replace('KXBTC15M-', '') : '—'}</td>
                  <td><b className={e.action === 'sent' ? 'up' : e.action === 'blocked' ? 'down' : ''}>{accionLabel(e.action)}</b></td>
                  <td>{e.reason || '—'}{e.autoKilled ? ' · auto-detenido' : ''}</td>
                  <td>{e.direccion === 'yes' ? 'SÍ' : e.direccion === 'no' ? 'NO' : '—'}</td>
                  <td className="num">{e.askPriceDollars != null ? `$${fmtNum(e.askPriceDollars, 4)}` : '—'}</td>
                  <td className="num">{e.payloadPreview?.payload ? `${e.payloadPreview.payload.side} ${e.payloadPreview.payload.price} × ${e.payloadPreview.payload.count}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="warn">
        ⚠️ Bot en vivo APAGADO: con la configuración actual es imposible que se envíe una orden real.
        El auditor en papel (§6) sigue midiendo si la estrategia tiene ventaja; el bot solo operará
        cuando el interruptor global esté encendido, tú lo armes, y la señal sea viable dentro de los límites.
        El backtest honesto del motor sigue en ~46%: todavía no hay edge demostrado.
      </p>
    </section>
  );
}
