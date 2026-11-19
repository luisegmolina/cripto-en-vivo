// siteGate.js — v16.5: PIN de acceso al sitio (puerta antes de la web).
// Contrato del servidor (implementado en paralelo en server/):
//   GET  /api/site-gate/status         pública -> {locked: true|false}
//        (locked = la puerta está cerrada PARA ESTE NAVEGADOR: hay PIN
//        puesto y este navegador no tiene la cookie válida).
//   POST /api/site-gate/verify {pin}  -> {ok:true} + cookie HttpOnly
//        cev_gate_v1 (el navegador la guarda solo; aquí no se lee).
//   POST /api/site-gate/recover {code} -> {ok:true} (quita el PIN).
// Sin cookie válida y con PIN puesto, TODAS las rutas API devuelven
// 403 JSON {error:'site_gate'}.
// El PIN solo viaja en el body del POST: nunca se guarda en
// localStorage ni se escribe en logs. La cookie la maneja el navegador.

// Aviso global: cuando cualquier llamada API devuelve 403 site_gate
// (p. ej. el PIN se puso en otro dispositivo mientras esta pestaña
// estaba abierta), App.jsx muestra la pantalla SiteGate. api() y
// apiAuth() llaman a emitSiteGateLocked() al ver ese 403.
const listeners = new Set();

export function onSiteGateLocked(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function emitSiteGateLocked() {
  listeners.forEach((fn) => { try { fn(); } catch {} });
}

export function isSiteGateError(err) {
  return Boolean(err && err.status === 403 && /site_gate/.test(err.message || ''));
}

async function postJson(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('No se pudo contactar con el servidor. Revisa que esté corriendo.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.message || `Error ${res.status} en ${path}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// GET /api/site-gate/status -> {locked: true|false}
export async function siteGateStatus() {
  let res;
  try {
    res = await fetch('/api/site-gate/status');
  } catch {
    throw new Error('No se pudo contactar con el servidor. Revisa que esté corriendo.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status} en /api/site-gate/status`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// POST /api/site-gate/verify {pin} -> {ok:true}. PIN incorrecto -> 401.
export function siteGateVerify(pin) {
  return postJson('/api/site-gate/verify', { pin });
}

// POST /api/site-gate/recover {code} -> {ok:true} (quita el PIN).
export function siteGateRecover(code) {
  return postJson('/api/site-gate/recover', { code });
}
