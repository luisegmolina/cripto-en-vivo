// Servidor local Cripto en Vivo — Node + Express.
// Solo arranca el listener. Toda la app (rutas /api/*) vive en app.js,
// que también reutiliza la función serverless de Vercel (api/index.js).
const app = require('./app');

// v15.2: un rechazo de promesa no capturado se registra en vez de tumbar el
// proceso (Node >= 15 lo hace por defecto). Las rutas ya llevan su red de
// seguridad (routes.js), esto cubre el resto.
process.on('unhandledRejection', (reason) => {
  console.log('[server] unhandledRejection:', reason && reason.message ? reason.message : reason);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Cripto en Vivo — servidor en http://localhost:${PORT}`);
  console.log(`   Prueba: curl http://localhost:${PORT}/api/health`);
  console.log(`   Diagnóstico: curl http://localhost:${PORT}/api/debug`);
  console.log(`   Prueba: curl "http://localhost:${PORT}/api/ticker?symbol=BTC&currency=USD"`);
});
