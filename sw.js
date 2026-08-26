// Air Base Chess Tour — Service Worker
const CACHE_NAME = 'abct-v6';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(['/', '/index.html', '/match-dates.js']).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // cache:'no-store' force le navigateur à ignorer complètement son propre cache HTTP
  // (distinct du cache du service worker) et à toujours revérifier auprès du serveur —
  // c'est ce qui causait le "une fois sur deux" : sans ça, fetch() pouvait resservir une
  // copie déjà téléchargée selon sa fraîcheur, même en "essayant le réseau en premier".
  // Pas de repli sur le cache en cas d'échec : toujours la dernière version, jamais une
  // version périmée qui se ferait passer pour la version actuelle.
  //
  // Une seule nouvelle tentative après une courte pause si le réseau échoue franchement :
  // à l'ouverture d'une app installée, la connexion peut ne pas être encore tout à fait
  // prête une fraction de seconde, ce qui donnait une page d'erreur du navigateur au lieu
  // du site. Cette tentative reste, elle aussi, en no-store — jamais de repli sur une
  // copie en cache, juste une seconde chance donnée au réseau.
  event.respondWith(
    fetch(event.request, { cache: 'no-store' }).catch(() =>
      new Promise(resolve => setTimeout(resolve, 1200)).then(() =>
        fetch(event.request, { cache: 'no-store' })
      )
    )
  );
});

self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Air Base Chess Tour';
  const options = {
    body: data.body || 'Nouveau message du tournoi',
    icon: data.icon || '/icon-192.jpg',
    badge: '/icon-192.jpg',
    data: data.url || 'https://airbasechesstour.netlify.app/',
    vibrate: [200, 100, 200],
    tag: 'abct-notification',
    requireInteraction: true,
    renotify: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data || 'https://airbasechesstour.netlify.app/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
