// Service worker de Cripto en Vivo — PWA mínima y honesta.
// HACE: cachear la app (HTML/CSS/JS/iconos) para que cargue rápido y
// se pueda instalar, y mostrar notificaciones LOCALES de alertas cuando
// la app se las pide (showNotification desde la página).
// NO HACE: push real desde un servidor. No hay VAPID, no hay backend
// de push y no hay suscripciones: en el plan gratis de Render no hay
// un servicio de push. Si la app está cerrada del todo, las alertas no
// llegan hasta que se vuelve a abrir. Ver README, sección PWA.
const CACHE = 'cripto-en-vivo-v7';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll([
      '/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg',
    ]).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // La API siempre va a la red (precios en vivo, nunca cacheados).
  if (url.pathname.startsWith('/api/')) return;
  // Solo GET y mismo origen.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      // Cache primero para la app, red en segundo plano para actualizar.
      return cached || network;
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
      return undefined;
    })
  );
});
