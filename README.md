# Cripto en Vivo — React + Node

App web responsiva (también se puede empaquetar para Android) con precios
de criptomonedas en vivo, gráfico de velas y análisis de prueba educativa.

**Por qué hay un servidor:** la versión web pública estática falló en el
teléfono de Luis porque su navegador/red bloqueaba las llamadas directas a
Coinbase, Kraken y Binance US (`Failed to fetch` en las tres a la vez).
Aquí el **servidor Node (en tu laptop, puerto 3001) es el que llama a los
exchanges**, y el frontend (React) solo habla con ese servidor en
`localhost`. El navegador ya no toca los exchanges directamente.

## Qué incluye

- **10 criptoactivos:** BTC, ETH, SOL, XRP, ADA, DOGE, AVAX, LINK, LTC, DOT
- **Monedas:** USD, EUR, GBP
- **Precio en vivo cada 1 segundo** desde el servidor (destella verde/rojo)
- **Gráfico de velas con volumen** (lightweight-charts), intervalos
  1m, 5m, 15m, 1H, 6H, 1D
- **Análisis de prueba educativa:** señal *Posible subida / Posible bajada /
  Sin señal clara* con puntuación −100 a +100, con RSI(14), MACD(12,26,9),
  EMA 20/50, Bollinger y patrones de velas (martillo, estrella fugaz,
  envolvente alcista/bajista, doji) marcados en el gráfico.
  > ⚠️ Es solo una prueba educativa. Ningún indicador predice el precio.
  > NO es una recomendación de inversión.
- **Alertas en pantalla** cuando aparece una señal nueva, y notificación
  del navegador opcional (con permiso).
- **Modo Kalshi 15 min (v11):** interruptor arriba que pone el 15m como
  timeframe principal: ventana actual con cuenta atrás, señal SUBE /
  BAJA / ESPERAR para la ventana, y sección "¿Cobro o me quedo?" con
  posición virtual (entrada, dirección, cantidad). Dinero virtual,
  educativo, sin cuenta ni API de Kalshi; la probabilidad es estimada
  propia, no oficial.
- **Fuente visible:** la página muestra qué fuente está dando el precio
  (Coinbase → Kraken → Binance US → CoinGecko, en cadena con timeout de 5 s
  por fuente y caché de 1–2 s). Si una falla, pasa a la siguiente.
  El precio ya no depende de las estadísticas de Coinbase: si `stats`
  falla, el precio se muestra igual.
  **Markets (las 10 pestañas) es distinto:** la vía primaria es **una sola
  llamada batch a Kraken** para los 10 activos, luego los tickers de
  Coinbase en paralelo, y CoinGecko solo como ÚLTIMO recurso (su plan
  gratis tiene límite de 5–15 llamadas/min y devuelve 429 si se quema).
  Si una fuente devuelve 429, entra en pausa de 60 s y no se reintenta;
  el log solo avisa la primera vez, no cada 5 s. Caché de markets: 15 s;
  el cliente sondea las pestañas cada 10 s.

## Novedades v11: Modo Kalshi 15 minutos (12-nov-2026)

El amigo de Luis revisó la web y aclaró el objetivo real: apoyar las
predicciones en la app de Kalshi, donde se predice BTC y otros cada
15 minutos, y en ese tiempo hay que decidir si cobrar lo que va
ganando o salir. La v11 añade una capa encima de todo lo anterior
(nada de v7–v10 se quita):

1. **Modo Kalshi 15 min:** interruptor visible arriba ("Activar Modo
   Kalshi 15 min"). Al activarlo, el timeframe principal pasa a 15m;
   al apagarlo, vuelve a 1h. El veredicto general, la confluencia,
   el historial, el backtest, la liga, el screener y el resto siguen
   igual debajo.
2. **Cuenta atrás de la ventana:** la ventana actual de 15 minutos
   (empieza a :00, :15, :30 y :45), cuánto falta para que cierre
   (MM:SS), barra de % transcurrido, precio de referencia al inicio
   de la ventana (apertura de la vela 15m) y cuánto se ha movido el
   precio dentro de la ventana.
3. **Señal para la ventana:** veredicto gigante **SUBE / BAJA /
   ESPERAR** para los próximos 15 minutos, con puntuación, fuerza y
   confianza, el porqué en simple (RSI, MACD, EMA, momentum) y el
   backtest en 15m ("acertó X de Y" en las ventanas pasadas).
4. **¿Cobro o me quedo?:** el usuario pone su posición virtual
   (precio de entrada, dirección SUBE/BAJA y cantidad virtual, solo
   local) y la app dice en claro: **COBRA AHORA** (vas ganando y la
   señal se debilitó o se dio la vuelta), **AGUANTA** (vas ganando y
   la señal sigue a tu favor), **SAL ANTES DE PERDER MÁS** (vas
   perdiendo y la señal va en contra), **AGUANTA CON CUIDADO**
   (vas perdiendo pero la señal sigue a tu favor) o **ESPERA** (sin
   señal clara). Muestra la ganancia/pérdida virtual en $ y % y un
   precio sugerido para cobrar/salir (precio actual si es cobrar o
   salir; objetivo a 1 ATR 15m si es aguantar). También guarda la
   puntuación de la señal al entrar, para detectar si se debilitó.
5. **Probabilidad estimada propia:** la app muestra una probabilidad
   estimada a partir de la señal (puntuación + confluencia). **NO es
   la probabilidad oficial de Kalshi** y va etiquetada como tal en
   la app. No hay integración con la API real de Kalshi, no hay
   cuenta de Kalshi conectada, no hay dinero real. (Esto era así en
   v11: desde v12 sí hay conexión solo lectura a la cuenta de Kalshi
   y desde v13.2 precios oficiales del contrato en centavos; ver
   "Novedades v12" y "Novedades v13.4".)
6. **Últimas ventanas de 15 min:** tabla con las últimas 5 ventanas
   y si la señal acertó o falló en cada una.
> ⚠️ Prueba educativa con dinero VIRTUAL. Nada de esto es una
> recomendación de inversión ni de apuesta, y no promete ganancias.
> En 15 minutos el precio se mueve mucho y la señal falla a menudo
> (backtest BTC 15m medido el 12-nov: 7 de 12, 58%).
Pruebas en `tests-v11.mjs`: 34 de 34 pasaron (ventana, cuenta atrás,
veredicto, decisión cobrar/aguantar/salir y servidor local con velas
reales de 15m).

## Novedades v10: correcciones de las capturas del 10-nov 20:56 (11-nov-2026)

Luis mandó capturas de la v9 en vivo y salieron 5 fallos. Todos corregidos:

1. **Liga con código roto:** los rivales salían como `CriptoManía <span className="muted">(demo)</span>` porque en `App.jsx` el span estaba dentro de un string, no como JSX. Ahora es JSX real y se ve "CriptoManía (demo)" con estilo, sin código visible.
2. **Screener vacío al entrar:** antes solo se calculaba al pulsar "Actualizar screener". Ahora se calcula SOLO al cargar la página (en cuanto llegan las 10 pestañas); el botón queda solo para refrescar.
3. **Alertas viejas duplicadas:** las 4 entradas de $73.53 (7:56–8:00 p.m.) eran de localStorage anterior a v9. Nueva migración al cargar (`dedupePriceAlerts` en `client/src/alerts.js`): mismo activo+precio+dirección -> solo queda la más reciente, marcada como sonada. Las 4 viejas quedan en 2 (1 por encima + 1 por debajo).
4. **Backtest e historial seguían en 1m en las capturas:** el intervalo al entrar ya era 1h, pero si el usuario tocaba 1m en el gráfico, el historial y el backtest lo seguían. Ahora SIEMPRE usan las velas de 1h (las de la confluencia, que ya se traen cada 20 s), y al entrar el intervalo es 1h en todas partes; el aviso "1m es ruido" solo sale junto al gráfico si se cambia a 1m a mano.
5. **Panel PRO "No disponible":** en Render la IP compartida está casi siempre en 429 en CoinGecko. `/api/global` ahora tiene respaldo CoinPaprika (gratis, sin clave): si CoinGecko falla o está en pausa, devuelve capitalización total y dominio de BTC de CoinPaprika, marcados como aproximados. Si no hay ninguna fuente, la respuesta trae `retryInSeconds` y la app dice cuándo se reintentará.
6. Nada de v7/v8/v9 se quitó. Pruebas en `tests-v10.mjs`: 26 de 26 pasaron con datos reales del servidor local (backtest BTC 1h: 10 de 18, 56%).

## Novedades v9: correcciones del PDF del 10-nov (11-nov-2026)

Luis imprimió la app a PDF y salieron 8 fallos visibles. Todos corregidos:

1. **Veredicto ESPERAR ya no muestra entrada:** antes salían stop y take
   profit aunque el veredicto fuera ESPERAR. Ahora con ESPERAR solo se
   muestra "Sin entrada" y los niveles de activación (a 1 ATR del precio:
   si el precio los rompe con señal clara, ahí se activa el plan). La
   entrada, el stop y el objetivo solo aparecen con COMPRAR o VENDER.
   (También se corrigió que `tradePlan` se llamaba sin el veredicto.)
2. **Historial y backtest por defecto en 1h, no 1m:** el 1m es ruido
   (BTC 1m acertó 2 de 10 en la medición del 10-nov; backtest 37%).
   Ahora el intervalo por defecto es 1h (backtest BTC 1h: 10 de 18, 56%,
   medido el 11-nov) y si se cambia a 1m sale un aviso claro:
   "1m es ruido, no apto para decidir".
3. **Capitalización total REAL:** se eliminó el proxy precio × volumen
   24h (daba "$0.4 mil M", absurdo). Nuevo endpoint `/api/global`
   (CoinGecko, caché 5 min): capitalización total real y dominio de BTC
   real. Si CoinGecko falla o da 429, la app muestra "No disponible",
   nunca un número inventado.
4. **Alertas sin duplicados:** una alerta suena UNA vez al cruzar y
   luego entra en cooldown de 1 h para ese mismo precio objetivo
   (lógica pura en `client/src/alerts.js`, probada en Node). Además no
   se puede crear dos veces la misma alerta activa. En el PDF la misma
   alerta de $73.53 sonó 4 veces; eso ya no puede pasar.
5. **Estado del servidor para clientes:** ya no se muestra el JSON
   crudo ni el "CoinGecko: HTTP 429" a plena vista. Solo "Servidor OK"
   en verde y la fuente del precio. El debug queda detrás de un botón
   plegado "Detalles técnicos".
6. **Screener ordenado:** solo es oportunidad una señal CLARA
   (|score| ≥ 25, de compra o de venta), ordenada por fuerza de señal.
   Las débiles van abajo como "Sin oportunidad clara", sin número.
   Antes XRP con señal −19 aparecía como oportunidad #2.
7. **Impresión / PDF:** hoja `@media print` (una columna, fondo
   blanco, texto negro, sin ticker animado, sin gráficos de velas, sin
   secciones de liga/misiones/logros/compartir/perfil que se solapaban).
8. Nada de v7/v8 se quitó. Pruebas en `tests-v9.mjs`: 21 de 21 pasaron
   con datos reales del servidor local.

## Novedades v8: la señal de trading al frente (11-nov-2026)

El objetivo de la app es TRADING: que el usuario vea en 5 segundos si
compra o vende. Por eso la señal es ahora lo primero de la página,
antes del gráfico y antes de todo lo demás (liga, screener, mercado
PRO… que siguen intactos, solo más abajo).

Todo sigue siendo dinero VIRTUAL y prueba educativa. **Nada de esto es
una recomendación de inversión ni una garantía de ganancias.**

### 1. Veredicto gigante
Arriba del gráfico, imposible de pasar por alto: **COMPRAR** (verde) /
**VENDER** (rojo) / **ESPERAR** (gris), con puntuación −100 a +100,
fuerza (Débil/Moderada/Fuerte/Muy fuerte) y confianza en % (índice de
confluencia, NO una probabilidad de acierto).

### 2. Confluencia entre temporalidades
La señal se calcula en **1m, 5m, 15m y 1h** (velas de `/api/candles`) y
se muestra en una tabla: cada timeframe dice Comprar/Vender/Esperar.
La de 1h pesa más que la de 1m en el veredicto final. Si hay señales
claras de compra Y de venta a la vez, la app lo dice en grande:
**"SEÑALES EN CONFLICTO, esperar"**.

### 3. Por qué
Debajo del veredicto, las 3–4 razones que lo sostienen en lenguaje
simple, cada una con icono verde/rojo: "RSI 32, sobreventa", "MACD
cruzó al alza", "Precio por debajo de EMA 50", "Envolvente bajista"…

### 4. Plan de operación (sugerido, educativo)
Con el precio actual: entrada sugerida (el precio actual), stop loss
a 1 ATR y take profit a 2 ATR (ratio 1:2), calculados con la
volatilidad real de las últimas 14 velas. Si el veredicto es ESPERAR,
no hay entrada: se muestran los niveles y el plan dice que se activa
solo si el precio rompe un nivel con señal clara. Botón "Operar según
la señal (virtual)" que compra/vende con dinero virtual.

### 5. Historial de señales
Las últimas 10 señales claras del intervalo seleccionado, con hora,
precio, lo que pasó en la vela siguiente y si **acertó o falló**.
Ejemplo real medido el 11-nov: en BTC 1h acertó 6 de 10; en BTC 1m
solo 2 de 10 — las señales a corto plazo fallan mucho, y la app lo
muestra en vez de esconderlo.

### 6. Alerta cuando cambia la señal
Cuando el veredicto cambia de COMPRAR a VENDER o viceversa: alerta en
pantalla + notificación del navegador (si tiene permiso) y queda en el
historial de alertas y en `cev_signal_changes_v1` (local).

### 7. Orden de la página
Selector de activo/moneda → **veredicto + por qué + plan +
confluencia + historial** → gráfico → análisis detallado → backtest →
screener → cartera virtual → liga → misiones → compartir → alertas →
logros → perfil, panel PRO, ánimo y estado del servidor (al final).

## Novedades v7: Panel PRO, liga semanal, misiones, PWA y más (11-nov-2026)

App pública en **https://cripto-en-vivo.onrender.com** (Render, plan gratis;
se duerme tras ~15 min sin visitas, la primera carga tarda ~50 s).

Todo es dinero VIRTUAL y prueba educativa. Sin registro obligatorio al
entrar: solo cuando el usuario quiere guardar cartera/liga/alertas se le
ofrece un apodo local (sin contraseña, sin servidor).

### 1. Panel de mercado PRO (arriba)
- **Dominio de BTC (aprox.):** parte de BTC en un proxy de capitalización
  (precio × volumen 24h de las 10 criptos). Etiquetado "aprox.".
- **Capitalización total (aprox.):** suma del mismo proxy.
- **Índice de miedo y codicia:** ESTIMADO PROPIO con amplitud, impulso
  medio y RSI de las 10 criptos. NO es el índice oficial de alternative.me.
- **Mapa de calor** de las 10 criptos (verde/rojo por cambio 24h; toca una
  celda para ver su gráfico) y "qué está caliente hoy".

### 2. Gráfico PRO
- Toggles para prender/apagar **EMA 20/50** (líneas naranja/azul),
  **Bollinger** (3 líneas grises) y **RSI** (panel inferior con líneas
  30/70).
- **Comparar contra BTC:** línea morada con el rendimiento relativo del
  activo frente a BTC (índice 100 = igual que al inicio del gráfico).
- **Pantalla completa** (botón ⛶) y **latencia del último fetch en ms**
  visible en el encabezado y en "Estado del servidor".

### 3. Backtest de señales
- Para el activo e intervalo seleccionados, recorre las velas históricas
  con ventanas deslizantes, calcula la señal con los mismos indicadores
  del análisis en vivo y comprueba si la vela siguiente fue en la
  dirección sugerida. Muestra **"acertó X de Y" con porcentaje**,
  desglosado en subidas y bajadas. El pasado no predice el futuro.

### 4. Liga semanal de trading virtual
- Todos empiezan el lunes con $10.000 virtuales; la liga se reinicia
  cada lunes (clave por semana ISO en localStorage).
- Tabla de posiciones con **rivales simulados locales** (nombres fijos,
  rendimiento determinista por semana, etiquetados DEMO): no son personas
  reales ni cuentas. Ganador del domingo con insignia 🥇.

### 5. Misiones diarias y XP
- Primera operación del día, poner una alerta, acertar/leer una señal,
  explorar 3 activos, cartera en verde. XP acumulativo, nivel cada 100 XP,
  progreso visible. Persiste en localStorage con la fecha del día.

### 6. Alertas push / PWA
- La app es instalable: `manifest.webmanifest` + service worker
  (`client/public/sw.js`) + icono SVG. Las alertas de precio usan el
  service worker para notificar aunque la pestaña esté en segundo plano.
- **Honestidad: NO hay push real.** No hay VAPID ni backend de push
  (Render gratis no lo da): el service worker solo muestra
  notificaciones locales que la propia app le pide. Si la app está
  cerrada del todo, la alerta no llega hasta volver a abrirla.

### 7. Tarjeta para compartir por WhatsApp
- Botón "Compartir texto" (navigator.share si existe, si no copia al
  portapapeles), enlace directo a WhatsApp (`wa.me/?text=…`) y
  **"Descargar tarjeta como imagen"** (PNG 1080×1080 dibujada con canvas)
  con tu P&L semanal virtual, puesto en la liga y mejor operación, más
  el enlace a la app.

### 8. Liga privada con código
- Crea una liga con nombre y código alfanumérico de 6 caracteres, o únete
  con un código. Guardada en localStorage. Es local/demo: el código solo
  existe en este navegador; no hay cuentas ni servidor de ligas.

### 9. Screener / Oportunidades del día
- Botón "Actualizar screener": trae velas de 1h de las 10 criptos,
  calcula RSI y señal de cada una y las ordena por puntuación propia
  (RSI + cambio 24h + volumen + señal), con una frase de explicación
  por cada una. Toca una fila para ver su gráfico.

### 10. Registro solo cuando hace falta
- Sin login al entrar. Solo un campo de **apodo local** en "Tu perfil
  local" (sin contraseña, sin servidor), que se usa en la liga semanal
  y en la tarjeta para compartir. Nada se envía a ningún servidor.

## Novedades v15.5: movimientos del mercado en tiempo real + plan exacto de apuesta SÍ/NO (18-nov-2026)

1. **Desbloqueo del tiempo real en 15m y multitemporal (`App.jsx`):** `candles15m` ahora prioriza `candles` (que se mueve cada 1 segundo con cada tick de precio vía `updateLastCandle`) y `last15mKey` usa `candlesSignature(candles15m)` (con `open/high/low/close`). Además `setMtfCandles` usa `candlesSignature` en `1m`, `5m`, `15m` y `1h` para no congelar las velas dentro de la ventana.
2. **Motor técnico calibrado sin sesgo inverso (`analysis.js` + `verdict.js`):** corregida la fórmula del RSI en zona media (30–70) que antes restaba puntos cuando el precio subía; añadida tendencia corta reactiva (`EMA 9 vs EMA 20`), aceleración del histograma `MACD` y velocidad de las últimas 3 velas (`momentumPct`).
3. **Detector de movimientos del mercado en vivo (`detectMarketMovement` en `kalshi.js`):** mide al segundo el índice de impulso (-100 a +100), la diferencia contra el Precio Objetivo de Kalshi en `$`, `%` y múltiplos de `ATR 15m`, la variación de la vela 15m actual y la alineación de `1m`, `5m`, `15m` y `1h`.
4. **Plan exacto de apuesta en Kalshi (`buildBetPlan` en `kalshi.js` + `Decision.jsx`):** muestra en §2 qué contrato exacto comprar (`Contrato SÍ (SUBE)` o `Contrato NO (BAJA)`), su precio actual en centavos, la ganancia potencial y ROI %, la ventaja estimada (`Edge` y Valor Esperado `EV` por contrato), la inclinación táctica en vivo cuando la puntuación 15m aún está entre −24 y +24, y las reglas claras de entrada, toma de ganancias (`≥85¢`) y corte de pérdida (`≤15¢`).

**Matices de la verificación (Muse, 18-nov-2026):** (a) el congelamiento no afectaba a la puntuación 15m en sí — esa ya se actualizaba cada segundo vía `mtfAnalysis['15m']` sobre `candles` en vivo —, sí congelaba los plazos 1m/5m/1h, el ATR, el backtest y el historial reciente; la v15.5 los desbloquea a todos. (b) Backtest honesto con velas reales de Coinbase (320 ventanas, sin lookahead): la señal nueva da más señales claras (210 vs 96) con el mismo acierto, 46% en ambos casos — no mejora la precisión, solo la frecuencia; sigue sin distinguirse de una moneda. (c) La ventaja (Edge/EV) se calcula con la probabilidad estimada por la puntuación, no con el acierto medido (46%): la caja de §2 lo advierte en pantalla. (d) Con señal 15m neutra la app ahora puede recomendar una apuesta táctica por impulso en vez de ESPERAR (cambio deliberado respecto a v15.4).

## Novedades v15.4: la recomendación sin posición ahora sí dice a qué apostar (18-nov-2026)

Luis repitió el pedido porque la caja de v15.3 casi siempre decía ESPERAR. Reproducido con datos en vivo (velas reales de Coinbase): la señal 15m estaba clara en SUBE (puntuación 29) y aun así la caja decía ESPERAR.

**Causa (el veto):** `marketRecommendation` vetaba el lado cuando la señal era débil (acierto <50% en las últimas 5 ventanas con señal clara) o conflictiva (los demás plazos en contra) y forzaba ESPERAR. Como el backtest 15m ronda el 43-45%, el veto estaba activo casi siempre: en el momento de la comprobación, las últimas 5 ventanas con señal habían acertado solo 1 de 5 (20%), así que una señal SUBE clara se convertía en ESPERAR.

**Corrección:** la señal clara MANDA. Sin posición abierta, §2 muestra siempre, primero y en grande, **"A qué apostar en esta ventana: Apuesta a la SUBIDA"** o **"Apuesta a la BAJADA"**, con fuerza y razones. Lo débil y lo conflictivo ya no vetan: se muestran como AVISOS junto al lado (ej.: "⚠️ Señal débil: en las últimas 5 ventanas con señal clara solo acertó 1 de 5"). Solo se dice ESPERAR cuando la señal misma no es clara (puntuación entre −25 y +25). Con posición abierta la caja no aparece: manda SAL/AGUANTA/INVIERTE MÁS. Sigue siendo sugerencia educativa, nunca orden ni garantía; el aviso del backtest 15m (45%, no se distingue de una moneda) sigue en §4 y en la caja.

**Verificación:** `tests-v15.4.mjs` nuevo (23 tests, incluido el caso real SUBE 29 + 1/5); `tests-v15.3.mjs` actualizado a la regla v15.4 (los checks del veto viejo cambiaban por diseño); suites viejas sin regresiones (ver VERSION.txt).

## Novedades v15.3.1: corrección de la pantalla en blanco de v15.3 (18-nov-2026, URGENTE)

Luis reportó a las 23:53 CST que la web se quedaba en blanco y no cargaba. Reproducido en navegador real (Chromium headless, bundle de producción servido): `#root` vacío y consola `ReferenceError: priceAlerts is not defined`.

**Causa:** la limpieza de v15.3 borró por error las declaraciones de estado `portfolio` y `priceAlerts` de `App.jsx`, pero dejó 6+ usos: `priceAlertsRef = useRef(priceAlerts)` (línea 262, se ejecuta en el primer render y rompe toda la app), los efectos que guardan/sincronizan cartera y alertas, `pullOrPushServerData` y el efecto de alertas por tick. El comentario en el código decía que el estado "se conserva", pero las dos líneas `useState` no estaban. El build de Vite NO detecta variables no declaradas — misma clase de fallo que v13.1 (`prevVerdictKey`) — por eso pasó todos los tests y el build.

**Corrección (cambio mínimo):** restauradas las dos declaraciones tal como estaban en v15.2, antes de `priceAlertsRef`:
- `const [portfolio, setPortfolio] = useState(() => loadLS('cev_portfolio_v1', { cash: START_CASH, holdings: {}, trades: [] }));`
- `const [priceAlerts, setPriceAlerts] = useState(() => dedupePriceAlerts(loadLS('cev_price_alerts_v1', [])));`

**Extra (misma verificación):** la gráfica quedaba vacía en el navegador de pruebas con `RangeError: Invalid language tag: en-US@posix` (lightweight-charts usa `navigator.language` y ese entorno tiene un locale roto). En un teléfono normal no pasa, pero se blindó con `localization: { locale: 'es-US' }` explícito en `createChart`.

**Verificación:** build sin errores (bundle nuevo `index-BqNnHKN8.js`); en Chromium real la página ya carga: se ven §1 posición, §2 decisión (caja "ESPERAR" sin posición), §3 referencia (objetivo Kalshi en vivo $64,611.64, SÍ 26¢ / NO 75¢), §4 señales y §5 gráfica; `tests-v15.3.1.mjs` nuevo (5 tests de regresión); suites viejas sin regresiones (ver VERSION.txt). Escaneo AST de todo el frontend: no quedan más variables sin declarar (los 10 avisos restantes eran falsos positivos: propiedades de `?.` y `ResizeObserver`).

## Novedades v15.3: reorganización del frontend + recomendación sin posición (17-nov-2026)

Pedido de Luis: reorganizar el frontend, limpiar, eliminar lo que sobra y que la interfaz se entienda en 3 segundos. Pedido nuevo en la misma versión: cuando no hay posiciones abiertas, el mercado debe decir claramente a qué apostar.

**Interfaz — nuevo orden (lo urgente primero):**

1. **§1 Mi posición en vivo**: ¿voy ganando o perdiendo? P&L estimado grande (VAS GANANDO / VAS PERDIENDO / PUEDES PERDER).
2. **§2 Decisión**: SAL AHORA / AGUANTA / INVIERTE MÁS, y sin posición, la recomendación del mercado (abajo).
3. **§3 Referencia en tiempo real**: BRTI ahora, promedio de 60 s (el que liquida), diferencia contra el objetivo, cuenta atrás, precio objetivo y SÍ/NO.
4. **§4 Señales del mercado**: veredicto SUBE/BAJA/ESPERAR 15m, fuerza, índice de coincidencia, aviso de señal débil, backtest 15m y ¿Cobro o me quedo? (virtual).
5. **§5 Gráfica**: velas BTC 15m al final. Después, la cuenta Kalshi colapsada (`<details>`), como antes.

Textos recortados: fuera el "% de ventana transcurrida", la apertura orientativa de Coinbase, el párrafo largo del objetivo y la línea larga de la fuente BRTI. Un solo número grande por sección, ancho máximo 720 px y formularios a ancho completo en el móvil (sin scroll horizontal ni zoom). El aviso único de solo lectura y el del backtest 15m se mantienen.

**Recomendación sin posición — "Apuesta a la SUBIDA" / "Apuesta a la BAJADA" / "ESPERAR":**

- La §2 sigue diciendo "sin posición abierta" y **no inventa ninguna decisión de posición** (SAL/AGUANTA). Pero en una caja aparte, bien visible, muestra lo que dice el mercado: la señal 15m traducida a lenguaje directo, con su fuerza y sus razones.
- Nueva función pura `marketRecommendation` (`kalshi.js`): señal clara alcista → **Apuesta a la SUBIDA**; clara bajista → **Apuesta a la BAJADA**; señal no clara → **ESPERAR**. Si la señal es débil (acierta menos del 50% en las últimas ventanas con señal clara) o conflictiva (la mayoría de los demás plazos van en contra de la señal 15m) → **ESPERAR, nunca inventa un lado**.
- Sigue siendo **sugerencia educativa, nunca una orden ni una garantía** (lo dice la caja; se mantiene el aviso del backtest 15m: 13 de 29 = 45%, IC 95% Wilson 28–62%, no se distingue de una moneda). Con posición abierta la caja **no** aparece: manda la decisión de la posición.

**Código — App.jsx partida en componentes:**

- `client/src/components/` nuevos: `LiveReference`, `MyPosition`, `Decision`, `Signals`, `ChartSection`, `AccountBox`, `AuthModal`. App.jsx queda como orquestador (estado, sondeos, efectos de datos y gráfico, vista admin) y pasa datos por props. App.jsx: 1.555 → ~790 líneas. La lógica y los nombres de las funciones puras de `kalshi.js` / `windowOutcome.js` no cambian; el backend no se toca.
- Las suites viejas ahora leen la fuente combinada (App.jsx + componentes en orden de pantalla) con el helper `frontendSrc.mjs` (`frontendSrc()` / `mainReturnSrc()`). Solo se actualizaron aserciones de textos/orden que el rediseño cambia por diseño:
  - v15: orden nuevo §1-§5 y renumeración (§1 posición, §2 decisión, §3 referencia).
  - v14: la decisión real ahora está en §2.
  - v13.4: backtest/historial 1h eliminados (no se mostraban desde v14) y `onRealDecision` ahora llega a KalshiConnect vía `AccountBox`.
  - v13.3: orden de secciones con la numeración nueva.
  - v15.1: perfil local eliminado con la liga; el comentario de §5 vive ahora en `ChartSection.jsx`.
  - v13.1: el escaneo de `X.current` sin declarar ahora es recursivo (cubre `components/`); se reconoció como prop desestructurada para no dar un falso positivo con `firstRealDecision.currentPriceCents` (nombre de propiedad, no ref).
  - v11: la fuente pasa a ser la combinada (dos checks que leían solo App.jsx: la frase "NO es la probabilidad oficial" y la sección ¿Cobro o me quedo?).

**Qué se eliminó de App.jsx** (verificado con grep, nada de lo eliminado se referencia en otro sitio): cartera virtual, liga semanal y privada, misiones/XP/logros/racha, perfil local/apodo, screener, compartir, panel PRO/mercado (`/api/global`, miedo, calor), backtest e historial 1h, toggles de gráfico (EMA y Bollinger quedan siempre visibles; RSI y comparar eliminados), `testServer`/`askNotif` y estados de depuración, `Sparkline`, `genCode`, `localDay`, `fmtNum`, `ASSETS`, `INTERVALS`, `ACHIEVEMENTS`. Los módulos `client/src/*.js` (`missions.js`, `screener.js`, `marketPro.js`, `shareCard.js`, `backtest.js`, `alerts.js`, etc.) **se quedan en disco**: las suites viejas los importan directamente y son código puro probado, no código de la vista.

**Qué se conserva a propósito:** sincronización cartera/alertas con el servidor (v12), alertas de precio guardadas (siguen sonando con cada tick), alerta de cambio de veredicto (una por minuto), vista Admin (`#admin`), KalshiConnect mínimo en `<details>`, BRTI con promedio de 60 s, decisión SAL/AGUANTA/INVIERTE MÁS, aviso de solo lectura y aviso del backtest 15m.

**No hecho (a propósito):** los efectos de creación/datos del gráfico (lightweight-charts) siguen en App.jsx — partirlos sin poder verificar el render en un navegador era arriesgado. Tampoco se limpiaron las clases CSS muertas (`.app-tabs`, `.tape`, `.league-table`, etc.): solo cosmético, queda pendiente.

Pruebas: build sin errores ni avisos JSX; `tests-v15.3.mjs` (nueva) 52/52; `npm test` 17/17; suites viejas sin regresiones: v15 52/52, v15.1 30/30, v14 49/49, v13.4 56/56 (con servidor local; 46 + 1 saltado sin él), v13.3 29/29, v13.2 58/58, v13.5 42/42, v13.1 13/13, v13 36/36 (con servidor local), v9 21/21, v11 33/34 (con servidor; el 1 que falla es `setCandleInterval(kalshiMode ? '15m' : '1h')`, que ya fallaba desde v14 porque `kalshiMode` se eliminó al pasar a pantalla única). v10: 18 pasan, 8 fallan — los 8 afirman funciones eliminadas de la vista en v14 (liga, screener auto, backtest 1h, panel PRO) y ya fallaban antes de v15.3. v12 no se pudo correr aquí: exige `ADMIN_EMAIL_TEST`/`ADMIN_PASS_TEST` en el entorno (el backend no se tocó en v15.3).

## Novedades v15.2: parche externo verificado, sin aplicar a ciegas (17-nov-2026)

Luis trajo un parche externo (v15.2, 988 líneas). Se aplicó con `git apply` tras verificar cada afirmación contra el código real. Veredicto:

- **FALLO GRAVE — VERDADERO (lookahead en el backtest 15m):** `windowOutcome.js` calculaba la señal con `analyze(tail.slice(0, i + 1))`, es decir, CON el cierre de la ventana i, y luego juzgaba esa misma vela. La señal ya "sabía" el resultado, así que el acierto salía inflado. Corregido: la señal se calcula solo con velas anteriores (`slice(0, i)`). **El porcentaje honesto baja: medido en vivo con velas reales de Coinbase (350 velas 15m, 18-nov-2026), el backtest 15m sin lookahead da 13 de 29 = 45%, margen al 95% (Wilson): 28–62%.** El intervalo incluye el 50%: con estas muestras el resultado NO se distingue de lanzar una moneda, y la app lo avisa en pantalla. El 70% (7/10) de v13.4 estaba inflado por este sesgo — no se esconde.
- **SERVIDOR — VERDADERO en todo:** SSL de Postgres desactivaba la verificación del certificado (`rejectUnauthorized: false`); ahora verifica salvo que la URL traiga `sslmode` o se ponga `DATABASE_SSL_INSECURE=1` solo para diagnosticar. CORS estaba abierto a todo el mundo (`cors()`); ahora en producción no hay cabeceras CORS salvo `CORS_ORIGINS`. JWT sin algoritmo fijado; ahora HS256 en firma y verificación. No había invalidación de sesiones al cambiar contraseña/rol; ahora `token_valid_after` (columna creada sola al arrancar) y el bootstrap de admin promueve la cuenta existente (antes solo cambiaba la contraseña y seguía siendo 'user'). Login con tiempo constante (DUMMY_HASH) aunque el email no exista. Rate limits con barrido de memoria y tope de claves, también en registro. Manejador final de errores 500 JSON y `unhandledRejection` registrado. `ws` añadido al `package.json` raíz. Precios de Kalshi en paralelo y ticker+stats de Coinbase en paralelo, timeout 2,5 s por fuente.
- **CLIENTE — VERDADERO:** el RSI era una media simple de las últimas 14 variaciones, no el suavizado de Wilder (verificado contra la serie clásica de Wilder: RSI(14) ≈ 70,53); ahora Wilder. El MACD usaba una señal aproximada; ahora MACD estándar (12, 26, 9) y `null` con menos de 34 velas, sin histograma falso. Sondeo pausado con la pestaña oculta (`visibleInterval`). "Confianza" pasa a "Índice de coincidencia", con aviso de que NO es una probabilidad de ganar.
- **NO aplicado / no incluido:** partir `App.jsx`, i18n, migrar 13 tests viejos (solo se actualizaron 3 comprobaciones que buscaban `setInterval` o la etiqueta antigua). `server/data/db.json` NO está versionado (está en `.gitignore` y en `.vercelignore` tras el parche) — confirmado.
- **Pendiente, no probado aquí:** Postgres real (Neon) y la UI en un navegador real. **Acción para Luis en Render: añadir `?sslmode=verify-full` al final de `DATABASE_URL`** (Neon lo soporta). Si no se hace, con `sslmode=require` en la URL la conexión sigue funcionando como hoy (la URL manda), así que no es urgente, pero es lo recomendado.

Pruebas: `npm test` (17 nuevos: análisis + servidor, sin red) 17/17; suites viejas sin regresiones: v15 52/52, v15.1 30/30, v14 49/49, v13.4 56/56 (con servidor local), v13.2 58/58, v13.1 13/13, v13.3 29/29, v13 36/36 (con servidor local; sin servidor falla por ECONNREFUSED, como antes).

## Novedades v15.1: verificación de la auditoría externa (17-nov-2026)

Luis trajo una auditoría externa con 5 fallos. Se verificó cada uno contra el código real y NO se reemplazó ningún archivo con el código pegado (el kalshi.js pegado era una versión recortada y le faltaban funciones que App.jsx usa, como windowOutcome y la firma actual de cashOutDecision).

- **FALLO 1 — VERDADERO (en sustancia):** tras el comentario de §5 había texto duplicado fuera del comentario (`Sin botones de intervalo... */}`), que esbuild avisaba ("}" no válido en JSX) y se veía en pantalla. El build NO se rompía (pasaba con aviso), como decía la auditoría. Corregido: texto duplicado eliminado; el build ya no avisa.
- **FALLO 2 — FALSO:** el P&L del NO ya era correcto. El precio actual es el precio DEL LADO que tienes: el servidor calcula `curPrice = yes ? yesPrice : 100 - yesPrice` y el precio medio sale de los fills de ese mismo lado, así que `(cur − avg) × cantidad / 100` vale para SÍ y para NO. La auditoría asumía que `cur` era el precio SÍ.
- **FALLO 3 — FALSO:** `entryPrice` ya estaba validado: `Number('') = 0` y `Number('abc') = NaN`, `cashOutDecision` devuelve SIN POSICIÓN si no hay entrada válida y el botón de guardar bloquea `!kalshiEntryNum || <= 0`; `fmt(NaN)` muestra '—'. No hay ninguna comparación de entryPrice contra el objetivo de Kalshi.
- **FALLO 4 — PARCIALMENTE VERDADERO:** la reconexión en sí NO borraba el estado (connectWs no limpia value/avg60s), pero había dos huecos reales: (a) un tick del WS sin `avg_60s_data` sobrescribía el promedio con null; (b) un error del sondeo en el cliente borraba todo el `brti` con `setBrti({source:'coinbase'...})`. Corregido: nuevo `mergeBrtiTick` en server/brti.js (solo sobrescribe campos no nulos) y el sondeo retiene el último valor de Kalshi marcándolo como desactualizado.
- **FALLO 5 — FALSO:** `activeTab` es una constante `'kalshi'` (v14: una sola pantalla, no hay pestañas), `symbol` es `'BTC'` y `user` solo cambia en login/logout (`/me` no se sondea; el apodo vive en localStorage). Endurecido: el efecto BRTI depende ahora de `user?.id` en vez del objeto entero.
- **Error extra (del código pegado Y del código real):** `liveDecision` devolvía SAL AHORA con color verde (#22c55e) cuando vas ganando y la señal va en contra. Corregido a rojo (#ef4444), como las demás salidas.

Pruebas: `tests-v15.1.mjs` (30).

## Novedades v15: Referencia en vivo primero + corrección del promedio de 60 s (17-nov-2026)

Pedido de Luis: que lo primero arriba sea la referencia en tiempo real (el valor de BTC de Kalshi, actualizándose lo más rápido posible) y sobre ella la predicción que avise si, según su posición y el valor, puede perder o no, y si es momento de sacar o de invertir más.

1. **Referencia en tiempo real (§1)**: BRTI en vivo, precio objetivo de la ventana, diferencia en $ y % contra el objetivo, cuenta atrás y precio SÍ/NO en centavos. El BRTI se sondea cada 2 s y el mercado Kalshi cada 15 s (antes 3 s y 30 s).
2. **Mi posición en vivo (§2)**: tu posición real (lado, apuesta SUBE/BAJA, precio medio, cantidad), P&L en vivo calculado con el BRTI actual, y aviso claro **VAS GANANDO / VAS PERDIENDO** y **PUEDES PERDER** si el BRTI está en contra de tu apuesta o cerca del objetivo en contra (a ≤30 $).
3. **Decisión (§3)**: **SAL AHORA / AGUANTA / INVIERTE MÁS** — solo sugerencia educativa, nunca una orden. SAL si vas perdiendo y la señal va en contra o el contrato está ≤15¢; AGUANTA si vas ganando y la señal va a favor; INVIERTE MÁS solo si vas ganando, la señal es fuerte a favor y el contrato está barato (≤40¢), con aviso de que invertir más aumenta el riesgo. Sin posición abierta dice "sin posición abierta" y no inventa una decisión.
4. **Señales del mercado (§4)**: veredicto SUBE/BAJA/ESPERAR 15m, fuerza, confianza y el porqué en simple. **5. Gráfica (§5)**: velas BTC 15m al final.
5. **Corrección importante (Luis)**: Kalshi no liquida con el precio exacto del último segundo ni con el valor instantáneo que parpadea: liquida con el **promedio simple de 60 segundos del BRTI** medido justo antes del cierre. Ahora el ganar/perder, la diferencia contra el objetivo y la decisión se calculan **solo** con ese promedio; si no está, la pantalla lo dice y no usa el tick como si fuera el de liquidación. Se muestran ambos valores con etiqueta clara: **"BRTI ahora"** y **"Promedio de 60 s (el que liquida)"**. El objetivo es el promedio de 60 s antes de la apertura; el cierre se compara contra ese objetivo con el promedio de 60 s antes del cierre.

Solo lectura, como siempre; la pantalla sigue siendo una sola, mínima; el backend no se toca. Pruebas: `tests-v15.mjs` (52).

## Novedades v14: Una sola pantalla — BRTI, objetivo, gráfica y señales (17-nov-2026)

Pedido de Luis: limpia la pantalla, que solo se vean el precio actual de Kalshi, el precio objetivo, la gráfica y las señales, todo en una sola pantalla, y lo demás fuera.

1. **Precio actual de Kalshi (BRTI) en vivo** (el de v13.5): valor en vivo, promedio de 60 s (el que liquida), diferencia contra el objetivo en $ y %, y GANANDO / PERDIENDO según BRTI para tu primera posición real abierta.
2. **Precio objetivo de Kalshi**: el del mercado KXBTC15M actual, con la ventana, la cuenta atrás y los precios SÍ/NO en centavos.
3. **La gráfica**: velas BTC 15m, siempre visible, sin botones de intervalo ni toggles de indicadores.
4. **Las señales**: veredicto SUBE / BAJA / ESPERAR 15m y ¿Cobro o me quedo? (virtual y banner de decisión real por precio del contrato).

Eliminado de la vista: las pestañas Mercados, Gráfico y señal, Cartera virtual, Liga y misiones; ticker tape, grid de mercados, panel PRO, screener, backtest, historiales, análisis en vivo, cartera, liga, misiones/XP, logros, alertas y estado del servidor. Queda, discreto: encabezado pequeño con sesión, "Mi cuenta Kalshi — conectar / desconectar" como detalle colapsado (KalshiConnect en modo mínimo: carga las posiciones y sube la decisión real, sin mostrar la tabla ni el historial), y un aviso único en una línea (prueba educativa, dinero virtual, solo lectura, liquidación BRTI). La vista Admin (#admin) sigue intacta. El backend no se toca: auth JWT, Kalshi solo lectura, `/api/kalshi-market` y `/api/kalshi/brti` siguen igual. Pruebas: `tests-v14.mjs` (49).

## Novedades v13.5: Valor en vivo de Kalshi (BRTI) por WebSocket (17-nov-2026)

Luis lo aprobó: la pestaña Kalshi ya no decide si vas ganando o perdiendo con el precio de Coinbase, sino con el número que de verdad liquida el mercado: el índice **CF Benchmarks BRTI**.

1. **Valor actual Kalshi (BRTI) en vivo** en la pestaña Kalshi, junto al precio objetivo: valor en vivo, promedio de 60 s (el que liquida), diferencia contra el objetivo en $ y %, y **GANANDO / PERDIENDO según BRTI** para tu primera posición real abierta (contra el promedio de 60 s, o el valor en vivo si aún no hay promedio). Sin posición real, muestra si el BRTI está por encima o por debajo del objetivo.
2. **Cómo llega el valor:** el servidor abre UNA conexión WebSocket a Kalshi por usuario conectado (`wss://external-api-ws.kalshi.com/trade-api/ws/v2`, canal `cfbenchmarks_value`, índice `BRTI`), con la clave del usuario ya conectado (nueva dependencia `ws` en el servidor, solo para poner las cabeceras del handshake — el WebSocket global de Node no las admite). El frontend solo sondea `GET /api/kalshi/brti` (autenticado, JWT) cada 3 s con la pestaña activa y lee el último tick guardado en memoria. Sin Kalshi conectado NO se abre ninguna conexión.
3. **Correcciones verificadas contra docs.kalshi.com:** **Pyth NO liquida KXBTC15M** (el canal `pyth_value` existe, pero la liquidación es BRTI de CF Benchmarks). El WebSocket de Kalshi **exige autenticación en el handshake** incluso para datos públicos, por eso lo abre el servidor y nunca el navegador. El mensaje `msg.data` viene como STRING JSON (segunda decodificación) y el timestamp del tick es `received_at`.
4. **Fallback honesto:** si no hay Kalshi conectado, o el WS falla, o aún no llegó el primer tick, la pestaña muestra el precio de Coinbase con el aviso "Precio de Coinbase, no de Kalshi (BRTI)", nunca en blanco y nunca un número inventado. Si el promedio de 60 s no está disponible, lo dice. La conexión se cierra sola tras 5 min sin sondeo (límite de conexiones de Kalshi + Render gratis).
5. Solo lectura, como siempre: el WS solo se suscribe al índice, no a canales de órdenes ni posiciones, y no hay ninguna llamada de escritura a Kalshi.

Nada de v7–v13.4 se quitó. Mercados y gráfico siguen con Coinbase/Kraken. Pruebas: `tests-v13.5.mjs`.

## Novedades v13.4: Medición Kalshi real + decisión por precio del contrato (13-nov-2026)

Auditoría del 12-nov-2026 (21:04 Chicago) encontró un fallo metodológico: "Últimas ventanas" y el backtest 15m medían el acierto contra la vela SIGUIENTE, pero Kalshi liquida cada ventana contra su precio objetivo. Además la decisión de cobrar ignoraba el precio del contrato en centavos, y el mismo BTC mostraba dos cambios 24h distintos (ticker vs grid de Mercados). Todo corregido:

1. **Medición 15m como liquida Kalshi** (`client/src/windowOutcome.js`): cada ventana se mide por su propio cierre contra su apertura. Medido en vivo con velas reales: la medida vieja daba 4/10 (40%) y la nueva 7/10 (70%); 8 de 13 ventanas claras discrepan. La señal general 1h sigue con la medida de vela siguiente (correcta para ella).
2. **Etiqueta honesta:** "Últimas ventanas con señal clara — 15 min" (no son las últimas 5 seguidas: la señal es rara). Tabla con Apertura y Cierre.
3. **SEÑAL DÉBIL:** si la señal acierta menos del 50% en las últimas ventanas con señal clara, el veredicto muestra "⚠️ SEÑAL DÉBIL" junto a SUBE/BAJA/ESPERAR, además de bajar la confianza a 60%.
4. **Decisión REAL por precio del contrato** (`cashOutDecisionReal`): ≥85¢ → COBRA AHORA; ≤15¢ → SAL (salvo señal muy a favor con más de la mitad de la ventana por delante); entre 15¢ y 85¢ manda la señal. P&L real en $. La posición VIRTUAL no cambia.
5. **Cambio 24h unificado:** `/api/markets` ahora usa Coinbase como primaria, la misma fuente que el ticker; Kraken queda de respaldo. Verificado: ticker −5,07% y Mercados −5,07%.
6. **Historial de mis apuestas (§3b):** cerradas con resultado desde el P&L realizado de Kalshi (si no lo devuelve, dice "sin dato") y fills recientes.
7. **Auto-refresco** de posiciones reales cada 30 s con la pestaña Kalshi activa, con aviso si la última sincronización tiene más de 2 min.
8. **Decisión real al frente:** banner COBRA/AGUANTA/SAL de la posición abierta justo debajo del veredicto, antes del formulario virtual.
9. Comentario de cabecera de `kalshi.js` actualizado (ya no dice que no hay conexión a Kalshi).

Nada de v7–v13.3 se quitó. Pruebas: `tests-v13.4.mjs` (56).

## Novedades v13.3: Kalshi en UNA sola pestaña (12-nov-2026)

Las dos pestañas de Kalshi eran un ir y venir: la predicción en
**Kalshi** y la cuenta en **Mi cuenta Kalshi**. Ahora hay una sola
pestaña **Kalshi**, con todo en orden de arriba a abajo:

1. **Predicción de la ventana 15m** (como antes, lo primero).
2. **¿Cobro o me quedo?** con tu posición (virtual o real).
3. **Mis posiciones de Kalshi — solo lectura:** tabla de abiertas con
   título, lado, apuesta, precio medio, precio actual, P&L y decisión;
   debajo, sección pequeña de cerradas.
4. **Mi cuenta:** estado de conexión, balance, valor de cartera,
   botones Actualizar posiciones / Desconectar, y el formulario para
   conectar (Key ID + clave privada) solo si no está conectado, o
   colapsado si ya lo está. También aquí: tu sesión y el botón para
   salir de tu cuenta, y tu perfil local (apodo).
5. **Últimas ventanas** con acierto/fallo.

Nada del contenido de la pestaña vieja se perdió, solo se movió. El
aviso de solo lectura y el de liquidación BRTI quedan una sola vez,
no duplicados. Las demás pestañas (Mercados, Gráfico y señal, Cartera
virtual, Liga y misiones, Admin) quedan igual.
Pruebas: `tests-v13.3.mjs` (29).

## Novedades v13.2: lado de Kalshi verificado + precio objetivo de Kalshi (12-nov-2026)

Luis reportó con captura que una posición cerrada (KXBTC15M-26NOV122130-30,
"BTC price up in next 15 mins?", cantidad 0) se mostraba como Lado SÍ cuando
él había apostado a la BAJA, y que la app decía que la dirección no se podía
deducir. Causa raíz, verificada contra la documentación de Kalshi:
`/portfolio/positions` no trae ningún campo `side`; el lado va en el signo
de `position`/`position_fp` (>0 = SÍ, <0 = NO, 0 = sin posición neta), y el
código hacía `count < 0 ? 'no' : 'yes'`, inventando un SÍ para la cantidad 0.
Ahora el lado se resuelve por campo explícito > signo de la posición (solo si
es distinto de 0) > lado del último fill del ticker > desconocido (visible,
nunca inventado). La dirección se deduce del ticker+título+lado ("price up"
+ SÍ = SUBE, "price up" + NO = BAJA, "down" + SÍ = BAJA, "down" + NO = SUBE).
Las posiciones con cantidad 0 salieron de la tabla de abiertas a su propia
sección "Posiciones cerradas / liquidadas", sin P&L ni decisión; cada posición
abierta muestra título, lado y apuesta (SUBE/BAJA) para verificarla a ojo, y
si su ventana 15m ya cerró, la tabla lo dice. También se corrigió que la hora
del ticker Kalshi es el cierre de la ventana, no el inicio.

Además, la pestaña Kalshi ahora usa como precio de referencia de la ventana
el PRECIO OBJETIVO del mercado actual KXBTC15M, leído de la API pública de
Kalshi (sin clave) en `GET /api/kalshi-market` (floor_strike o el "Target
Price" de yes_sub_title), y muestra al lado el precio SÍ/NO de Kalshi en
centavos (precio del contrato, no probabilidad de acierto de la señal). La
pestaña avisa que la liquidación usa el índice CF Benchmarks BRTI (promedio
de 60 segundos, 7 exchanges), no Coinbase. Mercados y Gráfico siguen con
Coinbase/Kraken: Kalshi no tiene SOL, XRP, ADA, DOGE, AVAX, LINK, LTC ni
DOT. Si la API pública de Kalshi falla, la pestaña cae a Coinbase con el
aviso "precio de referencia de Coinbase, no de Kalshi", nunca en blanco.
Pruebas: `tests-v13.2.mjs` (58).

## Novedades v13.1: arreglo urgente del ReferenceError de v13 (12-nov-2026)

En producción, el bundle v13 (`index-CX6imwh_.js`) rompía el render con
un error no capturado que Luis copió de su consola:
`ReferenceError: prevVerdictKey is not defined`. Causa raíz: la
refactorización a pestañas de v13 borró la declaración de dos refs que
el efecto de alerta de cambio de veredicto seguía usando
(`prevVerdictKey` y `lastSignalAlertRef`). Ahora están declaradas con
`useRef(null)` junto a `alertCooldownRef` en `client/src/App.jsx`. La
deduplicación de alertas por minuto sigue igual. Lección: el build de
Vite NO detecta variables sin declarar (no es error de sintaxis), así
que la nueva prueba `tests-v13.1.mjs` (13/13) revisa el bundle
compilado buscando los nombres literales, además de simular cambios
de veredicto en el mismo minuto.

## Novedades v13: PESTAÑAS — Kalshi al frente, sin ruido (12-nov-2026)

Luis lo dijo claro: la app tenía muchísimo ruido y lo verdaderamente
importante son las predicciones de Kalshi. Ahora la app se navega por
pestañas, siempre visibles arriba: **Kalshi** (por defecto al entrar),
**Mercados**, **Gráfico y señal**, **Cartera virtual**, **Liga y
misiones**, y **Admin** (solo si eres admin). Desde v13.3, la pestaña
Kalshi lo tiene todo junto: predicción, ¿cobro o salgo?, posiciones,
cuenta y últimas ventanas (antes la cuenta vivía en su propia pestaña
"Mi cuenta Kalshi").

- **Pestaña KALSHI (limpia, sin ruido):** solo el Modo Kalshi 15 min
  — ventana actual con cuenta atrás, precio de referencia, veredicto
  gigante SUBE/BAJA/ESPERAR, porqué en simple, ¿Cobro o me quedo?
  con tu posición (virtual o real si está conectada), tus posiciones
  reales, tu cuenta y últimas ventanas con acierto/fallo. Sin ticker
  tape, sin mercados, sin liga ni misiones en esta pestaña.
- **Fallos del video del 12-nov, corregidos:**
  1. **Gráfico en blanco:** el gráfico se creaba una sola vez al
     montar la app; si el contenedor aún no tenía tamaño o las velas
     no habían llegado, quedaba vacío y nada lo recreaba. Ahora se
     crea cada vez que se entra en la pestaña Gráfico (y se destruye
     al salir), con ResizeObserver, y si no hay velas dice
     "Cargando velas…" en vez de quedarse en blanco. Al cambiar de
     intervalo se vacían las velas viejas antes de pintar las nuevas.
  2. **Posición real de Kalshi vacía:** en el video salía Precio
     medio 0¢, Cantidad —, Precio actual 0¢ y "SIN POSICIÓN". Causa:
     en el cliente, `Number(null)` es 0, así que una posición sin
     precio medio se veía como 0¢. Ahora null es null ("—") y la
     posición lleva una explicación en claro: cantidad 0 = cerrada o
     sin cantidad abierta (puede estar liquidada o vencida); sin
     precio medio = no hay operaciones para calcularlo; sin precio
     actual = mercado cerrado/vencido o sin cotización.
  3. **Alertas contradictorias en el mismo segundo:** salieron
     "ESPERAR (puntuación -14)" y "VENDER (puntuación -34)" a la vez.
     Causa: el veredicto se recalcula con cada tick y con cada
     refresco de las 4 temporalidades, y cruzaba el umbral varias
     veces por segundo. Regla nueva: una sola alerta de cambio de
     veredicto por minuto; si cambia dos veces en menos de 60 s,
     solo queda la última (se reemplaza, no se añade otra).
  4. **Señales 15m fallando:** en las últimas ventanas, 4 de 5
     señales BAJA fallaron. No se esconde: si en las últimas
     ventanas la señal 15m acierta menos del 50%, la pestaña Kalshi
     lo avisa en grande y la confianza estimada se baja (tope 60%).
  5. El subtítulo ya no dice "(admin /admin)": era un resto de
     depuración.
- Nada de v7–v12 se quitó: todo sigue en su pestaña.

## Novedades v12: Usuarios + Kalshi SOLO LECTURA (12-nov-2026)

La app pública sigue igual y sin registro obligatorio para ver precios
y señales. Los usuarios son una capa encima, para guardar las cosas
en la cuenta y para conectar Kalshi.

### 1. Usuarios (registro, login, JWT)
- **Registro** con email + contraseña (mínimo 8 caracteres, hash
  bcrypt, nunca en claro) y nombre/apodo. **Login** con JWT (7 días),
  sesión que persiste, **Salir**. Sin sesión, todo sigue local como
  en v11.
- ¿Olvidaste tu contraseña? No hay correo automático: pídele al admin
  que la resetee desde el panel de administración.
- Al entrar con cuenta, tu cartera virtual y tus alertas se guardan
  en tu cuenta (si el servidor ya tenía datos, se usan esos; si no,
  se suben los locales). Sin cuenta, siguen en este navegador.

### 2. Panel de administración (`/admin`, solo rol admin)
- Luis es el primer admin (se crea con las variables de entorno
  `ADMIN_EMAIL` y `ADMIN_PASSWORD` en Render, ver DEPLOYMENT.md).
- El admin ve: lista de usuarios, quién conectó Kalshi (solo sí/no
  y última sincronización), quién está activo, y puede
  desactivar/reactivar un usuario y resetearle la contraseña.
- El admin **NUNCA** ve contraseñas ni claves privadas de Kalshi de
  nadie: las respuestas del servidor no las incluyen jamás.

### 3. Conectar Kalshi por usuario (SOLO LECTURA)
- En el Modo Kalshi 15 min, con sesión, hay un panel "Conectar
  Kalshi (solo lectura)": pegas tu Kalshi API Key ID y tu clave
  privada (.pem, texto o archivo). El servidor la **cifra con
  AES-256-GCM** (clave maestra `KALSHI_ENCRYPTION_KEY` en Render) y
  la guarda cifrada. El frontend nunca la recibe de vuelta: solo se
  muestra `keyIdPreview` (4 primeros + 4 últimos caracteres).
- El servidor usa tu clave **solo para firmar peticiones GET** a
  Kalshi: `/trade-api/v2/portfolio/positions`,
  `/portfolio/balance` y `/portfolio/fills`. **Nunca** llama a
  crear/cancelar órdenes ni a ningún endpoint de escritura: no
  existe ese código en el servidor (tests-v12 lo comprueba).
- Conectado, ves tus **posiciones reales de Kalshi** (ticker, lado
  sí/no, precio medio en ¢, cantidad, precio actual en ¢, P&L
  estimado) y la decisión de cobrar/salir del modo 15 min aplicada
  a TU posición real, no a una virtual. Sin conectar, sigue el modo
  virtual de v11 sin cambios.

### 4. Base de datos (Neon Postgres)
- Tablas `cev_users`, `cev_kalshi_connections` y `cev_user_data`
  (ver `server/schema.sql`; el servidor las crea solas al arrancar
  si `DATABASE_URL` está puesta). Base separada para cripto-en-vivo:
  NO se tocan las tablas de Mercado Cuba.
- **Sin `DATABASE_URL` (dev local)**, el servidor usa un archivo
  JSON local (`server/data/db.json`, ignorado por git). En Render
  ese archivo se perdería al reiniciar (disco efímero): en
  producción `DATABASE_URL` es obligatoria.
- Variables de entorno en Render (solo los nombres; los valores los
  pone Luis en el panel de Render, nunca en GitHub ni en el chat):
  `DATABASE_URL`, `JWT_SECRET`, `KALSHI_ENCRYPTION_KEY`,
  `ADMIN_EMAIL`, `ADMIN_PASSWORD` (solo para crear el primer admin;
  quítala después de entrar).

## Qué es real y qué es demo/local

| Función | Estado |
|---|---|
| Precios, velas, mercados (Coinbase/Kraken/Binance US/CoinGecko vía servidor) | REAL |
| Análisis RSI/MACD/EMA/Bollinger/patrones, backtest | REAL (cálculo local sobre datos reales), pero prueba educativa: no predice nada |
| Cartera virtual, operaciones, alertas de precio | LOCAL (localStorage, dinero virtual) |
| Dominio BTC, capitalización total, miedo y codicia | ESTIMADO PROPIO (proxy/etiqueta clara, no dato oficial) |
| Liga semanal: rivales, puestos, ganador | DEMO/LOCAL (rivales simulados, sin cuentas) |
| Liga privada con código | LOCAL (el código solo existe en este navegador) |
| Misiones, XP, niveles, racha, logros | LOCAL |
| PWA instalable + notificaciones | REAL (locales vía service worker); push real con servidor: NO EXISTE |
| Tarjeta para compartir (texto + PNG) | REAL (se genera en tu navegador) |
| Screener | REAL (cálculo sobre datos reales), prueba educativa |
| Modo Kalshi 15 min: ventana, cuenta atrás, señal SUBE/BAJA, ¿cobro o salgo? | REAL (cálculo local sobre velas reales de 15m), pero prueba educativa: sin cuenta de Kalshi, sin API de Kalshi, sin dinero real; la probabilidad es estimada propia, NO oficial de Kalshi |
| Posición virtual Kalshi (entrada, dirección, cantidad) | LOCAL (localStorage, dinero virtual) |
| Usuarios: registro/login, cartera y alertas en la cuenta | REAL (Neon Postgres con DATABASE_URL; en local, archivo JSON) |
| Conectar Kalshi por usuario | REAL (solo lectura: posiciones/saldo/fills con tu clave cifrada AES-256-GCM; nunca opera por ti) |
| Panel de administración (/admin) | REAL (solo rol admin; nunca muestra contraseñas ni claves privadas) |

## Novedades v6 y anteriores

### El gráfico ahora se mueve con cada tick
Antes la última vela solo cambiaba cada 6 s con el fetch de velas, y
en intervalo 1m casi no se movía. Además, la última vela de Coinbase
va con ~4-5 minutos de retraso (comprobado: a las 00:37 UTC la última
vela de 1m era de las 00:33, mientras Kraken sí traía la del minuto
actual). Por eso el gráfico parecía congelado aunque el precio sí
cambiaba.
- Cada tick del ticker (cada 1 s) actualiza la última vela en pantalla:
  `close` = precio actual, `high`/`low` se ajustan. Se pinta al
  instante con `series.update()` de lightweight-charts y se guarda en
  el estado para que RSI/MACD/EMA/Bollinger también se muevan.
- Si el tick cae en un minuto nuevo, se crea la vela de ese minuto con
  el precio del tick (volumen 0, es una vela viva). El próximo fetch de
  `/api/candles` la reemplaza por la vela oficial del servidor, así que
  cualquier diferencia se corrige sola en segundos. Las velas vivas más
  nuevas que la última del servidor no se borran al llegar el fetch
  (`mergeServerCandles` en `client/src/liveCandle.js`).
- La lógica de la vela viva está probada con tests en Node
  (`updateLastCandle`, `mergeServerCandles`).

### Cartera virtual (dinero de mentira, solo en tu navegador)
- Empiezas con **10.000 virtuales** en la moneda seleccionada.
- En la sección "Cartera virtual" pon una cantidad y pulsa **Comprar**
  o **Vender** el activo seleccionado, al precio en vivo. También hay
  "Compra rápida $100" y "Reiniciar a 10.000".
- Ves efectivo, valor en criptos, valor total y ganancia/pérdida en $
  y %. Tus operaciones quedan en el historial (últimas 50) y todo se
  guarda en `localStorage`: si cierras la app y vuelves, tu cartera
  sigue ahí.
- ⚠️ Es un juego: NO es dinero real, no se conecta a ningún exchange
  y no se puede retirar nada.

### Alertas de precio
- En "Alertas de precio" pon un precio objetivo para el activo
  seleccionado y elige "Sube por encima de" o "Baja por debajo de".
- Cuando el precio en vivo lo cruce, sale la alerta en pantalla, queda
  en el historial de alertas y, si activaste las notificaciones del
  navegador, también te llega una notificación. Las alertas se guardan
  en `localStorage` y se pueden quitar una a una.

### Top movers, sparklines, racha y logros
- **Ticker tape superior:** los 10 precios en vivo desfilando arriba.
- **Ánimo del mercado:** cuántas criptos suben/bajan en 24 h, cambio
  medio y etiqueta (Euforia / Optimista / Neutral / Pesimista / Pánico),
  más el top del día (la que más sube y la que más baja).
- **Sparklines:** cada pestaña lleva un mini gráfico con los últimos
  precios recogidos en vivo.
- **Racha:** la app cuenta los días seguidos que la abres (solo local).
- **Logros** (solo local, sin cuentas): Primera operación virtual,
  Primera alerta de precio, Racha de 3 días, En verde +2%, Cazador del
  top (comprar el activo que más sube) y Explorador (ver 5 activos).
- La señal de posible subida/bajada ahora es más grande, con fondo de
  color y barra de puntuación, y el precio grande se anima en verde o
  rojo con cada tick.

## Requisitos

- **Node.js 20 o superior** (comprueba con `node -v`)
  - Windows: descárgalo de https://nodejs.org (versión LTS) e instálalo.
  - Ubuntu: `sudo apt update && sudo apt install -y nodejs npm`
    (o usa NodeSource para Node 20+ si el de apt es viejo).
- **VS Code** — https://code.visualstudio.com
- Sin claves ni secretos: todo usa APIs públicas gratuitas.

## Cómo arrancarlo en VS Code (Windows y Ubuntu, igual)

1. Copia esta carpeta a tu laptop (por ejemplo `Documents/cripto-en-vivo-react`).
2. Abre VS Code → **File → Open Folder** → elige esa carpeta.
3. Abre la terminal integrada: **Terminal → New Terminal**
   (atajo: `Ctrl + ñ` en Windows, `Ctrl + Alt + T` en Ubuntu para la terminal del sistema).
4. Instala las dependencias (una sola vez):
   ```bash
   npm run install:all
   ```
   Esto instala la raíz, `server/` y `client/`. Tarda unos minutos.
   Si la red va lenta, espera; no cierres la terminal.
5. Arranca servidor + frontend juntos:
   ```bash
   npm run dev
   ```
   **Espera a ver la línea `✅ Cripto en Vivo — servidor en
   http://localhost:3001` ANTES de abrir el navegador.** `npm run dev`
   arranca primero el servidor y Vite no arranca hasta que el servidor
   responde a `/api/health` (hay un `wait-for-server.js` que lo espera
   hasta 30 s). Verás dos cosas: el servidor en `http://localhost:3001`
   y el frontend en `http://localhost:5173`.
6. Abre en el navegador: **http://localhost:5173**

> ⚠️ Si en los primeros segundos ves en la terminal
> `[vite] http proxy error ... AggregateError [ECONNREFUSED]`, **no
> mates el proceso con Ctrl+C**: es la carrera de arranque (Vite listo
> antes que el servidor). Espera 5 segundos y recarga la página
> (`F5`); el error debe desaparecer solo. Con el `wait-for-server.js`
> nuevo, Vite ya no debería arrancar antes que el servidor, pero si
> arrancas Vite solo (`cd client && npm run dev`) sin el servidor,
> el ECONNREFUSED vuelve: el servidor tiene que estar corriendo.

> Si prefieres arrancar por separado (dos terminales):
> ```bash
> # Terminal 1 — servidor
> cd server && npm run dev
> # Terminal 2 — frontend
> cd client && npm run dev
> ```

## Cómo probar que el servidor responde

Con el servidor corriendo, en otra terminal o en el navegador:

```bash
curl http://localhost:3001/api/health
curl "http://localhost:3001/api/ticker?symbol=BTC&currency=USD"
curl "http://localhost:3001/api/candles?symbol=BTC&currency=USD&interval=1m"
curl "http://localhost:3001/api/markets?currency=USD"
```

`/api/health` debe devolver `{"ok":true,...}`.
`/api/ticker` debe devolver un precio real mayor que 0 y el campo `source`
con la fuente que respondió (por ejemplo `"Coinbase"`).
`/api/candles` debe devolver una lista de velas con `open, high, low, close`.

## Si se queda en "Esperando datos"

Sigue estos pasos en orden, no saltes ninguno:

1. **Mira la terminal donde corriste `npm run dev`.** Ahí tienen que
   aparecer DOS cosas: el servidor (`✅ Cripto en Vivo — servidor en
   http://localhost:3001`) y el frontend de Vite (`Local:
   http://localhost:5173`). Si solo ves Vite y no ves la línea del
   servidor, el servidor NO está corriendo: ese es el problema.
   Fíjate también si en esa terminal hay líneas como
   `[17:40:12] ⚠️ Coinbase falló (ticker BTC-USD): ...` — esa es la
   fuente exacta que falló y el motivo.
2. **Abre http://localhost:3001/api/health en el navegador.**
   - Si ves `{"ok":true,...}`: el servidor SÍ está corriendo. Pasa al paso 3.
   - Si el navegador dice "No se puede acceder a este sitio" / "ERR_CONNECTION_REFUSED":
     el servidor NO está corriendo. Cierra todo y vuelve a correr
     `npm run dev` en la carpeta RAÍZ del proyecto (no dentro de
     `server/` ni de `client/`). Si `npm run dev` da error, copia el
     error completo de la terminal.
3. **Abre http://localhost:3001/api/debug en el navegador.**
   Te dice, fuente por fuente, para BTC/USD: `ok: true` con precio y
   milisegundos, o `ok: false` con el error exacto.
   - Si al menos una fuente dice `ok: true`: el servidor puede traer
     precios. Entonces el problema está en el frontend: pulsa el botón
     **"Probar servidor"** en la propia página (sección "Estado del
     servidor", arriba) y lee el error exacto que muestra.
   - Si TODAS dicen `ok: false`: el servidor corre, pero tu laptop no
     llega a ninguna de las 4 fuentes (Coinbase, Kraken, Binance US,
     CoinGecko). Revisa: ¿tienes internet en la laptop? ¿Hay VPN,
     antivirus o firewall bloqueando Node? Prueba abrir
     https://api.coingecko.com/api/v3/ping en el navegador: si eso
     tampoco abre, el problema es la red de la laptop, no la app.
   - Si `/api/debug` tarda mucho: cada fuente tiene timeout de 5 s,
     así que el test completo tarda como máximo unos 5–10 s (las fuentes
     se prueban en paralelo).
4. **Qué significa cada resultado:**
   - Servidor no corre (paso 2 falla) → solo corrió el cliente (Vite).
     La interfaz carga, pero no hay quién traiga precios: todo queda
     en "—" y "Esperando datos…". Solución: `npm run dev` en la raíz.
   - Servidor corre + al menos una fuente OK (paso 3) → los precios
     deberían llegar en 1–2 s. Si no llegan, pulsa "Probar servidor"
     en la página y copia el error exacto que sale.
   - Servidor corre + todas las fuentes fallan (paso 3) → red de la
     laptop bloqueada o sin internet. Prueba con otra red (Wi-Fi en
     vez de hotspot, o al revés) y vuelve a abrir `/api/debug`.

## Qué significan los errores de los logs de Luis (10-nov, 17:59–18:08)

Tres errores distintos, tres causas distintas. No los mezcles:

1. **`[vite] http proxy error: /api/ticker ... AggregateError
   [ECONNREFUSED]`** (17:59, al arrancar)
   - Significa: Vite (el frontend, :5173) ya estaba listo, pero el
     servidor (:3001) todavía no había arrancado. Vite quedaba listo en
     ~435 ms, antes que el servidor.
   - No es un fallo de las APIs ni de tu red: es una carrera de arranque.
   - Arreglo: `npm run dev` ahora arranca el servidor primero y Vite
     espera a que `/api/health` responda (`wait-for-server.js`).
     Si lo ves en los primeros segundos, espera 5 s y recarga (F5).
     No mates el proceso con Ctrl+C.
2. **`/api/candles?...&interval=[object%20Promise]`** (17:59, misma corrida)
   - Significa: **esa corrida era el código VIEJO**. El estado se llamaba
     `interval` y su setter `setInterval` eclipsaba el `setInterval`
     global: `setInterval(loadTicker, 1000)` llamaba al setter de React,
     que guardaba la Promise de `loadTicker` como estado `interval`.
     Por eso la URL llevaba `[object Promise]` en vez de `1m`.
   - En el código nuevo el estado se llama `candleInterval` y el ZIP ya
     lo trae (compruébalo: en `client/src/App.jsx` debe decir
     `candleInterval`, nunca `const [interval, setInterval]`).
   - Si vuelves a ver `[object Promise]`, es que **no reemplazaste la
     carpeta**: borra la carpeta vieja en `Descargas` y descomprime el
     ZIP nuevo entero. No copies archivos sueltos encima de la vieja.
3. **`⚠️ CoinGecko (batch) falló (markets USD): HTTP 429`** repetido
   cada 5–10 s, en pares, durante minutos (18:00 en adelante)
   - Significa: CoinGecko gratis te puso límite (429 = demasiadas
     llamadas). El batch de CoinGecko para `/api/markets` se estaba
     quemando: el cliente sondeaba cada 5 s + el fallback por activo
     volvía a llamar a CoinGecko + `/api/debug`.
   - El servidor SÍ estaba arriba en esa corrida (no había ECONNREFUSED):
     el 429 era solo CoinGecko, y el resto de fuentes seguían funcionando.
   - Arreglo: `/api/markets` ya NO usa CoinGecko como primaria. La
     primaria es una sola llamada batch a Kraken para los 10 activos,
     luego Coinbase en paralelo, y CoinGecko solo como último recurso.
     Además: si una fuente da 429, entra en pausa de 60 s sin reintentos
     y el log solo avisa la primera vez. Caché de markets: 15 s.
     Sondeo de pestañas del cliente: cada 10 s (antes 5 s).

## Cambiar el puerto

- Servidor: `PORT=4000 npm --prefix server start` (en Windows PowerShell:
  `$env:PORT=4000; npm --prefix server start`).
- Si cambias el puerto del servidor, cambia también el proxy en
  `client/vite.config.js` (la línea `'/api': 'http://localhost:3001'`).

## Producción (solo web, sin `npm run dev`)

```bash
npm run build        # compila el frontend en client/dist
npm start            # arranca solo el servidor en :3001, que además sirve el frontend
```

Luego abre http://localhost:3001

## Android (APK) — opcional, en tu laptop con Android Studio

El proyecto ya trae `capacitor.config.json` con
`appId: com.luis.criptoenvivo`. **No se compila el APK aquí** porque
requiere Android Studio + Android SDK en tu laptop. Pasos:

```bash
npm run build
npm install @capacitor/core @capacitor/cli
npx cap init "Cripto en Vivo" com.luis.criptoenvivo --web-dir=client/dist
npx cap add android
npx cap sync
npx cap open android
```

En Android Studio, conecta tu Pixel por USB (o usa un emulador) y pulsa
**Run**. Para generar el APK: **Build → Build App Bundle(s) / APK(s) →
Build APK(s)**.

> ⚠️ Importante para Android: en el teléfono, el servidor Node **no**
> corre en el teléfono; la app empaquetada debe apuntar a tu laptop
> (por ejemplo `http://192.168.1.X:3001`) o a un servidor publicado.
> La forma más simple de usarla en el día a día es abrir
> `http://localhost:5173` en la laptop, y en el teléfono usar la versión
> con servidor que corre en Muse. El APK es un paso extra, no obligatorio.

## Estructura

```
cripto-en-vivo-react/
├── package.json          # scripts raíz: dev, build, start
├── wait-for-server.js    # espera a /api/health antes de arrancar Vite (evita ECONNREFUSED)
├── capacitor.config.json # appId com.luis.criptoenvivo (Android opcional)
├── README.md
├── server/
│   ├── package.json      # express + cors
│   └── server.js         # endpoints /api/health, /api/debug, /api/markets, /api/ticker, /api/candles
└── client/
    ├── package.json      # react, vite, lightweight-charts
    ├── vite.config.js    # proxy /api -> localhost:3001
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx       # orquestador: estado, sondeos, efectos de datos y gráfico, vista admin
        ├── components/   # v15.3: LiveReference, MyPosition, Decision, Signals, ChartSection, AccountBox, AuthModal
        ├── KalshiConnect.jsx # conexión Kalshi solo lectura (posiciones, saldo, historial)
        ├── liveCandle.js # vela en vivo con cada tick + merge con velas del servidor
        ├── analysis.js   # RSI, MACD, EMA, Bollinger, patrones de velas
        └── index.css     # estilo oscuro tipo terminal, responsivo
```

## Pendiente

- El APK de Android (requiere Android Studio en la laptop de Luis).
- El servidor corre solo mientras la laptop esté encendida; si la apagas,
  la app deja de actualizar (es localhost, no está publicada en internet).
  **La versión pública en Render (https://cripto-en-vivo.onrender.com)
  no tiene ese problema**: corre en el servidor de Render, aunque el plan
  gratis se duerme tras ~15 min sin visitas (~50 s de arranque en frío).
- Push real con servidor (VAPID): no implementado a propósito en el plan
  gratis de Render; las notificaciones actuales son locales vía service
  worker (ver sección v7, punto 6).
- Liga con cuentas reales y rivales humanos: no existe. La liga demo/local
  se eliminó del todo en v15.3 (código y vista); no hay liga ni rivales.

