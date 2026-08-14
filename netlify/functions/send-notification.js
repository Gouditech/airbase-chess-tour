const { google } = require('googleapis');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const ADMIN_SECRET = process.env.ADMIN_SECRET;

async function getAccessToken() {
  const jwtClient = new google.auth.JWT(
    CLIENT_EMAIL, null, PRIVATE_KEY,
    ['https://www.googleapis.com/auth/firebase.messaging']
  );
  const tokens = await jwtClient.authorize();
  return tokens.access_token;
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const { secret, tokens, title, body } = JSON.parse(event.body || '{}');

  if (!secret || secret !== ADMIN_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!tokens || !tokens.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No tokens provided' }) };
  }

  try {
    const accessToken = await getAccessToken();
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
                  fcm_options: {
                    link: 'https://airbasechesstour.netlify.app/'
                  }
                }
              }
            })
          }
        );
        if (response.ok) results.success++;
        else {
          const err = await response.json();
          results.failed++;
          results.errors.push(err?.error?.message || 'Unknown');
        }
      } catch(e) {
        results.failed++;
        results.errors.push(e.message);
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify(results) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
