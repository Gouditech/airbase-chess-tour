// ── NETTOYAGE DES ABONNEMENTS FANTOMES, SANS NOTIFIER PERSONNE ──
//
// Un abonnement "fantome" est une entree Firebase dont l'adresse push n'existe
// plus (donnees du navigateur effacees, app desinstallee, revocation systeme).
// Seul le service push (Google/Apple/Mozilla) sait qu'une adresse est morte : il
// repond 404 ou 410 quand on essaie de lui ecrire.
//
// Jusqu'ici ce nettoyage n'arrivait qu'a l'occasion d'un vrai envoi. Ici on
// interroge chaque abonnement avec un message a TTL 0 : le service push le
// rejette immediatement sans jamais le remettre a l'appareil — personne ne recoit
// rien — mais il repond quand meme 404/410 pour les adresses mortes.

const webpush = require('web-push');
const { fbRead, fbWrite } = require('./_shared/fb-auth.js');

const DB_URL = process.env.FIREBASE_DB_URL;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

function envFromUrl(url) {
  const isDev = (url || '').includes('dev--');
  return {
    isDev,
    subPath: isDev ? 'subscriptions-dev' : 'subscriptions',
    adminKey: isDev ? 'adminSubIdDev' : 'adminSubId'
  };
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

  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !DB_URL)
    return { statusCode: 200, headers, body: JSON.stringify({ code: 'no_config' }) };

  // Meme protection que les autres actions admin : le PIN est verifie cote serveur.
  let corps;
  try { corps = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON invalide' }) }; }

  const stored = await fbRead(DB_URL, 'adminPin').catch(() => null);
  if (!stored || String(stored) !== String(corps.pin || ''))
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'PIN invalide' }) };

  const origin = event.headers.origin || event.headers.referer || '';
  const { subPath, adminKey } = envFromUrl(origin);

  webpush.setVapidDetails('mailto:admin@airbasechesstour.app', VAPID_PUBLIC, VAPID_PRIVATE);

  const subsObj = await fbRead(DB_URL, subPath).catch(() => ({})) || {};
  const entrees = Object.entries(subsObj).filter(([, s]) => s && s.endpoint && s.keys);

  let vivants = 0, nettoyes = 0, adminNettoye = false;
  const adminSubId = await fbRead(DB_URL, 'settings/' + adminKey).catch(() => null);

  for (const [id, sub] of entrees) {
    try {
      // TTL 0 : le service push accepte, constate qu'il ne peut pas remettre le
      // message tout de suite, et le jette. Rien ne s'affiche sur l'appareil.
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
        JSON.stringify({ ping: true }),
        { TTL: 0, urgency: 'very-low' }
      );
      vivants++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await fbWrite(DB_URL, subPath + '/' + id, null).catch(() => {});
        nettoyes++;
        // Si le fantome etait l'appareil admin, retirer aussi le pointeur : sinon
        // il designe une entree supprimee et le site affiche "un autre appareil".
        if (adminSubId && id === adminSubId) {
          await fbWrite(DB_URL, 'settings/' + adminKey, null).catch(() => {});
          adminNettoye = true;
        }
      } else {
        // Erreur reseau ou autre : on ne supprime rien. Mieux vaut garder un
        // abonnement douteux que d'en perdre un valide.
        vivants++;
        console.log('[ABCT] Test inconcluant pour ' + id + ' : ' + (e.statusCode || e.message));
      }
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ code: 'done', total: entrees.length, alive: vivants, cleaned: nettoyes, adminCleared: adminNettoye })
  };
};
