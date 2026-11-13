// tests-v13.1.mjs — Regresión del ReferenceError de v13 en producción:
// "ReferenceError: prevVerdictKey is not defined" (bundle index-CX6imwh_.js).
// Causa: en v13 la refactorización a pestañas borró la declaración de
// prevVerdictKey y lastSignalAlertRef, pero el efecto de alerta de cambio
// de veredicto seguía usándolas. En un módulo ES (strict mode) eso
// rompe el render entero con un error no capturado. El build de Vite
// NO lo detecta (no es error de sintaxis), así que estas pruebas lo
// comprueban de forma explícita.
// Uso: node tests-v13.1.mjs  (después de npm --prefix client run build)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { shouldSignalAlert, SIGNAL_ALERT_MIN_MS } from './client/src/alerts.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

// 1. Las dos refs están declaradas en App.jsx (en el ámbito del componente).
const app = readFileSync('./client/src/App.jsx', 'utf8');
check('prevVerdictKey declarada con useRef(null)',
  /const prevVerdictKey\s*=\s*useRef\(null\)/.test(app));
check('lastSignalAlertRef declarada con useRef(null)',
  /const lastSignalAlertRef\s*=\s*useRef\(null\)/.test(app));
check('las declaraciones están ANTES del efecto que las usa',
  app.indexOf('const prevVerdictKey') < app.indexOf('const prev = prevVerdictKey.current') &&
  app.indexOf('const lastSignalAlertRef') < app.indexOf('shouldSignalAlert(lastSignalAlertRef.current'));
// 2. Ninguna otra variable .current sin declarar en client/src (escaneo
//    igual que el que encontró el bug: todo X.current debe tener
//    "const X =" en el mismo archivo, o ser parámetro de función).
{
  const files = readdirSync('./client/src').filter((f) => /\.(jsx?|js)$/.test(f));
  const missing = [];
  for (const f of files) {
    const src = readFileSync(`./client/src/${f}`, 'utf8');
    const used = [...new Set([...src.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.current/g)].map((m) => m[1]))];
    for (const v of used) {
      const declared = new RegExp(`(const|let|var)\\s+${v}\\s*=`).test(src);
      const param = new RegExp(`\\(\\s*${v}\\b|\\b${v}\\s*=>|function\\s+\\w+\\s*\\(\\s*${v}\\b`).test(src);
      if (!declared && !param) missing.push(`${f}:${v}`);
    }
  }
  check('ningún X.current sin declarar en client/src', missing.length === 0, missing.join(', '));
}
// 3. El bundle compilado NO contiene los nombres literales (una variable
//    libre sin declarar sobrevive a la minificación; una declarada se
//    renombra). Si aparecen, el bug sigue ahí.
{
  const assets = existsSync('./client/dist/assets') ? readdirSync('./client/dist/assets').filter((f) => f.endsWith('.js')) : [];
  check('hay bundle compilado para inspeccionar', assets.length > 0);
  const leaked = [];
  for (const a of assets) {
    const js = readFileSync(`./client/dist/assets/${a}`, 'utf8');
    if (js.includes('prevVerdictKey')) leaked.push(`${a}:prevVerdictKey`);
    if (js.includes('lastSignalAlertRef')) leaked.push(`${a}:lastSignalAlertRef`);
  }
  check('el bundle no contiene prevVerdictKey/lastSignalAlertRef libres', leaked.length === 0, leaked.join(', '));
}
// 4. Simulación del efecto de alerta de cambio de veredicto (misma
//    lógica que App.jsx:719-750): varios cambios en el mismo minuto
//    no lanzan ReferenceError y solo queda UNA alerta (la última).
{
  // Réplica fiel del efecto, con las refs ya declaradas.
  const prevVerdictKey = { current: null };
  const lastSignalAlertRef = { current: null };
  const alerts = [];
  const runEffect = (verdictKeyNow, nowMs) => {
    const prev = prevVerdictKey.current;
    prevVerdictKey.current = verdictKeyNow;
    if (!prev) return;
    if (prev === verdictKeyNow) return;
    const msg = `Señal: ahora ${verdictKeyNow} — ${nowMs}`;
    const chk = shouldSignalAlert(lastSignalAlertRef.current, nowMs);
    lastSignalAlertRef.current = { at: nowMs, key: verdictKeyNow };
    if (!chk.fire && chk.replace) {
      const idx = alerts.findIndex((x) => x.includes('Señal'));
      if (idx < 0) alerts.unshift(msg);
      else alerts[idx] = msg;
      return;
    }
    alerts.unshift(msg);
  };
  const t0 = 1_000_000;
  runEffect('wait', t0);            // primera carga: no alerta
  check('primera carga no genera alerta', alerts.length === 0);
  runEffect('sell', t0 + 1000);     // cambio 1: dispara
  check('primer cambio dispara 1 alerta', alerts.length === 1 && alerts[0].includes('sell'));
  runEffect('buy', t0 + 2000);      // cambio 2, mismo minuto: reemplaza, no añade
  check('segundo cambio en <60 s REEMPLAZA, no añade', alerts.length === 1 && alerts[0].includes('buy'));
  runEffect('wait', t0 + 3000);     // cambio 3, mismo minuto: sigue siendo 1
  check('tercer cambio en <60 s sigue siendo 1 alerta (la última)', alerts.length === 1 && alerts[0].includes('wait'));
  runEffect('wait', t0 + 3000);     // mismo veredicto que el actual: nada
  check('mismo veredicto no genera alerta', alerts.length === 1 && alerts[0].includes('wait'));
  runEffect('sell', t0 + SIGNAL_ALERT_MIN_MS + 5000); // pasado el minuto: dispara de nuevo
  check('pasado 60 s vuelve a disparar (2 alertas)', alerts.length === 2 && alerts[0].includes('sell'));
  check('la deduplicación por minuto sigue activa (60 000 ms)', SIGNAL_ALERT_MIN_MS === 60000);
}

console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
