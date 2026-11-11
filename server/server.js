// Servidor local Cripto en Vivo — Node + Express.
// Solo arranca el listener. Toda la app (rutas /api/*) vive en app.js,
// que también reutiliza la función serverless de Vercel (api/index.js).
const app = require('./app');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Cripto en Vivo — servidor en http://localhost:${PORT}`);
  console.log(`   Prueba: curl http://localhost:${PORT}/api/health`);
  console.log(`   Diagnóstico: curl http://localhost:${PORT}/api/debug`);
  console.log(`   Prueba: curl "http://localhost:${PORT}/api/ticker?symbol=BTC&currency=USD"`);
});
