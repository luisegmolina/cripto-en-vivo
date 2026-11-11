// wait-for-server.js — espera a que el servidor responda /api/health
// antes de arrancar Vite. Sin esto hay una carrera: Vite queda listo en
// ~435 ms, antes que el servidor, y el proxy devuelve ECONNREFUSED en
// los primeros segundos (eso es normal, no un fallo de la app).
// Uso: node wait-for-server.js  (lo llama "npm run dev" automáticamente)
const port = process.env.PORT || 3001;
const url = `http://localhost:${port}/api/health`;
const started = Date.now();
const timeoutMs = 30000;

async function check() {
  try {
    const r = await fetch(url);
    if (r.ok) {
      console.log(`✅ Servidor responde en ${url} (${Date.now() - started} ms). Arrancando Vite…`);
      process.exit(0);
    }
  } catch {
    // Servidor aún no arriba: seguir esperando, sin ruido.
  }
  if (Date.now() - started > timeoutMs) {
    console.error(`❌ El servidor no respondió en ${url} en 30 s. ¿Arrancó? Mira la terminal del servidor.`);
    process.exit(1);
  }
  setTimeout(check, 500);
}

check();
