// v12 — Panel de administración (solo role === 'admin').
// Recibe {token, onBack}. El token solo se usa para recargar cuando cambia
// de sesión; las llamadas usan apiAuth, que lee el token de localStorage.
// La contraseña de un usuario NUNCA se muestra: el reseteo solo pide una
// contraseña nueva (>= 8 caracteres) y confirma en pantalla que se cambió.
import React, { useEffect, useState } from 'react';
import { apiAuth } from './auth.js';

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('es-US');
}

export default function AdminPanel({ token, onBack }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [togglingId, setTogglingId] = useState(null);
  // Reseteo de contraseña: un usuario seleccionado + contraseña nueva.
  const [resetUserId, setResetUserId] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetMsg, setResetMsg] = useState('');
  const [resetBusy, setResetBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError('');
    setForbidden(false);
    try {
      const [s, u] = await Promise.all([
        apiAuth('/api/admin/stats'),
        apiAuth('/api/admin/users'),
      ]);
      setStats(s);
      setUsers(Array.isArray(u.users) ? u.users : []);
    } catch (e) {
      if (e.status === 403) setForbidden(true);
      else setError(e.message || 'No se pudieron cargar los usuarios.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleActive(u) {
    setTogglingId(u.id);
    setError('');
    try {
      const data = await apiAuth(`/api/admin/users/${u.id}/active`, {
        method: 'PATCH',
        body: { active: !u.active },
      });
      const updated = data.user || { ...u, active: !u.active };
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, ...updated } : x)));
    } catch (e) {
      setError(e.message || 'No se pudo cambiar el estado del usuario.');
    } finally {
      setTogglingId(null);
    }
  }

  async function doResetPassword(e) {
    e.preventDefault();
    setResetMsg('');
    setError('');
    const target = users.find((u) => String(u.id) === String(resetUserId));
    if (!target) { setResetMsg('Elige un usuario de la lista.'); return; }
    if (!newPassword || newPassword.length < 8) {
      setResetMsg('La contraseña nueva debe tener al menos 8 caracteres.');
      return;
    }
    setResetBusy(true);
    try {
      await apiAuth(`/api/admin/users/${target.id}/reset-password`, {
        method: 'POST',
        body: { newPassword },
      });
      // La contraseña nueva no se muestra en ningún sitio tras enviarla:
      // solo queda la confirmación de que el cambio se aplicó.
      setNewPassword('');
      setResetUserId('');
      setResetMsg(`✅ Contraseña de ${target.email} reseteada. Pásale la contraseña nueva por un canal seguro; aquí no queda guardada.`);
    } catch (err) {
      setResetMsg('');
      setError(err.message || 'No se pudo resetear la contraseña.');
    } finally {
      setResetBusy(false);
    }
  }

  if (forbidden) {
    return (
      <section className="card">
        <h2>🛡️ Administración</h2>
        <p className="error">No tienes permiso de administrador.</p>
        <div className="row"><button onClick={onBack}>← Volver a la app</button></div>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="row">
        <h2>🛡️ Administración de usuarios</h2>
        <button onClick={onBack}>← Volver a la app</button>
        <button onClick={load} disabled={loading}>Actualizar</button>
      </div>
      <p className="muted">Solo el administrador ve esta vista. Desde aquí se activan/desactivan cuentas y se resetean contraseñas. Las contraseñas nunca se muestran.</p>
      {loading && <p className="muted">Cargando usuarios…</p>}
      {error && <p className="error">{error}</p>}
      {stats && (
        <div className="stats">
          <div><span>Usuarios totales</span><b>{stats.totalUsers ?? '—'}</b></div>
          <div><span>Usuarios activos</span><b>{stats.activeUsers ?? '—'}</b></div>
          <div><span>Con Kalshi conectado</span><b>{stats.kalshiConnected ?? '—'}</b></div>
        </div>
      )}
      {!loading && !error && users.length === 0 && (
        <p className="muted">No hay usuarios registrados todavía.</p>
      )}
      {users.length > 0 && (
        <table className="league-table">
          <thead>
            <tr><th>Email</th><th>Nombre</th><th>Rol</th><th>Activo</th><th>Kalshi</th><th>Última sync Kalshi</th><th>Creado</th><th>Acción</th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.name || '—'}</td>
                <td>{u.role || 'user'}</td>
                <td>{u.active ? '✅ Sí' : '❌ No'}</td>
                <td>{u.kalshiConnected ? '✅ Sí' : '— No'}</td>
                <td>{fmtDate(u.kalshiLastSyncAt)}</td>
                <td>{fmtDate(u.createdAt)}</td>
                <td>
                  <button disabled={togglingId === u.id} onClick={() => toggleActive(u)}>
                    {togglingId === u.id ? '…' : u.active ? 'Desactivar' : 'Activar'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Resetear la contraseña de un usuario</h3>
      <form onSubmit={doResetPassword}>
        <div className="row">
          <label>Usuario: <select value={resetUserId} onChange={(e) => setResetUserId(e.target.value)}>
            <option value="">— Elige un usuario —</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.email}{u.name ? ` (${u.name})` : ''}</option>
            ))}
          </select></label>
          <label>Nueva contraseña (mín. 8 caracteres): <input type="password" value={newPassword} autoComplete="new-password" onChange={(e) => setNewPassword(e.target.value)} placeholder="Mínimo 8 caracteres" /></label>
          <button type="submit" disabled={resetBusy}>{resetBusy ? 'Reseteando…' : 'Resetear contraseña'}</button>
        </div>
      </form>
      <p className="muted">La contraseña nueva se envía una sola vez al servidor y no se guarda ni se muestra en esta pantalla. Pásasela al usuario por un canal seguro.</p>
      {resetMsg && <p className="muted">{resetMsg}</p>}
    </section>
  );
}
