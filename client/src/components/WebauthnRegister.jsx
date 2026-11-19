// WebauthnRegister.jsx — v16.4 (Parte 1): registrar la huella o el
// rostro de ESTE dispositivo (autenticador de plataforma) con la sesión
// ya iniciada. Después, en la pantalla de entrar, el botón «Entrar con
// huella / rostro» usa esta credencial. Si el navegador o el
// dispositivo no lo admite, no se muestra el botón: solo una
// explicación corta. La lista muestra las huellas registradas (sin
// claves públicas: solo fecha y transports).
import { useEffect, useState } from 'react';
import { isWebauthnSupported, isPlatformAuthenticatorAvailable, webauthnRegister, listWebauthnCredentials } from '../webauthn.js';

export default function WebauthnRegister() {
  const [disponible, setDisponible] = useState(null);
  const [registradas, setRegistradas] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let vivo = true;
    isPlatformAuthenticatorAvailable().then((v) => { if (vivo) setDisponible(v); });
    listWebauthnCredentials().then((l) => { if (vivo) setRegistradas(l); }).catch(() => {});
    return () => { vivo = false; };
  }, []);

  async function registrar() {
    setMsg('');
    setError('');
    setBusy(true);
    try {
      await webauthnRegister();
      setMsg('Huella / rostro registrada en este dispositivo. Ya puedes entrar con ella.');
      const l = await listWebauthnCredentials().catch(() => []);
      setRegistradas(l);
    } catch (e) {
      setError(e.message || 'No se pudo registrar la huella.');
    } finally {
      setBusy(false);
    }
  }

  if (!isWebauthnSupported() || disponible === false) {
    return (
      <p className="muted">Tu navegador o dispositivo no tiene huella ni rostro disponible para entrar sin contraseña.</p>
    );
  }

  return (
    <div>
      <p className="muted">Entrada sin contraseña: registra la huella o el rostro de este dispositivo para entrar con ella la próxima vez.</p>
      <div className="row">
        <button type="button" disabled={busy || disponible === null} onClick={registrar}>
          {busy ? '…' : 'Registrar huella / rostro en este dispositivo'}
        </button>
      </div>
      {msg && <p>{msg}</p>}
      {error && <p className="error">{error}</p>}
      {registradas.length > 0 && (
        <p className="muted">
          Huellas registradas: {registradas.length}
          {registradas[0] && registradas[0].createdAt ? ` (última: ${new Date(registradas[0].createdAt).toLocaleDateString('es-US')})` : ''}
        </p>
      )}
    </div>
  );
}
