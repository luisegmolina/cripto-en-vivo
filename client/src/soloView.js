// soloView.js — v18: detección de la vista compacta "solo §2" (/decision).
// Pura (sin DOM ni red): se puede probar en Node y reutilizar en App.jsx.
// La vista compacta muestra SOLO el apartado 2 (Decisión y Apuesta
// Recomendada) con letras grandes, para consultarla en el celular
// mientras se apuesta en Kalshi. Se activa por ruta /decision o por
// ?vista=decision. El resto de la app no cambia.
export const DECISION_SOLO_PATH = '/decision';
export const DECISION_SOLO_MANIFEST = '/decision.webmanifest';

export function isDecisionSoloView(pathname = '', search = '') {
  const p = String(pathname || '').replace(/\/+$/, '') || '/';
  if (p === DECISION_SOLO_PATH) return true;
  try {
    const q = new URLSearchParams(String(search || ''));
    if (q.get('vista') === 'decision') return true;
  } catch {
    // URLSearchParams no disponible o search inválido: no es vista solo.
  }
  return false;
}
