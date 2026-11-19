// PaperTrader.jsx — v17: §6 Trader continuo en papel (sin dinero real).
// Solo LEE el estado del trader del servidor (GET /api/kalshi/paper-trader
// cada 2 s) y pide Iniciar/Detener. Nunca envía órdenes a Kalshi ni toca
// dinero real: entra y sale EN PAPEL con el modelo de probabilidad
// continuo del servidor (server/paperTrader.js), con las 3 reglas de
// salida (ganancia +$0.02, stop-loss 50% del costo, fin de
// ventana). v16.10 QUITÓ la salida por lock roto: el trader evalúa
// entrada y salida a cualquier R de la ventana (antes solo en el
// último minuto), y cada evaluación queda en el anillo `evaluaciones`
// del snapshot (entradas y rechazos con su motivo). v17 QUITA el tope
// de 5 entradas/día y PERMITE re-entrar en la misma ventana tras una
// salida si el EV lo justifica (1 posición abierta a la vez, como
// siempre). El trader EN VIVO no tiene salida: liveTrader.js NO se
// tocó en esta versión y sigue sin vender antes de la liquidación.
// Avisos honestos: solo corre mientras el servidor está despierto
// (Render gratis duerme tras 15 min sin tráfico y el WS BRTI se
// cierra a los 5 min sin sondeo), y el backtest del motor sigue en
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

function fmtUsd(n, dec = 4) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  return `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(dec)}`;
}

function fmtHora(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleTimeString('es-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return '—'; }
}

const MOTIVOS = {
  // lock_roto solo aparece en trades cerrados ANTES de v16.10 (la
  // salida por lock roto se quitó en v16.10); se conserva la etiqueta
  // para que el historial viejo se siga leyendo.
  lock_roto: 'Lock roto',
  ganancia: 'Ganancia +$0.02',
  stop_loss: 'Stop-loss 50%',
  fin_ventana: 'Fin de ventana',
  liquidacion: 'Liquidación',
};

// Motivos del anillo `evaluaciones` del snapshot (v16.10): 'entrada'
// cuando entró; si no, el motivo del rechazo según el servidor.
// v17: 'max_entradas_dia' y 'sin_reentrada' YA NO EXISTEN (sin tope
// diario y con re-entrada permitida tras una salida).
const MOTIVOS_EVAL = {
  entrada: 'Entrada',
  sin_quote_fresca: 'Sin quote fresca',
  sin_ev_valido: 'Sin EV válido',
  ev_bajo: 'EV bajo (≤ $0.015)',
  max_notional: 'Notional > $5',
  sin_sigma: 'Sin σ',
  sin_tick_brti: 'Sin tick BRTI',
  tick_desactualizado: 'Tick BRTI desactualizado',
  sin_tiempo: 'Sin tiempo restante',
};

// Comisión taker de Kalshi por contrato: 0.07 × precio × (1 − precio).
// Misma fórmula que el servidor (calcularComisionPorContrato).
function fee(precio) {
  const p = Number(precio);
  if (!Number.isFinite(p) || p < 0 || p > 1) return null;
  return 0.07 * p * (1 - p);
}

// Precio de salida en papel con la quote actual: SÍ → yesBid real;
// NO → 1 − yesAsk (identidad de libro único, misma que el servidor).
function precioSalida(pos, quote) {
  if (!pos || !quote) return null;
  if (pos.lado === 'yes') return quote.yesBidDollars;
  if (pos.lado === 'no') {
    if (quote.yesAskDollars == null) return null;
    return 1 - Number(quote.yesAskDollars);
  }
  return null;
}

export default function PaperTrader({ user, fmt }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!user) { setData(null); return; }
    let alive = true;
    const load = async () => {
      try {
        const d = await apiAuth('/api/kalshi/paper-trader');
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
    trades: 0, ganados: 0, perdidos: 0, pnlTotalUsd: 0,
    pnlConSalidasUsd: 0, pnlManteniendoUsd: 0, holdPendientes: 0,
    pendientesLiquidacion: 0, entradasHoy: 0,
  };
  const trades = Array.isArray(data?.trades) ? data.trades : [];
  // v16.10: anillo de evaluaciones del snapshot (newest first, máx.
  // 20, solo en memoria del servidor). Si el campo falta (servidor
  // anterior a v16.10) se muestra la sección vacía, sin inventar datos.
  const evaluaciones = Array.isArray(data?.evaluaciones) ? data.evaluaciones : [];
  const pos = data?.posicionAbierta || null;
  const contrato = data?.contrato || null;
  const quote = data?.quote || null;
  const pAct = data?.pActual || null;

  const salida = precioSalida(pos, quote);
  const feeSalida = salida != null ? fee(salida) : null;
  const netoSalida = salida != null && feeSalida != null ? salida - feeSalida : null;
  const pnlVivo = netoSalida != null && pos ? netoSalida - Number(pos.costoTotal) : null;

  return (
    <section className="card">
      <div className="section-header">
        <h2>6 · Trader continuo en papel — entrada y salida (sin dinero real)</h2>
        <span className="badge">{data?.enabled ? '● Activo' : '○ Parado'}</span>
      </div>

      {!user && (
        <p className="muted">Entra con tu cuenta para usar el trader en papel. Sin sesión no hay BRTI en vivo con el que operar.</p>
      )}

      {user && data && data.kalshiConnected === false && (
        <p className="warn">⚠️ Kalshi no conectado: conecta tu cuenta Kalshi abajo para operar en papel. Sin BRTI en vivo no hay nada que operar.</p>
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
          <span>Cierra en</span>
          <b>{contrato && contrato.closeIso ? fmtHora(contrato.closeIso) : '—'}</b>
        </div>
        <div>
          <span>Salto actual (para revertir)</span>
          <b className={data?.saltoActual != null ? (data.saltoActual >= 0 ? 'up' : 'down') : ''}>
            {data?.saltoActual != null ? `${data.saltoActual > 0 ? '+' : ''}$${fmtNum(data.saltoActual)}` : '—'}
          </b>
        </div>
        <div>
          <span>p actual (SÍ / NO)</span>
          <b>{pAct ? `${fmtNum(pAct.pYes * 100, 1)}% / ${fmtNum(pAct.pNo * 100, 1)}%` : '—'}</b>
        </div>
        <div>
          <span>TWAP actual / σ</span>
          <b>{data?.twapActual != null ? fmt(data.twapActual, 'USD') : '—'}{data?.sigmaActual != null ? ` · σ $${fmtNum(data.sigmaActual)}` : ''}</b>
        </div>
        <div>
          <span>Entradas hoy</span>
          <b>{data?.entradasHoy ?? 0}</b>
        </div>
        <div>
          <span>Ask SÍ / NO (Kalshi)</span>
          <b>{quote ? `SÍ $${fmtNum(quote.yesAskDollars, 4)} · NO $${fmtNum(quote.noAskDollars, 4)}` : '—'}</b>
        </div>
      </div>

      {data?.ultimoError && <p className="warn">⚠️ {data.ultimoError}</p>}

      {pos ? (
        <div className="signal" style={{ borderColor: pnlVivo != null && pnlVivo >= 0 ? '#10b981' : '#f59e0b' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>📈 Posición abierta en papel: {pos.lado === 'yes' ? 'SÍ (SUBE)' : 'NO (BAJA)'} · {pos.ticker}</b>
            <span className="muted">R a la entrada: T-{pos.segundosRestantesEntrada}s · entró {fmtHora(pos.enteredAt)}</span>
          </div>
          <span>
            Ask de entrada: ${fmtNum(pos.askEntrada, 4)} · Fee: ${fmtNum(pos.feeEntrada, 4)} · Costo total: ${fmtNum(pos.costoTotal, 4)} ·{' '}
            p estimada: {fmtNum(pos.pEstimada * 100, 1)}% · EV estimado: {fmtUsd(pos.evEstimada)} · BRTI a la entrada: {pos.brtiEntrada != null ? fmt(pos.brtiEntrada, 'USD') : '—'}
          </span>
          <span>
            Valor actual: {salida != null ? `$${fmtNum(salida, 4)} (bid)` : '—'}{netoSalida != null ? ` · neto tras fee: $${fmtNum(netoSalida, 4)}` : ''} ·{' '}
            <b className={pnlVivo != null && pnlVivo >= 0 ? 'up' : 'down'}>
              P&L en papel ahora: {pnlVivo != null ? fmtUsd(pnlVivo) : '—'}
            </b>
          </span>
          <span className="muted">
            Sale sola si: el neto llega a costo + $0.02, el neto cae a la mitad del costo, o quedan ≤3 s y va perdiendo.
            Ya no hay salida por lock roto (v16.10): una posición con el bloqueo roto se mantiene hasta que dispare
            ganancia, stop o fin de ventana.
          </span>
        </div>
      ) : (
        <p className="muted">Sin posición abierta en papel. El trader entra solo cuando el EV por contrato supera $0.015 (con quote fresca y σ disponible), por el lado de mayor EV, en cualquier momento de la ventana — no solo al final. Tras una salida puede volver a entrar en la misma ventana si el EV lo justifica (v17, sin tope de entradas al día).</p>
      )}

      <div className="row" style={{ marginTop: '10px' }}>
        <button className="primary" disabled={busy || !user || data?.kalshiConnected === false || data?.enabled} onClick={() => accion('/api/kalshi/paper-trader/start', 'Trader en papel iniciado. Solo corre mientras el servidor está despierto.')}>▶ Iniciar trader</button>
        <button disabled={busy || !user || !data?.enabled} onClick={() => accion('/api/kalshi/paper-trader/stop', 'Trader en papel detenido. La posición abierta, si la hay, queda guardada tal cual.')}>■ Detener</button>
      </div>

      <h3>Últimos trades en papel ({trades.length})</h3>
      <p className="muted">
        Trades cerrados: {stats.trades} · Ganados: {stats.ganados} · Perdidos: {stats.perdidos} ·{' '}
        <b className={stats.pnlTotalUsd >= 0 ? 'up' : 'down'}>P&L total en papel: {fmtUsd(stats.pnlTotalUsd)}</b> ·{' '}
        P&L con salidas: {fmtUsd(stats.pnlConSalidasUsd)} vs P&L de haber mantenido: {fmtUsd(stats.pnlManteniendoUsd)}
        {stats.holdPendientes > 0 ? ` (aún faltan ${stats.holdPendientes} liquidaciones para comparar)` : ''}
        {stats.pendientesLiquidacion > 0 ? ` · ${stats.pendientesLiquidacion} pendiente(s) de liquidación` : ''}
      </p>
      {trades.length === 0 ? (
        <p className="muted">Aún no hay trades en papel. Inicia el trader y deja pasar al menos una ventana de 15 minutos.</p>
      ) : (
        <div className="audit-table-wrap">
          <table className="audit-table">
            <thead>
              <tr>
                <th>Ventana</th>
                <th>Lado</th>
                <th>Entrada</th>
                <th>Salida</th>
                <th>Motivo</th>
                <th>P&L en papel</th>
                <th>P&L si mantenía</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id || `${t.ticker}-${t.enteredAt || ''}`}>
                  <td>{t.ticker ? t.ticker.replace('KXBTC15M-', '') : '—'}</td>
                  <td>{t.lado === 'yes' ? 'SÍ' : t.lado === 'no' ? 'NO' : '—'}</td>
                  <td className="num">${fmtNum(t.askEntrada, 4)}{t.feeEntrada != null ? ` +$${fmtNum(t.feeEntrada, 4)}` : ''} · {fmtHora(t.enteredAt)}</td>
                  <td className="num">{t.precioSalida != null ? `$${fmtNum(t.precioSalida, 4)}` : '—'}{t.exitedAt ? ` · ${fmtHora(t.exitedAt)}` : ''}</td>
                  <td>{t.motivoSalida ? (MOTIVOS[t.motivoSalida] || t.motivoSalida) : '—'}</td>
                  <td className={`num ${typeof t.pnlUsd === 'number' ? (t.pnlUsd >= 0 ? 'up' : 'down') : ''}`}>{typeof t.pnlUsd === 'number' ? fmtUsd(t.pnlUsd) : '—'}</td>
                  <td className={`num ${typeof t.holdPnlUsd === 'number' ? (t.holdPnlUsd >= 0 ? 'up' : 'down') : ''}`}>{typeof t.holdPnlUsd === 'number' ? fmtUsd(t.holdPnlUsd) : '—'}</td>
                  <td>{t.estado === 'cerrado' ? 'Cerrado' : 'Pendiente liquidación'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Últimas evaluaciones ({evaluaciones.length})</h3>
      <p className="muted">
        Cada evaluación de entrada del trader, a cualquier R de la ventana: las que entraron y las rechazadas con su
        motivo (p y EV estimados, ask del momento). Anillo de las últimas 20, solo en memoria del servidor.
      </p>
      {evaluaciones.length === 0 ? (
        <p className="muted">Sin evaluaciones todavía.</p>
      ) : (
        <div className="audit-table-wrap">
          <table className="audit-table">
            <thead>
              <tr>
                <th>Hora</th>
                <th>R</th>
                <th>Lado</th>
                <th>p</th>
                <th>EV</th>
                <th>Ask</th>
                <th>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {evaluaciones.map((ev, i) => (
                <tr key={ev.at || i}>
                  <td>{fmtHora(ev.at)}</td>
                  <td className="num">{ev.R != null ? `T-${ev.R}s` : '—'}</td>
                  <td>{ev.lado === 'yes' ? 'SÍ' : ev.lado === 'no' ? 'NO' : '—'}</td>
                  <td className="num">{ev.p != null ? `${fmtNum(ev.p * 100, 1)}%` : '—'}</td>
                  <td className="num">{ev.ev != null ? fmtUsd(ev.ev) : '—'}</td>
                  <td className="num">{ev.ask != null ? `$${fmtNum(ev.ask, 4)}` : '—'}</td>
                  <td>{ev.motivo ? (MOTIVOS_EVAL[ev.motivo] || ev.motivo) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="warn">
        ⚠️ Papel solamente: el trader nunca envía órdenes a Kalshi y nunca mueve dinero real.
        Solo corre mientras el servidor está despierto: en Render gratis el servicio duerme tras 15 min sin tráfico
        y el WS BRTI se cierra a los 5 min sin sondeo. El backtest honesto del motor sigue en ~46%:
        todavía no hay edge demostrado, esto solo mide si operar en continuo lo tiene.
        Y ojo: el trader EN VIVO (§7) NO tiene salida — entra y mantiene hasta liquidación;
        liveTrader.js no se tocó en esta versión. Lo que aquí sale en papel, en vivo seguiría hasta el final.
      </p>
    </section>
  );
}
