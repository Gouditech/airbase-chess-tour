const webpush = require('web-push');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const DB_URL        = process.env.FIREBASE_DB_URL;

webpush.setVapidDetails('mailto:airbasechesstour@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);

// Les règles Firebase sont publiques en lecture/écriture -> pas besoin d'OAuth pour ces petits champs.
async function fbRead(path) {
  const res = await fetch(`${DB_URL}/${path}.json`);
  if (!res.ok) throw new Error('Lecture ' + path + ' impossible (HTTP ' + res.status + ')');
  return await res.json();
}
async function fbWrite(path, value) {
  await fetch(`${DB_URL}/${path}.json`, { method: 'PUT', body: JSON.stringify(value) });
}

async function getAdminPin() {
  return fbRead('adminPin');
}

async function sendToAll(subscriptions, title, body) {
  const payload = JSON.stringify({
    title: title || 'Air Base Chess Tour',
    body:  body  || '',
    icon:  '/icon-192.jpg',
    url:   'https://airbasechesstour.netlify.app/'
  });

  const results = { success: 0, failed: 0, expired: 0, errors: [] };

  for (const sub of subscriptions) {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      results.failed++;
      results.errors.push('abonnement incomplet (ancien format)');
      continue;
    }
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
        payload,
        { TTL: 86400, urgency: 'high' }
      );
      results.success++;
    } catch (e) {
      // 404/410 = abonnement expire ; 403 = mauvaise cle VAPID
      if (e.statusCode === 404 || e.statusCode === 410) {
        results.expired++;
        results.errors.push('410 abonnement expire');
      } else {
        results.failed++;
        results.errors.push((e.statusCode || '?') + ' ' + String(e.body || e.message).slice(0, 120));
      }
    }
  }
  return results;
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  if (!VAPID_PUBLIC || !VAPID_PRIVATE)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'VAPID keys manquantes cote Netlify' }) };

  let parsed;
  try {
    parsed = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Corps de requete invalide' }) };
  }
  const { type, pin, title, body, gameId, isFinal } = parsed;

  // ── Detection dev/prod par l'URL d'origine de la requete ──
  // Meme principe que IS_DEV cote site : aucun reglage a changer lors d'un merge,
  // le comportement suit automatiquement le domaine qui appelle.
  const h = event.headers || {};
  const origin = String(h.origin || h.referer || h.Origin || h.Referer || '');
  const IS_DEV = origin.includes('dev--');
  const SUB_PATH = IS_DEV ? 'subscriptions-dev' : 'subscriptions';

  try {
    // Le serveur va chercher LUI-MEME la liste d'abonnes du bon environnement.
    // La liste eventuellement envoyee par le client est ignoree : cela garantit
    // qu'une requete venant de dev ne peut jamais toucher les abonnes de prod.
    const subsObj = await fbRead(SUB_PATH).catch(() => ({}));
    const subscriptions = Object.values(subsObj || {}).filter(s => s && s.endpoint && s.keys);

    if (!subscriptions.length)
      return { statusCode: 200, headers, body: JSON.stringify({ skipped: 'aucun abonne', env: IS_DEV ? 'dev' : 'prod' }) };

    // ── Chemin automatique : declenche par un joueur (ou l'admin) qui entre un score.
    // Pas de PIN ici, mais le serveur revalide tout lui-meme : reglage admin, maintenance,
    // et construit le texte a partir du match reel (le client ne peut pas envoyer de texte libre).
    if (type === 'auto_result') {
      if (!gameId)
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'gameId requis' }) };

      // En cas de doute (erreur reseau/lecture), on bloque plutot que d'envoyer.
      const autoEnabled = await fbRead('settings/autoNotifyResults').catch(() => false);
      if (autoEnabled !== true)
        return { statusCode: 200, headers, body: JSON.stringify({ skipped: 'auto-notify desactive' }) };

      // Le mode maintenance protege les joueurs de PROD. Sur dev, on l'ignore
      // volontairement : c'est justement pendant la maintenance qu'on veut tester.
      const maint = await fbRead('maintenance').catch(() => true);
      if (maint === true && !IS_DEV)
        return { statusCode: 200, headers, body: JSON.stringify({ skipped: 'maintenance active' }) };

      const path = isFinal ? 'finals/' + gameId : 'games/' + gameId;
      const game = await fbRead(path).catch(() => null);
      if (!game)
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Match introuvable' }) };
      if (game.notified === true)
        return { statusCode: 200, headers, body: JSON.stringify({ skipped: 'deja notifie' }) };

      const p1 = isFinal ? game.player1 : game.playerWhite;
      const p2 = isFinal ? game.player2 : game.playerBlack;
      const sc1 = isFinal ? game.score1 : game.scoreWhite;
      const sc2 = isFinal ? game.score2 : game.scoreBlack;
      if (p1 == null || p2 == null || sc1 == null || sc2 == null)
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Score incomplet' }) };

      const tourName = await fbRead('settings/name').catch(() => null);
      let headline;
      if (sc1 > sc2) headline = `🏆 Victoire : ${p1}`;
      else if (sc2 > sc1) headline = `🏆 Victoire : ${p2}`;
      else headline = `🤝 Match nul`; // possible en poule (pas en finale)
      const autoBody = `${headline}\n${p1} ${sc1} — ${sc2} ${p2}`;

      // Marquer avant l'envoi pour eviter un double-envoi en cas d'appels rapproches.
      await fbWrite(path + '/notified', true);

      const eligible = subscriptions.filter(s => s?.prefs?.match !== false);
      if (!eligible.length)
        return { statusCode: 200, headers, body: JSON.stringify({ skipped: 'aucun abonne pour la categorie Match' }) };

      const results = await sendToAll(eligible, tourName || 'Air Base Chess Tour', autoBody);
      return { statusCode: 200, headers, body: JSON.stringify(results) };
    }

    // ── Chemin admin existant : message libre, protege par PIN ──
    if (!pin)
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'PIN requis' }) };

    const storedPin = await getAdminPin();
    if (storedPin === null || storedPin === undefined)
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'adminPin absent de Firebase' }) };

    if (String(pin).trim() !== String(storedPin).trim())
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'PIN incorrect' }) };

    // Respecte la preference "annonces officielles" cote serveur aussi (le site filtre
    // deja avant l'envoi, mais la preference du joueur doit etre honoree a la source).
    const eligibleOfficiel = subscriptions.filter(s => s?.prefs?.officiel !== false);
    if (!eligibleOfficiel.length)
      return { statusCode: 200, headers, body: JSON.stringify({ skipped: 'aucun abonne pour la categorie Officiel' }) };

    const results = await sendToAll(eligibleOfficiel, title, body);
    return { statusCode: 200, headers, body: JSON.stringify(results) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
