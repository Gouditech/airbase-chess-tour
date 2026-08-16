const webpush = require('web-push');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const DB_URL = process.env.FIREBASE_DB_URL;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

webpush.setVapidDetails(
  'mailto:airbasechesstour@gmail.com',
  VAPID_PUBLIC,
  VAPID_PRIVATE
);

// Get admin PIN from Firebase using service account
async function getAdminPin() {
  const { google } = require('googleapis');
  const jwtClient = new google.auth.JWT(
    CLIENT_EMAIL, null, PRIVATE_KEY,
    ['https://www.googleapis.com/auth/firebase.database']
  );
  const tokenRes = await jwtClient.getAccessToken();
  const res = await fetch(`${DB_URL}/adminPin.json?access_token=${tokenRes.token}`);
  return await res.json();
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const { pin, subscriptions, title, body } = JSON.parse(event.body || '{}');

  if (!pin) return { statusCode: 400, headers, body: JSON.stringify({ error: 'PIN required' }) };
  if (!subscriptions || !subscriptions.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No subscriptions' }) };

  try {
    const storedPin = await getAdminPin();
    if (String(pin) !== String(storedPin)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'PIN incorrect' }) };
    }

    const payload = JSON.stringify({
      title: title || 'Air Base Chess Tour',
      body: body || '',
      icon: '/icon-192.jpg',
      url: 'https://airbasechesstour.netlify.app/'
    });

    const results = { success: 0, failed: 0, errors: [] };

    for (const sub of subscriptions) {
      try {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys?.p256dh || '',
            auth: sub.keys?.auth || ''
          }
        };
        await webpush.sendNotification(pushSubscription, payload, { TTL: 86400, urgency: 'high' });
        results.success++;
      } catch(e) {
        results.failed++;
        results.errors.push(e.statusCode ? `${e.statusCode}: ${e.body}` : e.message);
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify(results) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
