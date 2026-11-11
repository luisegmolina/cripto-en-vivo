// Función serverless de Vercel para /api/index (y como punto de entrada
// compartido). Reutiliza la misma app Express de server/app.js (la que
// usa el servidor local). Cada endpoint tiene además su propio archivo
// en api/ (health.js, ticker.js, markets.js, candles.js, debug.js):
// Vercel enruta /api/ticker a api/ticker.js, etc., y la app Express
// resuelve la ruta a partir de req.url. No hay rewrite: un rewrite a
// /api/index haría que la función viera "/api/index" y perdiera el
// endpoint original. No arranca ningún listener: Vercel invoca la app
// Express como handler por petición. En local NO se usa: ahí corre
// server/server.js en :3001.
const app = require('../server/app');

module.exports = app;
