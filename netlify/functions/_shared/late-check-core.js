// ═══════════════════════════════════════════════════════════════════
// Air Base Chess Tour — logique partagée de verification des retards
//
// Utilisee par :
//   • netlify/functions/late-alert-daily.js  (programmee, 1x/jour)
//   • netlify/functions/check-late-now.js    (declenchee par l'admin,
//     pour tester sans attendre le lendemain)
//
// Vit a la racine du depot (comme match-dates.js) pour ne jamais etre
// confondue avec une fonction Netlify a part entiere.
// ═══════════════════════════════════════════════════════════════════

const webpush = require('web-push');
const { isMatchLate } = require('../../../match-dates.js');

const DB_URL = process.env.FIREBASE_DB_URL;

function envFromUrl(url) {
  const isDev = (url || '').includes('dev--');
  return {
    isDev,
    subPath: isDev ? 'subscriptions-dev' : 'subscriptions',
    adminKey: isDev ? 'adminSubIdDev' : 'adminSubId'
  };
}

async function fbRead(path) {
  const res = await fetch(`${DB_URL}/${path}.json`);
  if (!res.ok) throw new Error('Lecture ' + path + ' impossible (HTTP ' + res.status + ')');
  return await res.json();
}
async function fbWrite(path, value) {
  await fetch(`${DB_URL}/${path}.json`, { method: 'PUT', body: JSON.stringify(value) });
}

// siteUrl sert uniquement a detecter dev/prod (voir envFromUrl). Retourne toujours
// un resultat structure { sent, total?, reason }, jamais une exception non geree.
async function runLateCheck(siteUrl) {
  const { isDev, subPath, adminKey } = envFromUrl(siteUrl);

  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !DB_URL)
    return { sent: false, reason: 'config manquante (VAPID/DB_URL) cote Netlify' };

  const autoOn = await fbRead('settings/autoNotifyLateAlerts').catch(() => false);
  if (autoOn !== true) return { sent: false, reason: 'Alerte automatique désactivée (case à cocher dans Réglages)' };

  const maint = await fbRead('maintenance').catch(() => true);
  if (maint === true && !isDev) return { sent: false, reason: 'Mode maintenance actif — alerte suspendue' };

  const adminSubId = await fbRead('settings/' + adminKey).catch(() => null);
  if (!adminSubId) return { sent: false, reason: 'Aucun appareil admin enregistré' };

  const adminSub = await fbRead(subPath + '/' + adminSubId).catch(() => null);
  if (!adminSub?.endpoint || !adminSub?.keys?.p256dh || !adminSub?.keys?.auth)
    return { sent: false, reason: 'Abonnement admin introuvable ou invalide' };

  const [settings, gamesObj, finalsObj] = await Promise.all([
    fbRead('settings').catch(() => ({})),
    fbRead('games').catch(() => ({})),
    fbRead('finals').catch(() => ({}))
  ]);
  const games = Object.values(gamesObj || {});
  const finals = Object.values(finalsObj || {});

  const lateGames = games.filter(g => {
    const played = g.scoreWhite !== null && g.scoreWhite !== undefined;
    return !played && isMatchLate(g, false, settings, finals);
  });
  const lateFinals = finals.filter(f => {
    const played = f.score1 !== null && f.score1 !== undefined;
    const isPresential = f.round === 'Demis' || f.round === 'Finale';
    return !played && !isPresential && f.player1 && f.player2 && isMatchLate(f, true, settings, finals);
  });
  const total = lateGames.length + lateFinals.length;

  webpush.setVapidDetails('mailto:airbasechesstour@gmail.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  async function send(body, urgency) {
    const payload = JSON.stringify({
      title: (settings.name || 'Air Base Chess Tour') + ' — Admin',
      body,
      icon: '/icon-192.jpg',
      url: isDev ? 'https://dev--airbasechesstour.netlify.app/' : 'https://airbasechesstour.netlify.app/'
    });
    await webpush.sendNotification(
      { endpoint: adminSub.endpoint, keys: { p256dh: adminSub.keys.p256dh, auth: adminSub.keys.auth } },
      payload, { TTL: 86400, urgency }
    );
  }

  if (!total) {
    // La preuve de vie hebdomadaire n'a de sens QUE si un match pourrait etre en retard.
    // Hors phase de jeu (inscriptions ouvertes, tournoi termine), elle n'apporte rien et
    // devient du bruit. Les vraies alertes de retard, elles, ne sont jamais bridees.
    const enJeu = settings.status === 'playing' || settings.status === 'finals';
    if (!enJeu) {
      return { sent: false, total: 0, reason: 'Tournoi hors phase de jeu (statut: ' + (settings.status || 'inconnu') + ') — preuve de vie inutile' };
    }
    const lastPing = await fbRead('settings/lastLateAlertPing').catch(() => 0);
    const daysSincePing = (Date.now() - (lastPing || 0)) / (1000 * 60 * 60 * 24);
    if (daysSincePing >= 7) {
      await send('✅ Alerte retard active — aucun match en retard actuellement.', 'low');
      await fbWrite('settings/lastLateAlertPing', Date.now());
      return { sent: true, total: 0, reason: 'Aucun retard — preuve de vie hebdomadaire envoyée' };
    }
    return { sent: false, total: 0, reason: 'Aucun match en retard actuellement (rien à envoyer)' };
  }

  let body = `⏰ ${total} match${total > 1 ? 's' : ''} en retard\n`;
  lateGames.slice(0, 8).forEach(g => { body += `• ${g.playerWhite} vs ${g.playerBlack} (${g.group})\n`; });
  lateFinals.slice(0, 8).forEach(f => { body += `• ${f.player1} vs ${f.player2} (${f.round})\n`; });
  if (total > 8) body += `… et ${total - 8} de plus`;

  await send(body.trim(), 'high');
  await fbWrite('settings/lastLateAlertPing', Date.now());
  return { sent: true, total, reason: total + ' match(s) en retard — notification envoyée à l\'appareil admin' };
}

module.exports = { runLateCheck };
