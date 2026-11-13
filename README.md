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
   cuenta de Kalshi conectada, no hay dinero real.
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
**Mercados**, **Gráfico y señal**, **Mi cuenta Kalshi**, **Cartera
virtual**, **Liga y misiones**, y **Admin** (solo si eres admin).

- **Pestaña KALSHI (limpia, sin ruido):** solo el Modo Kalshi 15 min
  — ventana actual con cuenta atrás, precio de referencia, veredicto
  gigante SUBE/BAJA/ESPERAR, porqué en simple, ¿Cobro o me quedo?
  con tu posición (virtual o real si está conectada) y últimas
  ventanas con acierto/fallo. Sin ticker tape, sin mercados, sin liga
  ni misiones en esta pestaña. El formulario para conectar Kalshi vive
  en **Mi cuenta Kalshi**; en la pestaña Kalshi solo se ven las
  posiciones reales (versión compacta).
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
        ├── App.jsx       # pestañas, precio, gráfico, alertas, cartera virtual, logros
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
- Liga con cuentas reales y rivales humanos: no existe; la liga actual es
  demo/local por diseño (ver sección v7, punto 4).
