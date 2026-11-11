// Misiones diarias y XP — todo local (localStorage), sin cuentas.
// Las misiones se reinician cada día; el XP es acumulativo y sube de
// nivel cada 100 XP. Nada de esto es dinero real ni afecta a la cartera.

export const MISSIONS = [
  { id: 'primera_operacion', name: 'Primera operación del día', desc: 'Compra o vende con dinero virtual.', xp: 20, type: 'trade' },
  { id: 'poner_alerta', name: 'Pon una alerta', desc: 'Crea una alerta de precio para cualquier activo.', xp: 15, type: 'alert' },
  { id: 'explorar_3', name: 'Explora 3 activos', desc: 'Mira el gráfico de 3 activos distintos hoy.', xp: 15, type: 'explore' },
  { id: 'leer_senal', name: 'Lee la señal de hoy', desc: 'Revisa el análisis del activo y márcalo como leído.', xp: 10, type: 'manual' },
  { id: 'en_verde', name: 'Cartera en verde', desc: 'Tu cartera virtual está por encima de 10.000.', xp: 25, type: 'green' },
];

export const XP_PER_LEVEL = 100;
export function levelForXp(xp) { return Math.floor((xp || 0) / XP_PER_LEVEL) + 1; }
export function xpIntoLevel(xp) { return (xp || 0) % XP_PER_LEVEL; }
