// v12 — Autenticación de usuarios (JWT) + sincronización de cartera/alertas.
// Solo habla con el propio servidor (/api, mismo origen en producción y
// proxy a :3001 en desarrollo). El token vive en localStorage; la clave
// privada de Kalshi NUNCA se guarda aquí ni en ningún localStorage.

// Clave del token en localStorage (contrato v12).
export const TOKEN_KEY = 'cev_token_v1';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; }
}

function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* almacenamiento no disponible: la sesión solo vive en memoria */ }
}

export function clearToken() { setToken(null); }

// Llamada autenticada al contrato v12. Añade `Authorization: Bearer <token>`
// y lanza un Error con el mensaje del servidor (err.status = código HTTP).
export async function apiAuth(path, { method = 'GET', body = null } = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body == null ? null : JSON.stringify(body),
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

// POST /api/auth/register {email, password, name} -> {token, user}
// 400 si el email ya existe o la contraseña tiene menos de 8 caracteres.
export async function register({ email, password, name }) {
  const data = await apiAuth('/api/auth/register', { method: 'POST', body: { email, password, name } });
  if (data.token) setToken(data.token);
  return data;
}

// POST /api/auth/login {email, password} -> {token, user}
export async function login({ email, password }) {
  const data = await apiAuth('/api/auth/login', { method: 'POST', body: { email, password } });
  if (data.token) setToken(data.token);
  return data;
}

// GET /api/auth/me -> {user:{id, email, name, role, kalshiConnected}}
export async function me() {
  const data = await apiAuth('/api/auth/me');
  return data.user;
}

// POST /api/auth/logout -> {ok:true}. Aunque el servidor falle, la
// sesión local se borra siempre: salir nunca puede quedarse atascado.
export async function logout() {
  try { await apiAuth('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* salir local igualmente */ }
  clearToken();
}
