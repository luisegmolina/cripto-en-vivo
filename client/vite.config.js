import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En desarrollo el frontend corre en :5173 y el servidor en :3001.
// El proxy hace que /api/... vaya al servidor, así el navegador solo
// habla con localhost y nunca directo con los exchanges.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true, proxy: { '/api': 'http://localhost:3001' } },
  preview: { port: 4173, proxy: { '/api': 'http://localhost:3001' } },
});
