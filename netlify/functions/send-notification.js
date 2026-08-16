const webpush = require('web-push');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const DB_URL        = process.env.FIREBASE_DB_URL;

webpush.setVapidDetails('mailto:airbasechesstour@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);

// Les règles Firebase sont publiques en lecture -> pas besoin d'OAuth pour lire le PIN.
async function getAdminPin() {
  const res = await fetch(`${DB_URL}/adminPin.json`);
  if (!res.ok) throw new Error('Lecture adminPin impossible (HTTP ' + res.status + ')');
  return await res.json();
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

  const { pin, subscriptions, title, body } = JSON.parse(event.body || '{}');

  if (!pin)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'PIN requis' }) };
  if (!Array.isArray(subscriptions) || !subscriptions.length)
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Aucun abonne' }) };

  try {
    const storedPin = await getAdminPin();
    if (storedPin === null || storedPin === undefined)
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'adminPin absent de Firebase' }) };

    if (String(pin).trim() !== String(storedPin).trim())
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'PIN incorrect' }) };

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

    return { statusCode: 200, headers, body: JSON.stringify(results) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
