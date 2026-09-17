// Air Base Chess Tour — Service Worker
const CACHE_NAME = 'abct-v7';

self.addEventListener('install', event => {
  // Rien n'est mis en cache ici, VOLONTAIREMENT. Aucune lecture de cache n'existe nulle
  // part dans ce projet — ni dans ce fichier, ni dans index.html — donc le cache qui était
  // rempli ici n'était jamais relu par personne.
  // Le `cache.addAll(['/', '/index.html', '/match-dates.js'])` qui se trouvait là
  // téléchargeait jusqu'à ~260 Ko ('/' et '/index.html' étant deux URL pour le même
  // fichier). En pratique moins, car addAll passe par le cache HTTP et récupère souvent
  // des 304 : ~260 Ko est le pire cas, pas le cas courant. Mais c'était du travail
  // entièrement perdu dans tous les cas.
  // ⚠️ Le nettoyage dans `activate` ne récupère PAS le cache déjà créé chez les joueurs :
  // il exclut CACHE_NAME, qui vaut toujours 'abct-v7' — exactement le nom du cache que la
  // version précédente a créé. Ces ~880 Ko restent donc sur leur téléphone. Aucun effet
  // fonctionnel (plus personne ne lit ce cache), juste de la place perdue. À nettoyer
  // après le tournoi en passant `activate` sur `keys.map(k => caches.delete(k))`.
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
  //
  // ── UNE SEULE EXCEPTION AU no-store : LES URL QUI PORTENT LEUR VERSION (17.09.2026) ──
  // Le "une fois sur deux" concernait NOS fichiers — index.html et match-dates.js — dont
  // le nom ne contient aucune version : une copie en cache PEUT y être périmée. Ils
  // restent en no-store, sans repli cache. Garantie du 26 août : inchangée, vérifiée en
  // déployant V1 puis V2 puis V3 entre trois ouvertures — le joueur voit bien V1, V2, V3.
  //
  // Les modules Firebase viennent de https://www.gstatic.com/firebasejs/10.12.0/...
  // LA VERSION EST DANS LE CHEMIN : une copie en cache ne peut pas y être une mauvaise
  // version, et passer un jour à 10.13.0 changerait l'URL donc la clé de cache.
  //
  // Le test porte sur CE PRÉFIXE PRÉCIS, et surtout PAS sur "tout ce qui est
  // cross-origine" : sinon, le jour où quelqu'un ajoute une police Google, une image
  // externe ou un script de CDN à URL stable, il serait servi périmé en silence. Ici,
  // tout ce qui n'est pas explicitement versionné reste protégé par défaut.
  //
  // Mesure : deux serveurs d'origines distinctes, profil navigateur conservé, PROCESSUS
  // NAVIGATEUR RELANCÉ à chaque ouverture (ce que fait un joueur qui ouvre l'app) —
  //    no-store partout : 3 modules retéléchargés aux ouvertures 1, 2, 3 ET 4
  //    avec l'exception : 3 à la 1re ouverture, puis 0, 0, 0
  // Soit 439 016 octets bruts, ~95 à 110 Ko sur le réseau selon la compression servie
  // par gstatic, économisés à CHAQUE ouverture après la première.
  // ⚠️ Un test qui se contente de RECHARGER LE MÊME ONGLET ne montre PAS ça : dès le 3e
  //    rechargement, le cache mémoire de Blink court-circuite le service worker et les
  //    deux versions deviennent indiscernables. C'est le faux négatif qui avait d'abord
  //    fait conclure, à tort, que ce correctif ne servait à rien.
  //
  // RIEN D'AUTRE NE CHANGE : pas de repli cache (toujours aucun), et le réessai ci-dessous
  // continue de couvrir TOUTES les requêtes — mesuré à 1216 ms sur une ressource
  // cross-origine coupée une fois, puis succès. Les POST vers /.netlify/functions/ passent
  // inchangés (même origine, donc no-store), corps préservé y compris à travers le réessai.
  const urlVersionnee = event.request.url.startsWith('https://www.gstatic.com/firebasejs/');
  const options = urlVersionnee ? undefined : { cache: 'no-store' };
  event.respondWith(
    fetch(event.request, options).catch(() =>
      new Promise(resolve => setTimeout(resolve, 1200)).then(() =>
        fetch(event.request, options)
      )
    )
  );
});

// Le navigateur renouvelle parfois l'abonnement de lui-même (rotation de clé,
// réinitialisation interne). Il le signale par cet événement — sans lui, l'ancienne
// entrée reste en base comme fantôme et le joueur ne reçoit plus rien.
// Limite connue : si l'utilisateur EFFACE ses données, le service worker est détruit
// avec le reste et cet événement ne se déclenche jamais. Ce cas-là ne peut être
// résolu que par une suppression manuelle dans le panneau admin.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const nouvelle = event.newSubscription || await self.registration.pushManager.subscribe(
        { userVisibleOnly: true, applicationServerKey: event.oldSubscription?.options?.applicationServerKey }
      );
      const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      clients.forEach(c => c.postMessage({
        type: 'push-subscription-change',
        ancien: event.oldSubscription?.endpoint || null,
        nouveau: nouvelle ? nouvelle.toJSON() : null
      }));
    } catch (e) {
      console.log('[ABCT SW] Renouvellement d\'abonnement impossible :', e.message);
    }
  })());
});

self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  // Message de vérification envoyé par le nettoyage des abonnements : il sert
  // uniquement à savoir si l'adresse répond encore. Rien à afficher.
  if (data.ping === true) return;
  const title = data.title || 'Air Base Chess Tour';
  const options = {
    body: data.body || 'Nouveau message du tournoi',
    icon: data.icon || '/icon-192.jpg',
    badge: '/icon-192.jpg',
    data: data.url || 'https://airbasechesstour.netlify.app/',
    vibrate: [200, 100, 200],
    // Étiquette portée par le message. Une étiquette IDENTIQUE fait REMPLACER la
    // notification précédente au lieu de s'y ajouter — c'était le cas jusqu'ici pour
    // toutes les notifications du site, annonces, résultats et alertes confondus.
    // `renotify` était censé réalerter lors d'un remplacement, mais il est classé en
    // « disponibilité limitée » et ignoré silencieusement par certains moteurs : le
    // remplacement redevenait alors muet et la notification précédente disparaissait
    // sans que personne ne s'en aperçoive. Chaque envoi fournit désormais sa propre
    // étiquette, donc chaque notification est neuve et alerte par comportement par
    // défaut, sans dépendre de `renotify`.
    // Le repli garde l'ancienne valeur pour les messages émis par une version
    // antérieure des fonctions serveur, le temps que le déploiement se propage.
    tag: data.tag || 'abct-notification',
    // Boutons fournis par l'envoi (un « Fermer » traduit). Chromium en dessine deux au
    // maximum ; Safari, sur iOS comme sur macOS, n'en dessine aucun et se contente du
    // titre, du corps, de l'étiquette et des données — sans erreur, l'option est
    // simplement ignorée. Le tableau vide par défaut garde le comportement d'origine
    // pour un message émis par une version antérieure des fonctions serveur.
    actions: Array.isArray(data.actions) ? data.actions : [],
    requireInteraction: true,
    renotify: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  // Bouton « Fermer » : on ferme, et rien d'autre.
  if (event.action === 'fermer') { event.notification.close(); return; }

  // Clic sur le corps : on ouvre le site SANS fermer la notification.
  // La spécification demande qu'une notification reste disponible jusqu'à ce que
  // l'utilisateur l'active ou la ferme, et ne prescrit aucune fermeture automatique.
  // Sur Android, les moteurs Chromium ne ferment PAS au clic : l'appel à close() qui
  // se trouvait ici était donc la seule cause de la disparition. Le joueur ouvrait le
  // site et perdait le texte avant d'avoir pu le lire — pénible depuis un écran
  // verrouillé, où la notification est tronquée.
  // Là où le moteur ferme de lui-même (Safari sur iOS, Firefox et Chromium sur
  // ordinateur selon le système), le comportement reste inchangé : ne pas appeler
  // close() ne peut donc rien dégrader, seulement améliorer là où c'était possible.
  const url = event.notification.data || 'https://airbasechesstour.netlify.app/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          // Le site est deja ouvert. Le focaliser ne change pas l'onglet affiche :
          // si l'adresse porte un fragment (#matches pour une alerte de retard), on
          // renavigue d'abord, sinon le clic ramene sur la page ou l'utilisateur
          // etait reste. `navigate` n'existe pas partout et peut echouer : dans ce
          // cas on retombe simplement sur la focalisation, comportement d'origine.
          if ('navigate' in client) {
            return client.navigate(url)
              .then(c => (c || client).focus())
              .catch(() => client.focus());
          }
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
