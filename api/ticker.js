// Endpoint /api/ticker en Vercel.
// Vercel enruta /api/ticker a este archivo y la app Express
// (server/app.js) resuelve la ruta a partir de req.url.
// No se usa rewrite: un rewrite a /api/index haría que la función
// viera "/api/index" y perdiera el endpoint original.
module.exports = require("../server/app");
