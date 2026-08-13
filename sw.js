// Air Base Chess Tour — Service Worker
// Handles push notifications and offline caching

const CACHE_NAME = 'abct-v2';

// Install: cache the app
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll([
        '/airbase-chess-tour/',
        '/airbase-chess-tour/index.html'
      ]).catch(() => {
        // Ignore cache errors
      });
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: serve from cache when offline
self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Push notification received
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Air Base Chess Tour';
  const options = {
    body: data.body || 'Nouveau message du tournoi',
    icon: data.icon || '/airbase-chess-tour/icon-192.jpg',
    badge: data.badge || '/airbase-chess-tour/icon-192.jpg',
    data: data.url || '/airbase-chess-tour/',
    vibrate: [200, 100, 200],
    requireInteraction: false,
    tag: 'abct-notification'
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Notification clicked
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data || '/airbase-chess-tour/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
