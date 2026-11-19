// SitePin.jsx — v16.5: gestión del PIN de acceso al sitio, en Mi cuenta.
// v16.7: el PIN es ajuste del dueño — cualquier usuario con sesión
// puede ponerlo, cambiarlo o quitarlo (el registro está cerrado y hay
// un solo usuario); el servidor ya no exige rol admin. Tres
// acciones: poner PIN, cambiar PIN (exige el actual) y quitar PIN
// (exige el actual). Validación en cliente: PIN de 4 a 32 caracteres,
// con confirmación del nuevo. Al poner/cambiar, el servidor devuelve
// el código de recuperación UNA vez: se muestra en un bloque destacado
// con el aviso de guardarlo y botones para copiarlo y para confirmar
// que se guardó (que lo oculta). Tras quitar el PIN, la web queda
// abierta a cualquiera. El PIN solo viaja en el body del POST; nunca
// se guarda en localStorage ni se escribe en logs.
// Tras poner/cambiar el PIN se verifica con el PIN nuevo para que este
// navegador reciba la cookie de puerta (cev_gate_v1) y la app no salte
// a la pantalla SiteGate justo después de ponerlo.
import { useState } from 'react';
import { apiAuth } from '../auth.js';
import { siteGateVerify } from '../siteGate.js';

const PIN_MIN = 4;
const PIN_MAX = 32;

export default function SitePin() {
  const [mode, setMode] = useState('set'); // 'set' | 'change' | 'remove'
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function clearPins() {
    setCurrentPin('');
    setNewPin('');
    setConfirmPin('');
  }

  function switchMode(next) {
    setMode(next);
    setMsg('');
    setError('');
    setRecoveryCode('');
    setCopied(false);
    clearPins();
  }

  function validateNewPin() {
    if (newPin.length < PIN_MIN || newPin.length > PIN_MAX) {
      setError(`El PIN debe tener entre ${PIN_MIN} y ${PIN_MAX} caracteres.`);
      return false;
    }
    if (newPin !== confirmPin) {
      setError('El PIN nuevo y su confirmación no coinciden.');
      return false;
    }
    return true;
  }

  async function submitSetOrChange(e) {
    e.preventDefault();
    setMsg('');
    setError('');
    setRecoveryCode('');
    setCopied(false);
    if (mode === 'change' && !currentPin) {
      setError('Pon el PIN actual.');
      return;
    }
    if (!validateNewPin()) return;
    setBusy(true);
    try {
      const data = await apiAuth('/api/site-gate/pin', {
        method: 'POST',
        body: { pin: newPin, currentPin: mode === 'change' ? currentPin : undefined },
      });
      const code = data && data.recoveryCode ? String(data.recoveryCode) : '';
      clearPins();
      // Que este navegador reciba la cookie de puerta con el PIN nuevo.
      try { await siteGateVerify(newPin); } catch { /* si falla, la puerta se mostrará sola al primer 403 */ }
      if (code) setRecoveryCode(code);
      setMsg(mode === 'change' ? 'PIN cambiado.' : 'PIN puesto: la web ya pide PIN para entrar.');
    } catch (err) {
      setError(err.message || 'No se pudo guardar el PIN.');
    } finally {
      setBusy(false);
    }
  }

  async function submitRemove(e) {
    e.preventDefault();
    setMsg('');
    setError('');
    setRecoveryCode('');
    if (!currentPin) {
      setError('Pon el PIN actual para quitarlo.');
      return;
    }
    setBusy(true);
    try {
      await apiAuth('/api/site-gate/pin/remove', { method: 'POST', body: { currentPin } });
      clearPins();
      setMsg('PIN quitado: la web queda abierta a cualquiera.');
    } catch (err) {
      setError(err.message || 'No se pudo quitar el PIN.');
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(recoveryCode);
      setCopied(true);
    } catch {
      // Sin portapapeles (navegador viejo): selecciona el texto a mano.
      setCopied(false);
      setError('No se pudo copiar automáticamente: selecciona el código y cópialo a mano.');
    }
  }

  return (
    <div>
      <p className="muted">Código de acceso al sitio: pon un PIN para que la web pida PIN antes de cargar. Lo pone, cambia o quita el dueño de la cuenta (hay un solo usuario: el registro está cerrado).</p>
      <div className="row">
        <button type="button" disabled={busy} onClick={() => switchMode('set')}>Poner PIN</button>
        <button type="button" disabled={busy} onClick={() => switchMode('change')}>Cambiar PIN</button>
        <button type="button" disabled={busy} onClick={() => switchMode('remove')}>Quitar PIN</button>
      </div>

      {mode !== 'remove' ? (
        <form onSubmit={submitSetOrChange}>
          <div className="row">
            {mode === 'change' && (
              <label>PIN actual: <input type="password" value={currentPin} autoComplete="off" onChange={(e) => setCurrentPin(e.target.value)} placeholder="PIN actual" /></label>
            )}
            <label>PIN nuevo: <input type="password" value={newPin} autoComplete="off" onChange={(e) => setNewPin(e.target.value)} placeholder={`Entre ${PIN_MIN} y ${PIN_MAX} caracteres`} /></label>
            <label>Confirmar PIN nuevo: <input type="password" value={confirmPin} autoComplete="off" onChange={(e) => setConfirmPin(e.target.value)} placeholder="Repite el PIN nuevo" /></label>
            <button type="submit" className="primary" disabled={busy}>{busy ? '…' : mode === 'change' ? 'Cambiar PIN' : 'Poner PIN'}</button>
          </div>
        </form>
      ) : (
        <form onSubmit={submitRemove}>
          <div className="row">
            <label>PIN actual: <input type="password" value={currentPin} autoComplete="off" onChange={(e) => setCurrentPin(e.target.value)} placeholder="PIN actual" /></label>
            <button type="submit" className="primary" disabled={busy}>{busy ? '…' : 'Quitar PIN'}</button>
          </div>
          <p className="muted">Al quitar el PIN, la web queda abierta a cualquiera: cualquiera que abra la dirección la verá sin PIN.</p>
        </form>
      )}

      {msg && <p>{msg}</p>}
      {error && <p className="error">{error}</p>}

      {recoveryCode && (
        <div style={{ border: '2px solid #f59e0b', borderRadius: '8px', padding: '12px', marginTop: '8px' }}>
          <p><b>Código de recuperación:</b></p>
          <p style={{ fontSize: '18px', letterSpacing: '1px', wordBreak: 'break-all' }}><code>{recoveryCode}</code></p>
          <p><b>Guárdalo: es la única forma de recuperar el acceso si olvidas el PIN. No se vuelve a mostrar.</b></p>
          <div className="row">
            <button type="button" onClick={copyCode}>{copied ? 'Copiado' : 'Copiar código'}</button>
            <button type="button" className="primary" onClick={() => setRecoveryCode('')}>Ya lo guardé</button>
          </div>
        </div>
      )}
    </div>
  );
}
