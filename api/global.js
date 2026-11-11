// Endpoint /api/global en Vercel (capitalización total real de CoinGecko).
// Vercel enruta /api/global a este archivo y la app Express
// (server/app.js) resuelve la ruta a partir de req.url.
module.exports = require("../server/app");
