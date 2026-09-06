// ── ACCÈS AUTHENTIFIÉ À FIREBASE (côté serveur) ──
//
// Jusqu'ici les fonctions appelaient la base "à nu", exactement comme le ferait
// un robot. Une fois les règles resserrées, elles seraient bloquées avec lui.
//
// Ce module signe un jeton OAuth2 à partir du compte de service Firebase
// (variables FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY déjà présentes sur
// Netlify) et l'ajoute à chaque appel. Un compte de service passe AU-DESSUS des
// règles : les fonctions garderont donc l'accès même quand tout sera fermé.
//
// Aucune dépendance ajoutée : la signature RS256 utilise le module `crypto`
// intégré à Node.

const crypto = require('crypto');

const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
// La clé est stockée avec des \n littéraux dans la variable d'environnement.
const PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const SCOPES = [
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/userinfo.email'
].join(' ');

// Le jeton vaut 1 h : on le garde en mémoire pour ne pas le refabriquer à chaque appel.
let jetonCache = null;
let jetonExpire = 0;

function base64url(x) {
  return Buffer.from(x).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function obtenirJeton() {
  if (jetonCache && Date.now() < jetonExpire - 60000) return jetonCache;
  if (!CLIENT_EMAIL || !PRIVATE_KEY) return null;

  const maintenant = Math.floor(Date.now() / 1000);
  const entete = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const corps = base64url(JSON.stringify({
    iss: CLIENT_EMAIL,
    scope: SCOPES,
    aud: 'https://oauth2.googleapis.com/token',
    iat: maintenant,
    exp: maintenant + 3600
  }));

  const signature = crypto.sign('RSA-SHA256', Buffer.from(entete + '.' + corps), PRIVATE_KEY)
    .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: entete + '.' + corps + '.' + signature
    })
  });
  if (!res.ok) throw new Error('Jeton refusé (HTTP ' + res.status + ')');

  const data = await res.json();
  jetonCache = data.access_token;
  jetonExpire = Date.now() + (data.expires_in || 3600) * 1000;
  return jetonCache;
}

// Construit l'URL, avec le jeton si on a pu l'obtenir.
// Repli sans jeton pendant la transition : tant que les règles sont ouvertes,
// rien ne casse. Le repli est signalé bruyamment dans les journaux Netlify pour
// qu'un problème de clé se voie AVANT qu'on ferme les règles.
async function urlAvecJeton(dbUrl, path) {
  try {
    const jeton = await obtenirJeton();
    if (jeton) return `${dbUrl}/${path}.json?access_token=${jeton}`;
    console.log('[ABCT] ⚠️ Compte de service absent — appel NON authentifié');
  } catch (e) {
    console.log('[ABCT] ⚠️ Authentification serveur en échec (' + e.message + ') — appel NON authentifié');
  }
  return `${dbUrl}/${path}.json`;
}

async function fbRead(dbUrl, path) {
  const res = await fetch(await urlAvecJeton(dbUrl, path));
  if (!res.ok) throw new Error('Lecture ' + path + ' impossible (HTTP ' + res.status + ')');
  return await res.json();
}

async function fbWrite(dbUrl, path, value) {
  const res = await fetch(await urlAvecJeton(dbUrl, path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  if (!res.ok) throw new Error('Écriture ' + path + ' impossible (HTTP ' + res.status + ')');
}

module.exports = { fbRead, fbWrite, obtenirJeton };
