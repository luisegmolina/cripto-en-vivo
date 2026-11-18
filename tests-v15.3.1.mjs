// tests-v15.3.1.mjs — Regresión de la pantalla en blanco de v15.3.
//
// La v15.3 partió App.jsx en componentes y la limpieza borró por error
// las declaraciones de estado `portfolio` y `priceAlerts`, pero dejó
// 6+ usos (priceAlertsRef, efectos de guardado/sincronización,
// pullOrPushServerData, el efecto de alertas). El primer render rompía
// con "ReferenceError: priceAlerts is not defined" y #root quedaba
// vacío: la web no cargaba. El build de Vite NO detecta variables no
// declaradas (misma clase de fallo que v13.1 con prevVerdictKey), así
// que este test lo comprueba en la fuente, y la verificación en
// navegador real (Chromium headless, bundle servido) confirmó el
// arreglo: #root con las 5 secciones y sin pageerrors de la app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appSrc = fs.readFileSync(new URL('./client/src/App.jsx', import.meta.url), 'utf8');

test('v15.3.1: el estado portfolio existe (lo usa la sincronización v12)', () => {
  assert.match(appSrc, /const \[portfolio, setPortfolio\] = useState\(\(\) => loadLS\('cev_portfolio_v1', \{ cash: START_CASH, holdings: \{\}, trades: \[\] \}\)\);/);
});

test('v15.3.1: el estado priceAlerts existe (lo usa priceAlertsRef y los efectos)', () => {
  assert.match(appSrc, /const \[priceAlerts, setPriceAlerts\] = useState\(\(\) => dedupePriceAlerts\(loadLS\('cev_price_alerts_v1', \[\]\)\)\);/);
});

test('v15.3.1: priceAlertsRef se declara DESPUÉS de priceAlerts', () => {
  const decl = appSrc.indexOf('const [priceAlerts, setPriceAlerts]');
  const ref = appSrc.indexOf('const priceAlertsRef = useRef(priceAlerts)');
  assert.ok(decl > 0 && ref > decl, 'priceAlertsRef debe usar priceAlerts ya declarado');
});

test('v15.3.1: la gráfica usa locale explícito (evita "Invalid language tag")', () => {
  assert.match(appSrc, /localization: \{ locale: 'es-US' \}/);
});

test('v15.3.1: las 5 secciones siguen en el render (orden v15.3)', () => {
  for (const section of ['<MyPosition', '<Decision', '<LiveReference', '<Signals', '<ChartSection', '<AccountBox']) {
    assert.ok(appSrc.includes(section), `falta ${section} en el render de App.jsx`);
  }
  assert.ok(appSrc.indexOf('<MyPosition') < appSrc.indexOf('<Decision'));
  assert.ok(appSrc.indexOf('<Decision') < appSrc.indexOf('<LiveReference'));
  assert.ok(appSrc.indexOf('<LiveReference') < appSrc.indexOf('<Signals'));
  assert.ok(appSrc.indexOf('<Signals') < appSrc.indexOf('<ChartSection'));
});
