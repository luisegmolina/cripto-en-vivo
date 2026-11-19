// AccountBox.jsx — v15.3: Mi cuenta Kalshi discreta, solo un <details>.
// KalshiConnect en modo mínimo: sigue cargando las posiciones y
// subiendo la decisión real a la §1 y §2, pero NO muestra la tabla ni
// el historial. Sin sesión, solo los botones de entrar/crear cuenta.
// v16.4: con sesión, también el registro de huella / rostro de este
// dispositivo (WebauthnRegister.jsx).
import KalshiConnect from '../KalshiConnect.jsx';
import WebauthnRegister from './WebauthnRegister.jsx';

export default function AccountBox({ user, token, kalshiScore, kalshiVerdictKey, kalshiPrice, kalshiRefPrice, kalshiRefSource, currency, onLogout, onRealDecision, onShowAuth }) {
  return (
    <details className="account-details">
      <summary>⚙️ Mi cuenta Kalshi — conectar / desconectar</summary>
      {user ? (
        <>
          <WebauthnRegister />
          <KalshiConnect token={token} kalshiScore={kalshiScore} kalshiVerdictKey={kalshiVerdictKey} currentPrice={kalshiPrice} referencePrice={kalshiRefPrice} referenceSource={kalshiRefSource} currency={currency} user={user} onLogout={onLogout} active onRealDecision={onRealDecision} minimal />
        </>
      ) : (
        <div>
          <p className="muted">Entra o crea tu cuenta para conectar tu Kalshi y ver tus posiciones reales. La app solo lee tus posiciones mientras el bot en vivo (§7) esté apagado; hoy está apagado.</p>
          <div className="row">
            <button onClick={() => onShowAuth('login')}>Entrar</button>
            <button onClick={() => onShowAuth('register')}>Crear cuenta</button>
          </div>
        </div>
      )}
    </details>
  );
}
