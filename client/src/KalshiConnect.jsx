// v12 — Conexión Kalshi SOLO LECTURA (ver posiciones reales, nunca operar).
// Recibe {token, kalshiScore, kalshiVerdictKey, currentPrice, currency}.
// La clave privada se envía UNA vez al servidor al conectar y se borra del
// formulario; nunca se guarda en localStorage ni se muestra completa: tras
// conectar solo se ve keyIdPreview. La app nunca compra, vende ni cierra
// posiciones por el usuario: todo lo que hace es leer y sugerir, con la
// misma lógica de ¿cobro o salgo? de la posición virtual (./kalshi.js).
// v13.3: la pestaña "Mi cuenta Kalshi" ya no existe: TODO vive aquí, en
// una sola instancia dentro de la pestaña Kalshi, en este orden:
//   §3 Mis posiciones de Kalshi (abiertas + cerradas)
//   §4 Mi cuenta (estado, saldo, botones, formulario de conexión)
// El aviso de solo lectura sale una sola vez, arriba. La predicción de
// la ventana, el ¿Cobro o me quedo? virtual y las últimas ventanas viven
// en App.jsx, alrededor de este componente.
import React, { useEffect, useRef, useState } from 'react';
import { apiAuth } from './auth.js';
import { cashOutDecision } from './kalshi.js';

// Deduce la dirección de una posición real a partir del ticker/título.
// Mercado "above/up/arriba" = apuesta a que SUBE; "below/down/abajo" = a
// que BAJA. El lado invierte el sentido: un NO en un mercado de subida
// es apostar a que BAJA (y viceversa). Se usan \b (límite de palabra)
// para que "up" no case dentro de "group". Si el título no dice hacia
// dónde va el mercado, o el lado es desconocido, devuelve null: no se
// inventa una dirección. El servidor calcula lo mismo (misma lógica) y
// lo devuelve en pos.direction; esto es el respaldo en el cliente.
// v13.2: ojo, el lado NO se puede deducir de una posición con cantidad
// 0: Kalshi solo devuelve el signo de `position` y un 0 no tiene signo,
// así que ese lado viene de los fills del servidor (sideSource 'fill')
// o es null. Nunca se muestra un SÍ inventado.
const UP_PATTERNS = [/\bprice up\b/, /\bgo(es)? up\b/, /\brise(s)?\b/, /\babove\b/, /\bup\b/, /\bpor encima\b/, /\barriba\b/, /\bsube\b/, /\bsubir\b/, /\bal alza\b/];
const DOWN_PATTERNS = [/\bprice down\b/, /\bgo(es)? down\b/, /\bfall(s)?\b/, /\bbelow\b/, /\bdown\b/, /\bpor debajo\b/, /\babajo\b/, /\bbaja\b/, /\bbajar\b/, /\ba la baja\b/];
function deriveDir(pos) {
  const text = [pos.ticker, pos.title, pos.marketTitle].filter(Boolean).join(' ').toLowerCase();
  const hasUp = UP_PATTERNS.some((re) => re.test(text));
  const hasDown = DOWN_PATTERNS.some((re) => re.test(text));
  let marketDir = null;
  if (hasUp && !hasDown) marketDir = 'up';
  else if (hasDown && !hasUp) marketDir = 'down';
  if (!marketDir) return null;
  const s = String(pos.side || '').toLowerCase();
  if (s === 'yes') return marketDir;
  if (s === 'no') return marketDir === 'up' ? 'down' : 'up';
  return null;
}

function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('es-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

// v13: Number(null) es 0, y por eso en el video una posición sin
// precio medio se veía como "0¢". Aquí null sigue siendo null.
function numOrNull(v) {
  if (v == null || v === '' || Number.isNaN(Number(v))) return null;
  return Number(v);
}

export default function KalshiConnect({ token, kalshiScore, kalshiVerdictKey, currentPrice, referencePrice, referenceSource, currency, user = null, onLogout = null }) {
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
  // v13.2: cantidad 0 NO es una posición abierta. Se filtra de la
  // tabla principal y se muestra aparte, sin P&L ni decisión. Solo
  // cantidad > 0 va en la tabla de abiertas con decisión.
  const openPositions = positions.filter((p) => (numOrNull(p.count) || 0) > 0);
  const closedPositions = positions.filter((p) => (numOrNull(p.count) || 0) === 0);

  // v13.3: el formulario de conexión es el mismo en los dos casos: a la
  // vista si no hay conexión, y colapsado (<details>) si ya la hay, para
  // cambiar de clave sin estorbar. Nunca se muestra dos veces a la vez.
  const connectForm = (
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
  );

  return (
    <div>
      {/* v13.3 §3 — Mis posiciones de Kalshi (solo lectura). */}
      <h3>📡 Mis posiciones de Kalshi — solo lectura</h3>
      <p className="warn">⚠️ SOLO LECTURA: esta app nunca compra, vende ni cierra posiciones por ti. Solo muestra tus posiciones reales de Kalshi y te sugiere, con la misma regla de la posición virtual, si cobrar o salir. Para operar tienes que hacerlo tú en Kalshi.</p>
      {loading && <p className="muted">Comprobando conexión con Kalshi…</p>}
      {error && <p className="error">{error}</p>}
      {msg && <p className="muted">{msg}</p>}

      {!connected && !loading && (
        <p className="muted">🔐 Kalshi no conectado: conecta tu cuenta abajo, en «Mi cuenta», para ver tus posiciones reales, tu saldo y tu historial.</p>
      )}

      {connected && (
        <div>
          {openPositions.length === 0 && (
            <p className="muted">No tienes posiciones abiertas en Kalshi ahora mismo{positionsData && positionsData.fetchedAt ? ` (consultado a las ${new Date(positionsData.fetchedAt).toLocaleTimeString('es-US')})` : ''}.{closedPositions.length > 0 ? ` Hay ${closedPositions.length} cerrada(s) abajo.` : ''}</p>
          )}
          {openPositions.length > 0 && (
            <div>
              <p className="muted">Posiciones abiertas reales de Kalshi (precios en centavos, 1–99¢; el contrato paga $1 si aciertas). Precio actual y decisión según la señal 15m de {currency || 'USD'}: <b>{kalshiVerdictKey === 'up' ? '▲ SUBE' : kalshiVerdictKey === 'down' ? '▼ BAJA' : '● ESPERAR'}</b> (puntuación {kalshiScore}). Comprueba a ojo cada fila: título del mercado, lado (SÍ/NO) y apuesta (SUBE/BAJA) tienen que coincidir con lo que apostaste en Kalshi.</p>
              <table className="league-table">
                <thead><tr><th>Mercado</th><th>Lado</th><th>Precio medio</th><th>Cantidad</th><th>Precio actual</th><th>P&amp;L estimado</th><th>¿Cobro o salgo?</th></tr></thead>
                <tbody>
                  {openPositions.map((pos, i) => {
                    // v13: null es null, no 0. Un precio medio sin dato
                    // se muestra como "—", no como "0¢" (ese era el bug
                    // del video: Number(null) === 0).
                    const avg = numOrNull(pos.avgPrice);
                    const cur = numOrNull(pos.currentPrice);
                    const count = numOrNull(pos.count) || 0;
                    // P&L estimado en $: (precio actual − precio medio) en centavos × cantidad / 100.
                    // currentPrice es el precio del lado que tienes (sí/no), igual que avgPrice.
                    const pnl = (Number.isFinite(avg) && Number.isFinite(cur) && count > 0)
                      ? ((cur - avg) / 100) * count : null;
                    // v13.2: la dirección viene del servidor (o se
                    // deduce aquí como respaldo). Si es null, NO se
                    // inventa: se muestra el aviso para verificar.
                    const dir = pos.direction || deriveDir(pos);
                    const dirLabel = dir === 'up' ? '▲ SUBE' : dir === 'down' ? '▼ BAJA' : null;
                    const amountUsd = (Number.isFinite(avg) && count > 0) ? (count * avg) / 100 : 0;
                    const decision = dir && Number.isFinite(avg) && Number.isFinite(cur)
                      ? cashOutDecision({ dir, entryPrice: avg, currentPrice: cur, amount: amountUsd, signalKey: kalshiVerdictKey, signalScore: kalshiScore })
                      : null;
                    const sideLabel = pos.side === 'yes' ? 'SÍ' : pos.side === 'no' ? 'NO' : '—';
                    return (
                      <tr key={`${pos.ticker || ''}-${i}`}>
                        <td><b>{pos.ticker || '—'}</b><br /><span className="muted">{pos.marketTitle || pos.title || ''}</span>{pos.note && (<><br /><span className="muted">⚠️ {pos.note}</span></>)}{pos.status && (<><br /><span className="muted">Estado del mercado: {pos.status}</span></>)}{pos.windowEndsAt && (<><br /><span className="muted">Cierre de ventana: {new Date(pos.windowEndsAt).toLocaleString('es-US')}</span></>)}</td>
                        <td>{sideLabel}{dirLabel ? (<><br /><b>Apuesta: {dirLabel}</b></>) : (<><br /><span className="muted">Apuesta: —</span></>)}
                          {pos.sideSource === 'fill' && (<><br /><span className="muted">Lado según tus operaciones</span></>)}
                          {pos.sideSource === 'unknown' && (<><br /><span className="muted">⚠️ Lado sin verificar: revísalo en Kalshi</span></>)}
                        </td>
                        <td>{avg != null ? `${avg}¢` : '—'}</td>
                        <td>{count > 0 ? count : '0 (cerrada)'}</td>
                        <td>{cur != null ? `${cur}¢` : '—'}</td>
                        <td className={pnl == null ? '' : pnl >= 0 ? 'up' : 'down'}>{pnl == null ? '—' : `${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}`}</td>
                        <td>
                          {pos.windowClosed ? (
                            <span className="muted"><b>Ventana cerrada:</b> la ventana de 15 min de este mercado ya cerró; no hay decisión de cobrar o salir. Revisa el resultado en Kalshi.</span>
                          ) : decision ? (
                            <span><b style={{ color: decision.color }}>{decision.label}</b><br /><span className="muted">{decision.title}</span></span>
                          ) : dir ? (
                            <span className="muted">Apuesta a que {dir === 'up' ? 'SUBE' : 'BAJA'}. Sin precio medio o actual no se puede calcular si vas ganando ni decidir cobrar o salir.</span>
                          ) : (
                            <span className="muted">⚠️ Sin decisión: no se pudo deducir si esta posición es a que SUBE o a que BAJA por el título o porque el lado no está verificado. Comprueba en Kalshi lo que apostaste.</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="muted">La decisión usa la señal 15m de la app (no la oficial de Kalshi) y es solo una sugerencia educativa: la app no cobra ni sale por ti. {referenceSource === 'kalshi'
                ? <>Precio objetivo de Kalshi: <b>{referencePrice ? new Intl.NumberFormat('es-US', { style: 'currency', currency: currency || 'USD' }).format(referencePrice) : '—'}</b> (contra este precio se liquida la ventana).</>
                : <>Precio de referencia de Coinbase (no de Kalshi): <b>{referencePrice ? new Intl.NumberFormat('es-US', { style: 'currency', currency: currency || 'USD' }).format(referencePrice) : '—'}</b> — la API pública de Kalshi no devolvió el mercado actual.</>} Precio en vivo de Coinbase ahora: {currentPrice ? new Intl.NumberFormat('es-US', { style: 'currency', currency: currency || 'USD' }).format(currentPrice) : '—'}.</p>
            </div>
          )}
          {closedPositions.length > 0 && (
            <div>
              <h4>Posiciones cerradas / liquidadas (cantidad 0)</h4>
              <p className="muted">Kalshi las sigue devolviendo con cantidad 0. No son posiciones abiertas: no hay nada que cobrar ni salir, así que van aquí, sin P&amp;L ni decisión. Comprueba que el lado y la apuesta coinciden con lo que apostaste.</p>
              <table className="league-table">
                <thead><tr><th>Mercado</th><th>Lado</th><th>Apuesta</th><th>Detalle</th></tr></thead>
                <tbody>
                  {closedPositions.map((pos, i) => {
                    const dir = pos.direction || deriveDir(pos);
                    const dirLabel = dir === 'up' ? '▲ SUBE' : dir === 'down' ? '▼ BAJA' : '—';
                    const sideLabel = pos.side === 'yes' ? 'SÍ' : pos.side === 'no' ? 'NO' : '—';
                    return (
                      <tr key={`${pos.ticker || ''}-cerrada-${i}`}>
                        <td><b>{pos.ticker || '—'}</b><br /><span className="muted">{pos.marketTitle || pos.title || ''}</span></td>
                        <td>{sideLabel}{pos.sideSource === 'fill' && (<><br /><span className="muted">según tus operaciones</span></>)}{pos.sideSource === 'unknown' && (<><br /><span className="muted">⚠️ sin verificar</span></>)}</td>
                        <td><b>{dirLabel}</b>{!dir && (<><br /><span className="muted">⚠️ No se pudo deducir: verifica en Kalshi</span></>)}</td>
                        <td><span className="muted">Cerrada (cantidad 0){pos.windowClosed ? ' · ventana cerrada' : ''}{pos.status ? ` · estado: ${pos.status}` : ''}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* v13.3 §4 — Mi cuenta: estado, saldo, botones y conexión. */}
      <h3>👤 Mi cuenta</h3>
      {user && (
        <p className="muted">Sesión: <b>{user.name || user.email}</b> ({user.email}){user.role === 'admin' ? ' · administrador' : ''}</p>
      )}
      {status && (
        <div className="stats">
          <div><span>Estado</span><b>{connected ? '✅ Conectado' : '— No conectado'}</b></div>
          <div><span>Key ID</span><b>{status.keyIdPreview || '—'}</b></div>
          <div><span>Última sincronización</span><b>{status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString('es-US') : '—'}</b></div>
          <div><span>Detalle</span><b>{status.status || '—'}</b></div>
        </div>
      )}
      {connected && balance && (
        <div className="stats">
          <div><span>Balance</span><b>{fmtUsd(balance.balance)}</b></div>
          <div><span>Valor de la cartera</span><b>{fmtUsd(balance.portfolioValue)}</b></div>
        </div>
      )}
      {connected && (
        <div className="row">
          <button onClick={load} disabled={loading}>Actualizar posiciones</button>
          <button onClick={doDisconnect} disabled={busy}>Desconectar Kalshi</button>
          {onLogout && <button onClick={onLogout}>Salir de mi cuenta</button>}
        </div>
      )}
      {!connected && !loading && connectForm}
      {connected && (
        <details>
          <summary>Conectar con otra clave de Kalshi</summary>
          {connectForm}
        </details>
      )}
    </div>
  );
}
