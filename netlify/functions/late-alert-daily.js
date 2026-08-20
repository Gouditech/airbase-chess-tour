const { schedule } = require('@netlify/functions');
const webpush = require('web-push');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const DB_URL         = process.env.FIREBASE_DB_URL;
const SITE_URL        = process.env.URL || process.env.DEPLOY_PRIME_URL || '';
const IS_DEV           = SITE_URL.includes('dev--');
const SUB_PATH           = IS_DEV ? 'subscriptions-dev' : 'subscriptions';

webpush.setVapidDetails('mailto:airbasechesstour@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);

async function fbRead(path) {
  const res = await fetch(`${DB_URL}/${path}.json`);
  if (!res.ok) throw new Error('Lecture ' + path + ' impossible (HTTP ' + res.status + ')');
  return await res.json();
}
async function fbWrite(path, value) {
  await fetch(`${DB_URL}/${path}.json`, { method: 'PUT', body: JSON.stringify(value) });
}

// ── Logique de date partagee avec le site : voir match-dates.js a la racine du depot.
// C'est le SEUL endroit ou cette logique est definie (ne pas la recopier ici).
const { isMatchLate } = require('../../match-dates.js');

async function runCheck() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !DB_URL) {
    console.log('Config manquante (VAPID/DB_URL) — abandon.');
    return;
  }

  // En cas de doute (erreur de lecture), on bloque plutot que d'envoyer.
  const autoOn = await fbRead('settings/autoNotifyLateAlerts').catch(() => false);
  if (autoOn !== true) { console.log('Alerte retard desactivee par l\'admin.'); return; }

  const maint = await fbRead('maintenance').catch(() => true);
  if (maint === true && !IS_DEV) { console.log('Mode maintenance actif — alerte suspendue.'); return; }

  const adminSubId = await fbRead('settings/' + (IS_DEV ? 'adminSubIdDev' : 'adminSubId')).catch(() => null);
  if (!adminSubId) { console.log('Aucun appareil admin enregistre.'); return; }

  const adminSub = await fbRead(SUB_PATH + '/' + adminSubId).catch(() => null);
  if (!adminSub?.endpoint || !adminSub?.keys?.p256dh || !adminSub?.keys?.auth) {
    console.log('Abonnement admin introuvable ou invalide.');
    return;
  }

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
  const lastPing = await fbRead('settings/lastLateAlertPing').catch(() => 0);
  const daysSincePing = (Date.now() - (lastPing || 0)) / (1000 * 60 * 60 * 24);

  if (!total) {
    // Rien à signaler : silence, sauf une "preuve de vie" hebdomadaire pour éviter
    // qu'un abonnement admin mort ne passe inaperçu pendant des semaines.
    if (daysSincePing >= 7) {
      const payload = JSON.stringify({
        title: (settings.name || 'Air Base Chess Tour') + ' — Admin',
        body: '✅ Alerte retard active — aucun match en retard actuellement.',
        icon: '/icon-192.jpg',
        url: IS_DEV ? 'https://dev--airbasechesstour.netlify.app/' : 'https://airbasechesstour.netlify.app/'
      });
      try {
        await webpush.sendNotification(
          { endpoint: adminSub.endpoint, keys: { p256dh: adminSub.keys.p256dh, auth: adminSub.keys.auth } },
          payload,
          { TTL: 86400, urgency: 'low' }
        );
        await fbWrite('settings/lastLateAlertPing', Date.now());
        console.log('Preuve de vie hebdomadaire envoyee.');
      } catch (e) {
        console.log('Echec preuve de vie :', e.message);
      }
    } else {
      console.log('Aucun match en retard aujourd\'hui.');
    }
    return;
  }

  let body = `⏰ ${total} match${total > 1 ? 's' : ''} en retard\n`;
  lateGames.slice(0, 8).forEach(g => { body += `• ${g.playerWhite} vs ${g.playerBlack} (${g.group})\n`; });
  lateFinals.slice(0, 8).forEach(f => { body += `• ${f.player1} vs ${f.player2} (${f.round})\n`; });
  if (total > 8) body += `… et ${total - 8} de plus`;

  const payload = JSON.stringify({
    title: (settings.name || 'Air Base Chess Tour') + ' — Admin',
    body: body.trim(),
    icon: '/icon-192.jpg',
    url: (IS_DEV ? 'https://dev--airbasechesstour.netlify.app/' : 'https://airbasechesstour.netlify.app/')
  });

  try {
    await webpush.sendNotification(
      { endpoint: adminSub.endpoint, keys: { p256dh: adminSub.keys.p256dh, auth: adminSub.keys.auth } },
      payload,
      { TTL: 86400, urgency: 'high' }
    );
    await fbWrite('settings/lastLateAlertPing', Date.now());
    console.log(`Alerte envoyee : ${total} match(s) en retard.`);
  } catch (e) {
    console.log('Echec envoi alerte admin :', e.message);
  }
}

// 6h07 UTC ~ 7-8h du matin en Suisse selon la saison. Ajustable ici si besoin.
exports.handler = schedule('7 6 * * *', async () => {
  try {
    await runCheck();
  } catch (e) {
    console.log('Erreur alerte retard (non bloquant) :', e.message);
  }
  return { statusCode: 200 };
});
