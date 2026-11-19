// AuthModal.jsx — v15.3: modal de entrar / crear cuenta (sin registro
// obligatorio para ver precios y señales). La cuenta te deja conectar
// tu Kalshi para ver el valor BRTI en vivo y tus posiciones (solo
// lectura mientras el bot en vivo §7 esté apagado; hoy está apagado).
// Solo presenta: el envío y el estado viven en App.jsx.
// v16.4: en modo login, botón "Entrar con huella / rostro" (WebAuthn,
// autenticador de plataforma). Solo se muestra si el navegador y el
// dispositivo lo admiten (webauthnAvailable); si no, se muestra
// deshabilitado con una explicación corta. El registro de la huella
// vive en WebauthnRegister.jsx (con sesión iniciada).
export default function AuthModal({ showAuth, authName, onAuthName, authEmail, onAuthEmail, authPassword, onAuthPassword, authBusy, authError, onSubmit, onClose, onSwitchMode, webauthnAvailable, onWebauthnLogin, webauthnBusy, webauthnError }) {
  return (
    <section className="card">
      <h2>{showAuth === 'register' ? 'Crear cuenta' : 'Entrar'}</h2>
      <p className="muted">La cuenta te deja conectar tu Kalshi para ver el valor BRTI en vivo y tus posiciones (solo lectura mientras el bot en vivo §7 esté apagado; hoy está apagado). Ver la pantalla no necesita cuenta.</p>
      <form onSubmit={onSubmit}>
        <div className="row">
          {showAuth === 'register' && (
            <label>Nombre: <input type="text" value={authName} autoComplete="name" onChange={(e) => onAuthName(e.target.value)} placeholder="Tu nombre" /></label>
          )}
          <label>Email: <input type="email" value={authEmail} autoComplete="email" onChange={(e) => onAuthEmail(e.target.value)} placeholder="tu@email.com" /></label>
          <label>Contraseña: <input type="password" value={authPassword} autoComplete={showAuth === 'register' ? 'new-password' : 'current-password'} onChange={(e) => onAuthPassword(e.target.value)} placeholder="Mínimo 8 caracteres" /></label>
          <button type="submit" disabled={authBusy}>{authBusy ? '…' : showAuth === 'register' ? 'Crear mi cuenta' : 'Entrar'}</button>
          <button type="button" onClick={onClose}>Cancelar</button>
        </div>
      </form>
      {authError && <p className="error">{authError}</p>}
      {showAuth === 'login' && (
        <div>
          <div className="row">
            <button type="button" disabled={!webauthnAvailable || webauthnBusy || authBusy} onClick={onWebauthnLogin}>
              {webauthnBusy ? '…' : 'Entrar con huella / rostro'}
            </button>
          </div>
          {!webauthnAvailable && (
            <p className="muted">Tu navegador o dispositivo no tiene huella ni rostro disponible para entrar sin contraseña: usa tu email y contraseña.</p>
          )}
          {webauthnError && <p className="error">{webauthnError}</p>}
          <p className="muted">La huella solo funciona si ya la registraste en este dispositivo (con sesión iniciada, en «Mi cuenta»).</p>
        </div>
      )}
      <p className="muted">
        {showAuth === 'login' ? (
          <>¿No tienes cuenta? <button onClick={() => onSwitchMode('register')}>Crear cuenta</button></>
        ) : (
          <>¿Ya tienes cuenta? <button onClick={() => onSwitchMode('login')}>Entrar</button></>
        )}
      </p>
      <p className="muted">¿Olvidaste tu contraseña? Pídele al admin que la resetee.</p>
    </section>
  );
}
