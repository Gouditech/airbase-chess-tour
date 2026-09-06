// ── VÉRIFICATION DU PIN CÔTÉ SERVEUR ──
//
// Jusqu'ici le site lisait `adminPin` directement dans Firebase pour le comparer
// a la saisie. Deux problemes : le PIN etait lisible par n'importe qui, et cette
// lecture cessera de fonctionner des que les regles seront resserrees.
//
// Cette fonction fait la comparaison sur le serveur. Le PIN ne quitte jamais
// Firebase : le navigateur envoie ce que l'utilisateur a tape, et recoit
// seulement oui ou non.

const { fbRead, fbWrite } = require('./_shared/fb-auth.js');

const DB_URL = process.env.FIREBASE_DB_URL;

// Ralentissement volontaire : sans lui, un PIN a 4 chiffres se teste
// exhaustivement en quelques secondes. Avec 400 ms par essai, il faut plus
// d'une heure — et Netlify limite de son cote le nombre d'appels.
const DELAI_MS = 400;
const pause = ms => new Promise(r => setTimeout(r, ms));

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let corps;
  try { corps = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON invalide' }) }; }

  const { action, pin, newPin } = corps;
  if (!pin || typeof pin !== 'string')
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'PIN manquant' }) };

  await pause(DELAI_MS);

  try {
    const enregistre = await fbRead(DB_URL, 'adminPin');

    // Premiere utilisation : aucun PIN en base, on adopte celui qui est saisi.
    if (!enregistre) {
      await fbWrite(DB_URL, 'adminPin', pin);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, bootstrap: true }) };
    }

    if (String(enregistre) !== String(pin))
      return { statusCode: 200, headers, body: JSON.stringify({ ok: false }) };

    // PIN correct. S'agit-il d'un changement ?
    if (action === 'change') {
      if (!newPin || typeof newPin !== 'string' || newPin.length < 4)
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, raison: 'court' }) };
      await fbWrite(DB_URL, 'adminPin', newPin);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, change: true }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };

  } catch (e) {
    // Erreur serveur : on ne dit surtout pas "ok", sinon un incident reseau
    // ouvrirait l'admin a n'importe qui.
    console.log('[ABCT] Erreur verify-pin :', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'serveur' }) };
  }
};
