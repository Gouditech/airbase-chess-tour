const { runLateCheck } = require('./_shared/late-check-core.js');

const DB_URL = process.env.FIREBASE_DB_URL;

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

  let parsed;
  try {
    parsed = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Corps de requete invalide' }) };
  }
  const { pin } = parsed;
  if (!pin) return { statusCode: 400, headers, body: JSON.stringify({ error: 'PIN requis' }) };

  try {
    const storedPin = await getAdminPin();
    if (storedPin === null || storedPin === undefined)
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'adminPin absent de Firebase' }) };
    if (String(pin).trim() !== String(storedPin).trim())
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'PIN incorrect' }) };

    const h = event.headers || {};
    const origin = String(h.origin || h.referer || h.Origin || h.Referer || '');
    const result = await runLateCheck(origin);
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
