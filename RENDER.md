# Desplegar GRATIS en Render — Cripto en Vivo

> Estado (2026-11-11): el proyecto está **listo** (probado en modo
> producción: `npm start` sirve la app, `/api/health` OK, BTC $73,430.65
> vía Coinbase). Falta solo que Luis haga los pasos 1 y 3, porque
> necesitan su cuenta de GitHub y su cuenta de Render. Nada de esto
> cuesta dinero: repo privado en GitHub gratis, plan Free en Render,
> sin tarjeta.

## Paso 1 — Crear el repositorio en GitHub (Luis, 1 minuto)

El conector de Muse **no puede crear repositorios** (GitHub devuelve
`403 Resource not accessible by integration`). Por eso este paso lo
hace Luis en el navegador:

1. Entra a https://github.com/new
2. **Repository name:** `cripto-en-vivo`
3. **Private** (privado vale, Render lo lee igual).
4. **NO** marques "Add a README file" ni ".gitignore" ni licencia.
   Tiene que quedar vacío.
5. Pulsa **Create repository**.

## Paso 2 — Subir el código al repo (Muse, cuando el repo exista)

Cuando el repo `luisegmolina/cripto-en-vivo` exista y esté vacío,
Muse lo sube con el conector de GitHub (archivos de esta carpeta,
sin `node_modules` ni `client/dist`, que Render reconstruye solo).
Si Luis prefiere subirlo él desde su laptop, en la carpeta del
proyecto:

```bash
git init
git add .
git commit -m "Cripto en Vivo v6 — lista para Render"
git branch -M main
git remote add origin https://github.com/luisegmolina/cripto-en-vivo.git
git push -u origin main
```

## Paso 3 — Crear la cuenta gratis de Render y el servicio (Luis)

1. Entra a https://render.com y crea una cuenta gratis
   (con GitHub es lo más rápido: "Sign up with GitHub").
2. En el panel de Render: **New → Web Service**.
3. Conecta el repositorio `luisegmolina/cripto-en-vivo`
   (si Render pide permiso a GitHub, acéptalo).
4. Render detecta el archivo `render.yaml` de este proyecto y
   rellena todo solo:
   - **Name:** `cripto-en-vivo`
   - **Build Command:** `npm run install:all && npm run build`
   - **Start Command:** `npm start`
   - **Plan:** Free (gratis, sin tarjeta)
5. Pulsa **Create Web Service** y espera a que termine el primer
   despliegue (unos 2-4 minutos la primera vez).

## Paso 4 — Comprobar que está en vivo

La URL será:

```
https://cripto-en-vivo.onrender.com
```

Comprobaciones (desde cualquier navegador o terminal):

- `https://cripto-en-vivo.onrender.com/` → tiene que cargar la app.
- `https://cripto-en-vivo.onrender.com/api/health` → `{"ok":true,...}`
- `https://cripto-en-vivo.onrender.com/api/ticker?symbol=BTC&currency=USD`
  → precio real de BTC con `"source":"Coinbase"`.

## Limitaciones del plan Free de Render

- **Se duerme tras ~15 minutos sin visitas.** La primera visita
  después de un rato tarda unos **50 segundos** en despertar; luego
  va normal. No es un fallo, es el plan gratis.
- 750 horas al mes gratis (suficiente para una instancia).
- Sin tarjeta, sin coste. El dominio propio se puede añadir después
  en Render sin coste extra (el dominio en sí se compra aparte,
  ~$10-15/año un .com).

## Si algo falla en Render

- En el panel de Render, el servicio tiene pestañas **Logs** y
  **Events**: ahí se ve si falló el build o el arranque.
- Errores típicos: si el build falla por dependencias, revisa que
  `package.json` de la raíz, `server/` y `client/` estén en el repo.
- El servidor usa el puerto que Render asigna con la variable `PORT`
  (ya está así en `server/server.js`), no hay que cambiar nada.
