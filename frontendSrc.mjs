// frontendSrc.mjs — v15.3: la vista vive en App.jsx + client/src/components/.
// Las suites viejas leían solo App.jsx; ahora `frontendSrc()` devuelve la
// fuente combinada en orden de pantalla, y `mainReturnSrc()` el return
// principal (rebanada de App.jsx + componentes en orden de pantalla).
// Uso en las suites: import { frontendSrc, mainReturnSrc } from './frontendSrc.mjs';
import { readFileSync } from 'node:fs';

// Orden de pantalla v15.3: lo urgente primero (posición, decisión),
// después el porqué (referencia, señales) y al final la gráfica.
export const COMPONENT_ORDER = ['MyPosition', 'Decision', 'LiveReference', 'Signals', 'ChartSection', 'AccountBox'];

export function componentSrc(name) {
  return readFileSync(`./client/src/components/${name}.jsx`, 'utf8');
}

export function frontendSrc() {
  return readFileSync('./client/src/App.jsx', 'utf8') + '\n' + [...COMPONENT_ORDER, 'AuthModal'].map(componentSrc).join('\n');
}

export function mainReturnSrc() {
  const app = readFileSync('./client/src/App.jsx', 'utf8');
  const slice = app.slice(app.lastIndexOf('  return (\n    <div className="app">'));
  return slice + '\n' + COMPONENT_ORDER.map(componentSrc).join('\n');
}
