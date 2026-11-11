import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// PWA: registra el service worker para poder instalar la app y recibir
// las notificaciones locales de alertas aunque la pestaña esté en
// segundo plano. NO es push real con servidor (ver README): sin VAPID
// ni backend de push, el service worker solo muestra notificaciones que
// la propia app le pide mientras está abierta o en segundo plano.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Si el SW no se puede registrar (p. ej. en desarrollo con proxy),
      // la app sigue funcionando igual; las notificaciones usan el
      // Notification clásico del navegador.
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
);
