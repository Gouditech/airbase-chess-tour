// Firebase Messaging Service Worker
// Required by FCM for background push notifications
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyC-UUvxF0kaRGf-i_0uCUW9a_R4tohnrwM",
  authDomain: "airbaise-chess-tour.firebaseapp.com",
  databaseURL: "https://airbaise-chess-tour-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "airbaise-chess-tour",
  storageBucket: "airbaise-chess-tour.firebasestorage.app",
  messagingSenderId: "199106573652",
  appId: "1:199106573652:web:b96d49c1814d7a4f61c4c1"
});

const messaging = firebase.messaging();

// Handle background messages
messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Background message:', payload);
  const { title, body } = payload.notification || {};
  const notificationOptions = {
    body: body || '',
    icon: '/icon-192.jpg',
    badge: '/icon-192.jpg',
    vibrate: [200, 100, 200],
    tag: 'abct-notification',
    data: payload.fcmOptions?.link || 'https://airbasechesstour.netlify.app/'
  };
  return self.registration.showNotification(title || 'Air Base Chess Tour', notificationOptions);
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
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
