// ═══════════════════════════════════════════════════════════════════
// Air Base Chess Tour — logique partagée de verification des retards
//
// Utilisee par :
//   • netlify/functions/late-alert-daily.js  (programmee, 1x/jour)
//   • netlify/functions/check-late-now.js    (declenchee par l'admin,
//     pour tester sans attendre le lendemain)
//
// Vit a la racine du depot (comme match-dates.js) pour ne jamais etre
// confondue avec une fonction Netlify a part entiere.
// ═══════════════════════════════════════════════════════════════════

const webpush = require('web-push');
const { isMatchLate } = require('../../../match-dates.js');

const DB_URL = process.env.FIREBASE_DB_URL;

function envFromUrl(url) {
  const isDev = (url || '').includes('dev--');
  return {
    isDev,
    subPath: isDev ? 'subscriptions-dev' : 'subscriptions',
    adminKey: isDev ? 'adminSubIdDev' : 'adminSubId'
  };
}

// Accès authentifie via le compte de service (voir _shared/fb-auth.js).
const { fbRead: fbReadAuth, fbWrite: fbWriteAuth } = require('./fb-auth.js');
async function fbRead(path) { return fbReadAuth(DB_URL, path); }
async function fbWrite(path, value) { return fbWriteAuth(DB_URL, path, value); }

// siteUrl sert uniquement a detecter dev/prod (voir envFromUrl). Retourne toujours
// un resultat structure { sent, total?, reason }, jamais une exception non geree.
async function runLateCheck(siteUrl) {
  const { isDev, subPath, adminKey } = envFromUrl(siteUrl);

  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !DB_URL)
    return { sent: false, code: 'no_config', reason: 'config manquante (VAPID/DB_URL) cote Netlify' };

  const autoOn = await fbRead('settings/autoNotifyLateAlerts').catch(() => false);
  if (autoOn !== true) return { sent: false, code: 'auto_off', reason: 'Alerte automatique désactivée (case à cocher dans Réglages)' };

  const maint = await fbRead('maintenance').catch(() => true);
  if (maint === true && !isDev) return { sent: false, code: 'maintenance', reason: 'Mode maintenance actif — alerte suspendue' };

  const adminSubId = await fbRead('settings/' + adminKey).catch(() => null);
  if (!adminSubId) return { sent: false, code: 'no_admin_device', reason: 'Aucun appareil admin enregistré' };

  const adminSub = await fbRead(subPath + '/' + adminSubId).catch(() => null);
  if (!adminSub?.endpoint || !adminSub?.keys?.p256dh || !adminSub?.keys?.auth)
    return { sent: false, code: 'admin_sub_invalid', reason: 'Abonnement admin introuvable ou invalide' };

  // ── LANGUE DE L'APPAREIL ADMIN ──
  // L'appareil admin ne sera pas toujours celui de la meme personne. Son abonnement
  // porte la langue choisie sur le site, exactement comme celui d'un joueur : on s'en
  // sert ici. Les noms de joueurs, de groupes et de tours viennent des donnees et ne
  // se traduisent pas. Repli en francais pour un abonnement anterieur sans langue.
  const TXT = {
    fr: { preuve: '✅ Alerte retard active — aucun match en retard actuellement.',
          entete: n => `⏰ ${n} match${n > 1 ? 's' : ''} en retard\n`,
          plus:   n => `… et ${n} de plus`,
          fermer: 'Fermer' },
    de: { preuve: '✅ Verspätungsalarm aktiv — derzeit ist kein Spiel überfällig.',
          entete: n => `⏰ ${n} überfällige${n > 1 ? ' Spiele' : 's Spiel'}\n`,
          plus:   n => `… und ${n} weitere`,
          fermer: 'Schliessen' },
    en: { preuve: '✅ Late alert active — no match currently overdue.',
          entete: n => `⏰ ${n} overdue match${n > 1 ? 'es' : ''}\n`,
          plus:   n => `… and ${n} more`,
          fermer: 'Close' },
    it: { preuve: '✅ Avviso ritardi attivo — nessuna partita in ritardo al momento.',
          entete: n => `⏰ ${n} partit${n > 1 ? 'e' : 'a'} in ritardo\n`,
          plus:   n => `… e altre ${n}`,
          fermer: 'Chiudi' }
  };
  const L = TXT[adminSub.lang] || TXT.fr;

  const [settings, gamesObj, finalsObj] = await Promise.all([
    fbRead('settings').catch(() => ({})),
    fbRead('games').catch(() => ({})),
    fbRead('finals').catch(() => ({}))
  ]);
  const games = Object.values(gamesObj || {});
  const finals = Object.values(finalsObj || {});

  const lateGames = games.filter(g => {
    const played = g.scoreWhite !== null && g.scoreWhite !== undefined;
    return !played && isMatchLate(g, false, settings, finals);
  });
  const lateFinals = finals.filter(f => {
    const played = f.score1 !== null && f.score1 !== undefined;
    const isPresential = f.round === 'Demis' || f.round === 'Finale';
    return !played && !isPresential && f.player1 && f.player2 && isMatchLate(f, true, settings, finals);
  });
  const total = lateGames.length + lateFinals.length;

  webpush.setVapidDetails('mailto:airbasechesstour@gmail.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  async function send(body, urgency) {
    const payload = JSON.stringify({
      title: (settings.name || 'Air Base Chess Tour') + ' — Admin',
      body,
      icon: '/icon-192.jpg',
      // Fragment #matches : un clic ouvre directement la liste des matchs, avec les
      // echeances et la mise en page du site. La notification donne le compte et un
      // apercu ; le site donne le detail complet.
      // TOUJOURS la production, meme quand l'alerte part de dev : `isDev` gouverne
      // QUI RECOIT (subPath, cle admin, maintenance), jamais le site ouvert au clic.
      // Ouvrir dev inciterait a y installer une seconde application et a s'y abonner
      // en doublon, pour ne plus rien recevoir sur le vrai site.
      url: 'https://airbasechesstour.netlify.app/#matches',
      // Etiquette PAR JOUR, et non par envoi. L'alerte de retard n'est pas une suite
      // d'evenements distincts mais un meme etat qui evolue : "voici les matchs en
      // retard aujourd'hui". Deux declenchements le meme jour (cron de 6h07 + controle
      // manuel) doivent donc donner UNE notification, pas deux identiques. Un nouveau
      // jour produit une nouvelle etiquette, donc une nouvelle alerte qui sonne.
      // Une etiquette unique par envoi empilerait autant de notifications que de jours
      // de retard, sans jamais disparaitre (requireInteraction).
      // Date UTC : le cron est ancre sur UTC, la journee reste donc coherente.
      tag: 'abct-retard-' + new Date().toISOString().slice(0, 10),
      actions: [{ action: 'fermer', title: L.fermer }]
    });
    try {
      await webpush.sendNotification(
        { endpoint: adminSub.endpoint, keys: { p256dh: adminSub.keys.p256dh, auth: adminSub.keys.auth } },
        payload, { TTL: 86400, urgency }
      );
    } catch (e) {
      // APPAREIL ADMIN MORT (404/410) : l'abonnement n'existe plus chez le service
      // push (donnees du navigateur effacees, app desinstallee). Sans ce bloc, le
      // fantome restait dans la liste ET le pointeur admin le designait encore :
      // l'admin voyait "un autre appareil est enregistre" et l'alerte ne partait
      // jamais. On supprime les deux ; le site affichera "aucun appareil admin".
      if (e.statusCode === 404 || e.statusCode === 410) {
        await fbWrite(subPath + '/' + adminSubId, null).catch(() => {});
        await fbWrite('settings/' + adminKey, null).catch(() => {});
        const err = new Error('appareil admin mort — nettoye');
        err.code = 'admin_dead';
        throw err;
      }
      throw e;
    }
  }

  // Envoi encapsule : un appareil admin mort devient un resultat explicite,
  // pas une erreur brute.
  const envoyer = async (body, urgency) => {
    try { await send(body, urgency); return null; }
    catch (e) {
      if (e.code === 'admin_dead') return { sent: false, total, code: 'admin_dead', reason: 'Appareil admin plus joignable — abonnement et enregistrement retires' };
      throw e;
    }
  };

  if (!total) {
    // La preuve de vie hebdomadaire n'a de sens QUE si un match pourrait etre en retard.
    // Hors phase de jeu (inscriptions ouvertes, tournoi termine), elle n'apporte rien et
    // devient du bruit. Les vraies alertes de retard, elles, ne sont jamais bridees.
    const enJeu = settings.status === 'playing' || settings.status === 'finals';
    if (!enJeu) {
      return { sent: false, total: 0, code: 'not_playing', reason: 'Tournoi hors phase de jeu (statut: ' + (settings.status || 'inconnu') + ') — preuve de vie inutile' };
    }
    const lastPing = await fbRead('settings/lastLateAlertPing').catch(() => 0);
    const daysSincePing = (Date.now() - (lastPing || 0)) / (1000 * 60 * 60 * 24);
    if (daysSincePing >= 7) {
      const echec = await envoyer(L.preuve, 'low');
      if (echec) return echec;
      await fbWrite('settings/lastLateAlertPing', Date.now());
      return { sent: true, total: 0, code: 'proof_sent', reason: 'Aucun retard — preuve de vie hebdomadaire envoyée' };
    }
    return { sent: false, total: 0, code: 'nothing_late', reason: 'Aucun match en retard actuellement (rien à envoyer)' };
  }

  let body = L.entete(total);
  // Plafond de lignes listees. Constate sur Android le 10 septembre : le systeme
  // COUPE l'affichage vers la neuvieme ligne, meme notification depliee. Avec 12,
  // le "... et N de plus" tombait hors du cadre et devenait invisible — on perdait
  // l'information la plus utile, le nombre restant. A 6, l'en-tete, les six matchs
  // et le compte du reste tiennent tous a l'ecran. La liste complete est a un clic,
  // via le lien vers la page des matchs. Ajustable ici sans rien toucher d'autre.
  const MAX_LIGNES = 6;
  lateGames.slice(0, MAX_LIGNES).forEach(g => { body += `• ${g.playerWhite} vs ${g.playerBlack} (${g.group})\n`; });
  lateFinals.slice(0, Math.max(0, MAX_LIGNES - lateGames.length)).forEach(f => { body += `• ${f.player1} vs ${f.player2} (${f.round})\n`; });
  if (total > MAX_LIGNES) body += L.plus(total - MAX_LIGNES);

  const echec = await envoyer(body.trim(), 'high');
  if (echec) return echec;
  await fbWrite('settings/lastLateAlertPing', Date.now());
  return { sent: true, total, code: 'alert_sent', reason: total + ' match(s) en retard — notification envoyée à l\'appareil admin' };
}

module.exports = { runLateCheck };
