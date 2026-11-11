# Despliegue web — Cripto en Vivo

Estado (2026-11-11): el proyecto está **listo para desplegar** y
**probado en modo producción** (`npm start`: `/api/health` OK, BTC
$73,430.65 vía Coinbase, `/` HTTP 200). No hay URL pública todavía:
Vercel bloqueó la creación del proyecto (403, ver abajo) y en Render
falta que Luis cree el repo en GitHub y el servicio en Render — ver
`RENDER.md` con los pasos exactos. No se compró dominio ni se cambió
a plan de pago. Todo lo de aquí es plan gratis.

## Archivos añadidos para Vercel (sin romper lo local)

- `vercel.json` — `buildCommand: npm run install:all && npm run build`,
  `outputDirectory: client/dist`, `framework: null`. Sin rewrite.
- `api/index.js` + `api/health.js`, `api/ticker.js`, `api/markets.js`,
  `api/candles.js`, `api/debug.js` — cada uno exporta la misma app
  Express de `server/app.js`. Vercel enruta `/api/ticker` a
  `api/ticker.js`, etc. No hay rewrite porque la documentación de Vercel
  dice que con un rewrite la función ve la ruta reescrita (`/api/index`)
  y perdería el endpoint original.
- `server/app.js` (nuevo) — toda la app Express (rutas `/api/*`,
  fuentes Coinbase/Kraken/Binance US/CoinGecko). `server/server.js`
  quedó fino: solo hace `app.listen` en local.
- `server/app.js` solo sirve `client/dist` cuando NO está en Vercel
  (`process.env.VERCEL`): en Vercel los estáticos los sirve Vercel
  desde `client/dist`.
- `package.json` (raíz) — ahora también declara `express` y `cors` como
  dependencias, para que el bundle de la función serverless los
  encuentre en la raíz. `server/package.json` no cambió (local igual).
- `.vercelignore` — excluye `node_modules` y `.git`.
- `render.yaml` — alternativa gratis en Render (ver abajo).

Lo local no cambia: `npm run dev` sigue igual (servidor :3001 +
frontend :5173), y `npm start` sirve API + frontend en :3001.

## Verificación local (2026-11-11, datos reales)

- `npm run build` del cliente: OK en 2.19 s.
- Servidor local: `/api/health` OK; `/api/ticker BTC/USD` →
  **$73,435.31, fuente Coinbase**; `/api/markets` → Kraken (batch);
  `/api/candles 1m` → velas reales de Coinbase; `/` → HTTP 200.
- Handlers serverless simulados (VERCEL=1, enrutado como Vercel):
  `/api/health` OK; `/api/ticker BTC/USD` → **$73,426.79, Coinbase**;
  `/api/markets` → Kraken (batch); `/api/candles` → Coinbase;
  `/api/debug` → las 4 fuentes OK (Coinbase, Kraken, Binance US,
  CoinGecko).

## Bloqueo en Vercel (evidencia)

- Cuenta: Luis (`luisegmolina`, luisegmolina01@gmail.com), plan **Hobby**
  activo, `defaultTeamId: team_1nM1uiYCtWCFnKx9UUwP3evo`.
- `list_projects` → 403 forbidden, ámbito `luisegmolinas-projects`,
  `teamId: team_1nM1uiYCtWCFnKx9UUwP3evo`,
  `requestId: iad1:cle1:iad1:sfo1::8x7zm-1794360060066-8487da6c0e0b`.
- `create_project` (nombre `cripto-en-vivo`) → mismo 403,
  operación `POST /v11/projects`,
  `requestId: iad1:cle1:iad1:sfo1::86hnw-1794360089362-9d739b5c374f`.
- Mensaje de Vercel en ambos casos: "Not authorized: Trying to access
  resource under scope luisegmolinas-projects. You must re-authenticate
  to this scope or use a token with access to this scope." Recuperación
  indicada: "Call authorize_team_access (or authorize_team_sso) with
  this teamId".
- Esa herramienta **no existe** en la lista de herramientas revisadas
  del conector (177 herramientas; no hay ninguna `authorize_team_access`
  ni `authorize_team_sso`). `list_teams` devuelve lista vacía.
- No se desconectó Vercel (eso borraría la conexión y haría falta
  volver a conectar). Lo que falta es que el usuario apruebe el acceso
  del conector al equipo `luisegmolinas-projects` en Vercel (o que el
  agente principal le muestre el enlace de autorización de equipo).
  Cuando ese acceso esté aprobado, basta con reintentar:
  `create_project` con nombre `cripto-en-vivo` y luego
  `create_deployment` con los archivos del proyecto.

## Cómo desplegar en Vercel cuando el acceso esté aprobado

1. Crear el proyecto `cripto-en-vivo` (sin framework, buildCommand y
   outputDirectory ya están en `vercel.json`).
2. Desplegar el contenido de esta carpeta (sin `node_modules`).
3. Comprobar: `curl https://<url>/api/health` y
   `curl "https://<url>/api/ticker?symbol=BTC&currency=USD"`.

## Limitaciones del plan gratis (Hobby) en Vercel

- Funciones serverless con límite de tiempo por defecto (en Hobby,
  ~10 s; no se fijó `maxDuration` en `vercel.json` para no pedir más
  de lo que el plan permite). Cada fuente tiene timeout de 5 s y hay
  fallback en cadena, así que en el caso normal (Coinbase responde en
  <1 s) sobra, pero si varias fuentes fallan a la vez la petición
  puede cortarse por timeout.
- Cold start: la primera petición tras un rato sin uso tarda más.
- La caché en memoria del servidor (ticker 2 s, markets 15 s, velas
  5 s) es por instancia de función, no compartida entre instancias.
- El frontend llama a `/api/...` relativo, así que funciona en el
  dominio de Vercel sin cambiar nada.

## Bloqueo en GitHub (2026-11-11, al intentar Render)

- `create_repository` (nombre `cripto-en-vivo`, privado) →
  **403 `Resource not accessible by integration`**,
  `POST https://api.github.com/user/repos`.
- La integración de GitHub (Muse GitHub App) solo tiene acceso al repo
  existente `luisegmolina/mercado-cuba`; no puede crear repositorios.
  `gh auth status` en esta máquina: no hay sesión de `gh`.
- Lo que falta: Luis crea el repo vacío en https://github.com/new
  (nombre `cripto-en-vivo`, privado, sin README) y luego Muse lo sube
  con `push_files`, o Luis lo sube él con `git push` (comandos en
  `RENDER.md`).

## Alternativa gratis: Render (si Vercel sigue bloqueado)

`render.yaml` ya está en el proyecto. Pasos:

1. Subir este proyecto a un repositorio de GitHub (privado vale).
2. En Render (render.com, cuenta gratis): New → Web Service →
   conectar el repositorio.
3. Render lee `render.yaml`: `buildCommand: npm run install:all &&
   npm run build`, `startCommand: npm start`, plan `free`.
4. Render asigna el puerto con la variable `PORT` (el servidor ya la
   usa) y da una URL `https://cripto-en-vivo.onrender.com`.
5. Comprobar igual: `/api/health` y `/api/ticker?symbol=BTC&currency=USD`.

Limitaciones del plan free de Render: la instancia se duerme tras
inactividad y el primer acceso tarda ~50 s en despertar; 750 h/mes
gratis (suficiente para una instancia siempre encendida en teoría,
pero con el sueño por inactividad). No se necesita tarjeta para el
plan free. El dominio propio se puede añadir después, sin coste en
Render (el dominio en sí se compra aparte, ~$10-15/año un .com).
