// ── COMPTEUR DE VISITES ──
//
// POST : un appareil signale sa visite du jour (au plus une fois par jour, le site
//        s'en charge). On note `visits/<jour>/<appareil>` et `visitors/<appareil>`.
// GET  : renvoie les totaux affichés dans l'admin — aujourd'hui, 7 jours, 30 jours,
//        et depuis le début. Des nombres seulement, aucun identifiant.
//
// Pourquoi une fonction plutôt qu'une écriture directe depuis le site : les règles
// Firebase n'autorisent pas ce chemin, et le compte de service passe au-dessus d'elles.
// Rien à toucher dans la console Firebase.
//
// L'« appareil » est un identifiant aléatoire tiré par le navigateur et gardé dans son
// stockage local : ni nom, ni adresse IP, rien qui désigne une personne. Un même joueur
// sur son téléphone et son ordinateur compte donc pour deux, et vider son navigateur le
// fait recompter. Ce sont des ordres de grandeur, pas un registre.
//
// ⚠️ Rien n'empêche quelqu'un d'appeler cette fonction en boucle avec des identifiants
// inventés pour gonfler les chiffres. Sans conséquence sur le tournoi : seul le compteur
// est faussé.

const { obtenirJeton } = require('./_shared/fb-auth.js');

const DB_URL = process.env.FIREBASE_DB_URL;
const ID_VALIDE = /^[a-z0-9]{12,40}$/;

// Le jour se compte à l'heure suisse, pas en UTC : une visite à 00h30 appartient au
// jour qui commence, pas à la veille.
function jourSuisse(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(date);
}

async function appel(chemin, params, options) {
  const jeton = await obtenirJeton();
  const q = new URLSearchParams(params || {});
  if (jeton) q.set('access_token', jeton);
  const res = await fetch(`${DB_URL}/${chemin}.json?${q}`, options);
  if (!res.ok) throw new Error(chemin + ' : HTTP ' + res.status);
  return res.json();
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (!DB_URL) return { statusCode: 500, headers, body: JSON.stringify({ error: 'config' }) };

  // Le site de test (dev--…) compte à part, pour ne pas mêler ses visites à la prod.
  const dev = (event.queryStringParameters || {}).env === 'dev';
  const racineJours = dev ? 'visits-dev' : 'visits';
  const racineAppareils = dev ? 'visitors-dev' : 'visitors';

  try {
    if (event.httpMethod === 'POST') {
      let corps;
      try { corps = JSON.parse(event.body || '{}'); } catch { corps = {}; }
      const id = String(corps.id || '');
      if (!ID_VALIDE.test(id)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id' }) };
      const jour = jourSuisse(new Date());
      const ecrire = (chemin) => appel(chemin, null, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: 'true'
      });
      await Promise.all([ecrire(`${racineJours}/${jour}/${id}`), ecrire(`${racineAppareils}/${id}`)]);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (event.httpMethod === 'GET') {
      const maintenant = new Date();
      const jours = [];
      for (let i = 0; i < 30; i++) jours.push(jourSuisse(new Date(maintenant.getTime() - i * 86400000)));
      // `orderBy="$key"` + `startAt` : seuls les 30 derniers jours sont lus, quelle que
      // soit la durée de l'historique. Aucun index à déclarer pour trier par clé.
      const [parJour, appareils] = await Promise.all([
        appel(racineJours, { orderBy: '"$key"', startAt: JSON.stringify(jours[29]) }),
        appel(racineAppareils, { shallow: 'true' })
      ]);
      const unique = (n) => {
        const ens = new Set();
        jours.slice(0, n).forEach(j => Object.keys((parJour || {})[j] || {}).forEach(id => ens.add(id)));
        return ens.size;
      };
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          aujourdhui: unique(1),
          semaine: unique(7),
          mois: unique(30),
          total: Object.keys(appareils || {}).length
        })
      };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (e) {
    console.log('[ABCT] Compteur de visites :', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'firebase' }) };
  }
};
