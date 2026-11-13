// v12 — Conexión Kalshi SOLO LECTURA (ver posiciones reales, nunca operar).
// Recibe {token, kalshiScore, kalshiVerdictKey, currentPrice, currency}.
// La clave privada se envía UNA vez al servidor al conectar y se borra del
// formulario; nunca se guarda en localStorage ni se muestra completa: tras
// conectar solo se ve keyIdPreview. La app nunca compra, vende ni cierra
// posiciones por el usuario: todo lo que hace es leer y sugerir, con la
// misma lógica de ¿cobro o salgo? de la posición virtual (./kalshi.js).
import React, { useEffect, useRef, useState } from 'react';
import { apiAuth } from './auth.js';
import { cashOutDecision } from './kalshi.js';

// Deduce la dirección de una posición real a partir del ticker/título.
// Mercado "above/up/arriba" = apuesta a que SUBE; "below/down/abajo" = a
// que BAJA. El lado invierte el sentido: un NO en un mercado de subida
// es apostar a que BAJA (y viceversa). Si el título no dice hacia dónde
// va el mercado, no se puede deducir y la posición se muestra sin decisión.
function deriveDir(pos) {
  const text = [pos.ticker, pos.title, pos.marketTitle].filter(Boolean).join(' ').toLowerCase();
  const upWords = ['above', 'por encima', 'arriba', 'sube', 'up'];
  const downWords = ['below', 'por debajo', 'abajo', 'baja', 'down'];
  const hasUp = upWords.some((w) => text.includes(w));
  const hasDown = downWords.some((w) => text.includes(w));
  let marketDir = null;
  if (hasUp && !hasDown) marketDir = 'up';
  else if (hasDown && !hasUp) marketDir = 'down';
  if (!marketDir) return null;
  if (pos.side === 'no') return marketDir === 'up' ? 'down' : 'up';
  return marketDir; // side 'yes' (o sin lado): la dirección es la del mercado
}

function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('es-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

export default function KalshiConnect({ token, kalshiScore, kalshiVerdictKey, currentPrice, currency }) {
  const [status, setStatus] = useState(null); // {connected, keyIdPreview, lastSyncAt, status}
  const [positionsData, setPositionsData] = useState(null); // {connected, balance, positions, fetchedAt, source}
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [keyId, setKeyId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const fileRef = useRef(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [s, p] = await Promise.all([
        apiAuth('/api/kalshi/status'),
        apiAuth('/api/kalshi/positions'),
      ]);
      setStatus(s);
      setPositionsData(p);
    } catch (e) {
      setError(e.message || 'No se pudo cargar el estado de Kalshi.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  function onPemFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => setPrivateKey(String(reader.result || ''));
    reader.onerror = () => setMsg('No se pudo leer el archivo .pem.');
    reader.readAsText(f);
  }

  async function doConnect(e) {
    e.preventDefault();
    setMsg('');
    setError('');
    if (!keyId.trim() || !privateKey.trim()) {
      setMsg('Falta el Key ID o la clave privada (.pem).');
      return;
    }
    setBusy(true);
    try {
      const s = await apiAuth('/api/kalshi/connect', {
        method: 'POST',
        body: { keyId: keyId.trim(), privateKey },
      });
      setStatus(s);
      // La clave privada se borra del formulario en cuanto el servidor
      // la acepta: no queda en pantalla ni en el navegador.
      setPrivateKey('');
      setFileName('');
      if (fileRef.current) fileRef.current.value = '';
      setMsg(`✅ Kalshi conectado (${s.keyIdPreview || 'clave guardada'}). Solo lectura: la app nunca opera por ti.`);
      const p = await apiAuth('/api/kalshi/positions');
      setPositionsData(p);
    } catch (err) {
      if (err.status === 503) setError('El servidor no tiene configurada la clave de cifrado: no se puede guardar tu clave de Kalshi. Avisale al administrador.');
      else setError(err.message || 'No se pudo conectar con Kalshi. Revisa el Key ID y la clave privada.');
    } finally {
      setBusy(false);
    }
  }

  async function doDisconnect() {
    setBusy(true);
    setMsg('');
    setError('');
    try {
      await apiAuth('/api/kalshi/connect', { method: 'DELETE' });
      setStatus({ connected: false, keyIdPreview: null, lastSyncAt: null, status: 'disconnected' });
      setPositionsData({ connected: false, balance: null, positions: [] });
      setKeyId('');
      setPrivateKey('');
      setFileName('');
      setMsg('Kalshi desconectado. Tu clave se borró del servidor.');
    } catch (e) {
      setError(e.message || 'No se pudo desconectar.');
    } finally {
      setBusy(false);
    }
  }

  const connected = Boolean(status && status.connected);
  const positions = (positionsData && Array.isArray(positionsData.positions)) ? positionsData.positions : [];
  const balance = positionsData && positionsData.balance;

  return (
    <div>
      <h3>📡 Mi cuenta de Kalshi — solo lectura</h3>
      <p className="warn">⚠️ SOLO LECTURA: esta app nunca compra, vende ni cierra posiciones por ti. Solo muestra tus posiciones reales de Kalshi y te sugiere, con la misma regla de la posición virtual, si cobrar o salir. Para operar tienes que hacerlo tú en Kalshi.</p>
      {loading && <p className="muted">Comprobando conexión con Kalshi…</p>}
      {error && <p className="error">{error}</p>}
      {msg && <p className="muted">{msg}</p>}

      {status && (
        <div className="stats">
          <div><span>Estado</span><b>{connected ? '✅ Conectado' : '— No conectado'}</b></div>
          <div><span>Key ID</span><b>{status.keyIdPreview || '—'}</b></div>
          <div><span>Última sincronización</span><b>{status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString('es-US') : '—'}</b></div>
          <div><span>Detalle</span><b>{status.status || '—'}</b></div>
        </div>
      )}

      {!connected && !loading && (
        <form onSubmit={doConnect}>
          <div className="row">
            <label>Kalshi API Key ID: <input type="text" value={keyId} autoComplete="off" placeholder="Ej.: 12345678-…" onChange={(e) => setKeyId(e.target.value)} /></label>
          </div>
          <div className="row">
            <label>Clave privada (.pem): <textarea rows={4} cols={50} value={privateKey} autoComplete="off" placeholder="-----BEGIN PRIVATE KEY----- …" onChange={(e) => setPrivateKey(e.target.value)} /></label>
          </div>
          <div className="row">
            <label>O sube el archivo .pem: <input ref={fileRef} type="file" accept=".pem,application/x-pem-file,text/plain" onChange={onPemFile} /></label>
            {fileName && <span className="muted">Archivo: {fileName} (el contenido no se muestra)</span>}
          </div>
          <div className="row">
            <button type="submit" disabled={busy}>{busy ? 'Conectando…' : 'Conectar Kalshi (solo lectura)'}</button>
          </div>
          <p className="muted">Tu clave privada se envía cifrada al servidor y nunca se muestra completa: después de conectar solo verás el Key ID. No se guarda en este navegador.</p>
        </form>
      )}

      {connected && (
        <div>
          <div className="row">
            <button onClick={load} disabled={loading}>Actualizar posiciones</button>
            <button onClick={doDisconnect} disabled={busy}>Desconectar Kalshi</button>
          </div>
          {balance && (
            <div className="stats">
              <div><span>Balance</span><b>{fmtUsd(balance.balance)}</b></div>
              <div><span>Valor de la cartera</span><b>{fmtUsd(balance.portfolioValue)}</b></div>
            </div>
          )}
          {positions.length === 0 && (
            <p className="muted">No tienes posiciones abiertas en Kalshi ahora mismo{positionsData && positionsData.fetchedAt ? ` (consultado a las ${new Date(positionsData.fetchedAt).toLocaleTimeString('es-US')})` : ''}.</p>
          )}
          {positions.length > 0 && (
            <div>
              <p className="muted">Posiciones reales de Kalshi (precios en centavos, 1–99¢; el contrato paga $1 si aciertas). Precio actual y decisión según la señal 15m de {currency || 'USD'}: <b>{kalshiVerdictKey === 'up' ? '▲ SUBE' : kalshiVerdictKey === 'down' ? '▼ BAJA' : '● ESPERAR'}</b> (puntuación {kalshiScore}).</p>
              <table className="league-table">
                <thead><tr><th>Mercado</th><th>Lado</th><th>Precio medio</th><th>Cantidad</th><th>Precio actual</th><th>P&amp;L estimado</th><th>¿Cobro o salgo?</th></tr></thead>
                <tbody>
                  {positions.map((pos, i) => {
                    const avg = Number(pos.avgPrice);
                    const cur = Number(pos.currentPrice);
                    const count = Number(pos.count) || 0;
                    // P&L estimado en $: (precio actual − precio medio) en centavos × cantidad / 100.
                    // currentPrice es el precio del lado que tienes (sí/no), igual que avgPrice.
                    const pnl = (Number.isFinite(avg) && Number.isFinite(cur) && count > 0)
                      ? ((cur - avg) / 100) * count : null;
                    const dir = deriveDir(pos);
                    const amountUsd = (Number.isFinite(avg) && count > 0) ? (count * avg) / 100 : count;
                    const decision = dir && Number.isFinite(avg) && Number.isFinite(cur)
                      ? cashOutDecision({ dir, entryPrice: avg, currentPrice: cur, amount: amountUsd, signalKey: kalshiVerdictKey, signalScore: kalshiScore })
                      : null;
                    return (
                      <tr key={`${pos.ticker || ''}-${i}`}>
                        <td><b>{pos.ticker || '—'}</b><br /><span className="muted">{pos.marketTitle || pos.title || ''}</span></td>
                        <td>{pos.side === 'yes' ? 'SÍ' : pos.side === 'no' ? 'NO' : (pos.side || '—')}</td>
                        <td>{Number.isFinite(avg) ? `${avg}¢` : '—'}</td>
                        <td>{count || '—'}</td>
                        <td>{Number.isFinite(cur) ? `${cur}¢` : '—'}</td>
                        <td className={pnl == null ? '' : pnl >= 0 ? 'up' : 'down'}>{pnl == null ? '—' : `${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}`}</td>
                        <td>
                          {decision ? (
                            <span><b style={{ color: decision.color }}>{decision.label}</b><br /><span className="muted">{decision.title}</span></span>
                          ) : (
                            <span className="muted">Sin decisión: no se puede deducir si esta posición es a que SUBE o a que BAJA por el ticker/título.</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="muted">La decisión usa la señal 15m de la app (no la oficial de Kalshi) y es solo una sugerencia educativa: la app no cobra ni sale por ti. Precio de referencia de {currency || 'USD'} ahora: {currentPrice ? new Intl.NumberFormat('es-US', { style: 'currency', currency: currency || 'USD' }).format(currentPrice) : '—'}.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
