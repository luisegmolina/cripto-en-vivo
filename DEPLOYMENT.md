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

## v12 — Usuarios + Kalshi SOLO LECTURA (12-nov-2026)

### Qué se construyó
- Registro/login con email + contraseña (bcrypt) y JWT (7 días).
- Panel de administración en `/admin` (solo rol admin).
- Conexión a Kalshi por usuario, SOLO LECTURA (posiciones, saldo,
  operaciones), con la clave privada cifrada AES-256-GCM.
- Tablas `cev_users`, `cev_kalshi_connections`, `cev_user_data`
  (ver `server/schema.sql`).

### Paso pendiente de Luis: Neon + variables de entorno en Render
El código está listo, pero la base de datos de producción NO está
creada desde aquí (no hay acceso a la consola de Neon desde este
entorno y la cadena de Mercado Cuba no se toca). Pasos exactos:

1. **Neon (neon.tech, con su cuenta):** crea un proyecto nuevo
   llamado `cripto-en-vivo` (o, si prefiere, una base de datos nueva
   dentro del proyecto que ya usa para Mercado Cuba, separada de sus
   tablas). Copia su **cadena de conexión** (Connection Details).
   **No la pegues en el chat**: va directa al panel de Render.
2. **Render → servicio `cripto-en-vivo` → Environment:** añade
   estas variables (solo los nombres; los valores, en el panel):
   - `DATABASE_URL` = la cadena de conexión de Neon del paso 1.
   - `JWT_SECRET` = una cadena larga al azar (mínimo 32 caracteres;
     se puede generar con `openssl rand -hex 32` en su laptop).
   - `KALSHI_ENCRYPTION_KEY` = 64 caracteres hex al azar
     (`openssl rand -hex 32` en su laptop). Cifra las claves
     privadas de Kalshi de los usuarios.
   - `ADMIN_EMAIL` = su email (ej. el que usa en GitHub).
   - `ADMIN_PASSWORD` = una contraseña fuerte para el primer admin.
3. **Redespliega** (Manual Deploy → Deploy latest commit, o espera
   al redespliegue automático). Al arrancar, el servidor crea las
   tablas `cev_*` solo y crea el admin con `ADMIN_EMAIL` /
   `ADMIN_PASSWORD` (si aún no hay ningún admin).
4. Entra en https://cripto-en-vivo.onrender.com con ese email y esa
   contraseña, ve a **🛡️ Admin** y cambia tu contraseña. Después,
   **quita `ADMIN_PASSWORD` de las variables de entorno de Render**
   y redespliega una vez más (así la contraseña del admin no queda
   guardada en Render).
5. Sin `DATABASE_URL`, la app pública sigue funcionando igual
   (precios, señales, modo Kalshi virtual), pero los usuarios se
   guardan en un archivo local efímero: NO se debe usar así en
   producción. Con `DATABASE_URL` puesta, todo vive en Neon.

### Qué NO se puede hacer desde aquí (honestidad)
- Crear la base de Neon ni poner las variables en Render: hace
  falta la consola de Neon y el panel de Render de Luis.
- Probar con una cuenta real de Kalshi: no hay credenciales reales;
  la conexión se probó con una clave de prueba generada para el
  test (Kalshi la rechazó con 400, como debe ser, y no se guardó
  nada). La firma Ed25519 y RSA-PSS se verificaron con las claves
  públicas correspondientes.
- Probar los clics del frontend en un navegador real: el build pasa
  y la lógica se probó en Node con datos reales, pero la interacción
  (registro, panel admin, conectar Kalshi) debe confirmarla Luis en
  su navegador.

### Pruebas v12 (tests-v12.mjs, 37/37 con datos reales del servidor local)
Registro/login/JWT, email duplicado, contraseña corta, login con
clave mala, admin 403 para usuario normal, admin lista usuarios sin
`password_hash`, desactivar/reactivar, reset de contraseña, Kalshi
sin conectar, clave .pem inválida, clave de prueba rechazada por
Kalshi, cifrado AES-256-GCM (el blob no contiene el pem en claro),
firma Ed25519 y RSA-PSS verificadas, allowlist de solo 3 rutas
GET de Kalshi, y que no hay POST/PUT/DELETE a Kalshi en el servidor.
