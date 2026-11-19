// SiteGate.jsx — v16.5: pantalla de PIN que se muestra ANTES del login
// cuando la puerta del sitio está cerrada (GET /api/site-gate/status
// devuelve {locked:true}). No muestra nada de la app ni del login.
// Incluye el formulario de PIN y, con el enlace "Usar código de
// recuperación", el formulario del código (POST /api/site-gate/recover),
// que quita el PIN. Los errores son genéricos a propósito: no filtran
// si el PIN existe ni si el código es válido. Estilo coherente con
// AuthModal (mismas clases .card / .row / .muted / .error / .primary).
// El PIN solo viaja en el body del POST; nunca se guarda.
import { useState } from 'react';
import { siteGateVerify, siteGateRecover } from '../siteGate.js';

const GENERIC_ERROR = 'PIN o código incorrecto. Inténtalo de nuevo.';

export default function SiteGate({ onUnlocked }) {
  const [mode, setMode] = useState('pin'); // 'pin' | 'recover'
  const [pin, setPin] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function switchMode(next) {
    setMode(next);
    setError('');
    setPin('');
    setCode('');
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    const value = mode === 'pin' ? pin : code;
    if (!value.trim()) {
      setError(mode === 'pin' ? 'Pon el PIN de acceso.' : 'Pon el código de recuperación.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'pin') await siteGateVerify(pin);
      else await siteGateRecover(code);
      setPin('');
      setCode('');
      onUnlocked();
    } catch (err) {
      // Genérico a propósito: no filtrar si el PIN existe. Solo el
      // fallo de conexión se dice tal cual (no es un dato del PIN).
      setError(err && /No se pudo contactar/.test(err.message || '') ? err.message : GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Acceso al sitio</h2>
      {mode === 'pin' ? (
        <>
          <p className="muted">Esta web está protegida con un PIN de acceso. Pon el PIN para entrar.</p>
          <form onSubmit={submit}>
            <div className="row">
              <label>PIN de acceso: <input type="password" value={pin} autoComplete="off" onChange={(e) => setPin(e.target.value)} placeholder="PIN de acceso" /></label>
              <button type="submit" className="primary" disabled={busy}>{busy ? '…' : 'Entrar'}</button>
            </div>
          </form>
          {error && <p className="error">{error}</p>}
          <p className="muted"><button type="button" onClick={() => switchMode('recover')}>Usar código de recuperación</button></p>
        </>
      ) : (
        <>
          <p className="muted">El código de recuperación quita el PIN y deja la web abierta a cualquiera. Úsalo solo si olvidaste el PIN: es la única forma de recuperar el acceso sin él.</p>
          <form onSubmit={submit}>
            <div className="row">
              <label>Código de recuperación: <input type="text" value={code} autoComplete="off" onChange={(e) => setCode(e.target.value)} placeholder="Código de recuperación" /></label>
              <button type="submit" className="primary" disabled={busy}>{busy ? '…' : 'Quitar el PIN y entrar'}</button>
            </div>
          </form>
          {error && <p className="error">{error}</p>}
          <p className="muted"><button type="button" onClick={() => switchMode('pin')}>Volver al PIN</button></p>
        </>
      )}
    </section>
  );
}
