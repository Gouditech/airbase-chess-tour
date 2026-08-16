const { google } = require('googleapis');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const DB_URL = process.env.FIREBASE_DB_URL;

async function getAccessToken() {
  const jwtClient = new google.auth.JWT(
    CLIENT_EMAIL, null, PRIVATE_KEY,
    ['https://www.googleapis.com/auth/firebase.messaging',
     'https://www.googleapis.com/auth/firebase.database',
     'https://www.googleapis.com/auth/userinfo.email']
  );
  const tokens = await jwtClient.authorize();
  return { accessToken: tokens.access_token, jwtClient };
}

async function getAdminPin(jwtClient) {
  const tokenRes = await jwtClient.getAccessToken();
  const url = `${DB_URL}/adminPin.json?access_token=${tokenRes.token}`;
  const res = await fetch(url);
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

  const { pin, tokens, title, body } = JSON.parse(event.body || '{}');

  if (!pin) return { statusCode: 400, headers, body: JSON.stringify({ error: 'PIN required' }) };
  if (!tokens || !tokens.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No tokens' }) };

  try {
    const { accessToken, jwtClient } = await getAccessToken();

    // Verify PIN
    const storedPin = await getAdminPin(jwtClient);
    if (String(pin) !== String(storedPin)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'PIN incorrect' }) };
    }

    const results = { success: 0, failed: 0, errors: [] };

    for (const token of tokens) {
      try {
        const response = await fetch(
          `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                token,
                notification: { title, body },
                webpush: {
                  notification: {
                    title, body,
                    icon: 'https://airbasechesstour.netlify.app/icon-192.jpg',
                    badge: 'https://airbasechesstour.netlify.app/icon-192.jpg',
                    vibrate: [200, 100, 200],
                    tag: 'abct-notification'
                  },
                  fcm_options: { link: 'https://airbasechesstour.netlify.app/' }
                }
              }
            })
          }
        );
        const responseData = await response.json();
        if (response.ok) {
          results.success++;
        } else {
          results.failed++;
          results.errors.push(responseData?.error?.message || JSON.stringify(responseData));
        }
      } catch(e) {
        results.failed++;
        results.errors.push(e.message);
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify(results) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message, stack: e.stack }) };
  }
};
