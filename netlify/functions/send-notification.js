const webpush = require('web-push');

// ── TEXTES DES NOTIFICATIONS ──
// Le serveur ignore la langue de chaque appareil : elle est enregistree dans
// l'abonnement au moment ou le joueur active ses notifications. On regroupe donc
// les destinataires par langue et on envoie a chacun le texte qui lui convient.
// Les abonnements anterieurs, sans langue, recoivent le francais.
const TEXTES = {
  fr: { victoire: '🏆 Vainqueur : ', nul: '🤝 Match nul', test: '✅ Test réussi — tes notifications fonctionnent.', fermer: 'Fermer', ronde: 'Ronde', groupe: 'Gr.' },
  de: { victoire: '🏆 Sieger: ',      nul: '🤝 Remis', test: '✅ Test erfolgreich — deine Benachrichtigungen funktionieren.', fermer: 'Schliessen', ronde: 'Runde', groupe: 'Gr.' },
  en: { victoire: '🏆 Winner: ',    nul: '🤝 Draw', test: '✅ Test successful — your notifications are working.', fermer: 'Close', ronde: 'Round', groupe: 'Gr.' },
  it: { victoire: '🏆 Vincitore: ',  nul: '🤝 Patta', test: '✅ Test riuscito — le tue notifiche funzionano.', fermer: 'Chiudi', ronde: 'Turno', groupe: 'Gir.' }
};
function txt(lang, cle) { return (TEXTES[lang] || TEXTES.fr)[cle]; }

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const DB_URL        = process.env.FIREBASE_DB_URL;

webpush.setVapidDetails('mailto:airbasechesstour@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);

// Les règles Firebase sont publiques en lecture/écriture -> pas besoin d'OAuth pour ces petits champs.
// Accès authentifie via le compte de service (voir _shared/fb-auth.js).
const { fbRead: fbReadAuth, fbWrite: fbWriteAuth } = require('./_shared/fb-auth.js');
async function fbRead(path) { return fbReadAuth(DB_URL, path); }
async function fbWrite(path, value) { return fbWriteAuth(DB_URL, path, value); }

async function getAdminPin() {
  return fbRead('adminPin');
}

// En maintenance : on ne garde que l'appareil admin dans la liste des
// destinataires. Renvoie une liste vide si aucun appareil admin n'est enregistre
// — mieux vaut n'envoyer a personne que de deranger les joueurs.
function restreindreSiMaintenance(liste, maintenance, subAdmin) {
  if (!maintenance) return liste;
  return subAdmin && subAdmin.endpoint && subAdmin.keys ? [subAdmin] : [];
}

// NETTOYAGE AUTOMATIQUE : un abonnement qui renvoie 404/410 est definitivement mort
// (app desinstallee, donnees du navigateur effacees, revocation systeme). On le
// supprime de Firebase sur-le-champ. Sans cela, il restait indefiniment dans la
// liste : l'admin comptait des destinataires fantomes, et le joueur concerne voyait
// "notifications activees" alors qu'il ne recevait plus rien — sans jamais l'apprendre.
// `body` peut etre un texte (annonce manuelle, identique pour tous) ou une
// FONCTION de la langue (resultat de match, traduit par destinataire).
// `etiquette` : identifiant unique de CET envoi. Le service worker s'en sert comme
// `tag`. Une etiquette differente a chaque envoi = les notifications s'empilent au
// lieu de se remplacer. Tous les destinataires d'un meme envoi la partagent, ce qui
// est sans effet puisque chacun n'a qu'un appareil concerne a la fois.
async function sendToAll(subscriptions, title, body, subPath, etiquette, siteUrl) {
  const corpsPour = (sub) => typeof body === 'function'
    ? body(sub.lang || 'fr')   // abonnements anterieurs sans langue -> francais
    : body;
  // Le TITRE aussi peut dependre de la langue. Pour un resultat, il porte desormais
  // le vainqueur : c'est la seule partie d'une notification qu'Android affiche
  // TOUJOURS en entier, meme repliee ou groupee. Les annonces continuent de passer
  // une simple chaine, le comportement ne change pas pour elles.
  const titrePour = (sub) => typeof title === 'function'
    ? title(sub.lang || 'fr')
    : title;
  const results = { success: 0, failed: 0, expired: 0, cleaned: 0, errors: [] };

  for (const sub of subscriptions) {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      results.failed++;
      results.errors.push('abonnement incomplet (ancien format)');
      continue;
    }
    try {
      // Payload construit PAR destinataire : le corps depend de sa langue.
      const payload = JSON.stringify({
        title: titrePour(sub) || 'Air Base Chess Tour',
        body:  corpsPour(sub) || '',
        icon:  '/icon-192.jpg',
        url:   siteUrl || 'https://airbasechesstour.netlify.app/',
        tag:   etiquette || ('abct-' + Date.now()),
        // Bouton de fermeture, dans la langue du destinataire. Non dessine par
        // Safari (iOS/macOS) : la notification y garde simplement son comportement
        // par defaut, sans erreur.
        actions: [{ action: 'fermer', title: txt(sub.lang || 'fr', 'fermer') }]
      });
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
        // Suppression immediate. Non bloquant : un echec de nettoyage ne doit
        // jamais empecher les autres envois d'aboutir.
        if (subPath && sub.__id) {
          try {
            // fbWrite local : (chemin, valeur) — DB_URL est deja integre.
            await fbWrite(subPath + '/' + sub.__id, null);
            results.cleaned++;
          } catch (err) {
            console.log('[ABCT] Nettoyage impossible pour ' + sub.__id + ' : ' + err.message);
          }
        }
      } else {
        results.failed++;
        results.errors.push((e.statusCode || '?') + ' ' + String(e.body || e.message).slice(0, 120));
      }
    }
  }
  return results;
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

  let parsed;
  try {
    parsed = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Corps de requete invalide' }) };
  }
  const { type, pin, title, body, gameId, isFinal } = parsed;

  // ── Detection dev/prod par l'URL d'origine de la requete ──
  // Meme principe que IS_DEV cote site : aucun reglage a changer lors d'un merge,
  // le comportement suit automatiquement le domaine qui appelle.
  const h = event.headers || {};
  const origin = String(h.origin || h.referer || h.Origin || h.Referer || '');
  const IS_DEV = origin.includes('dev--');
  const SUB_PATH = IS_DEV ? 'subscriptions-dev' : 'subscriptions';
  // ── ADRESSE OUVERTE AU CLIC : TOUJOURS LA PRODUCTION, MEME DEPUIS DEV ──
  // C'est DELIBERE, ne pas "aligner sur l'environnement". Ce qui doit etre isole
  // entre dev et prod, c'est QUI RECOIT (SUB_PATH ci-dessus) : une notification
  // envoyee depuis dev ne part qu'aux abonnes de dev, et cela ne change pas.
  // Mais dev n'est qu'un banc d'essai. Ouvrir dev depuis une notification exposerait
  // un joueur a s'y installer une SECONDE fois l'application, a s'y abonner, puis a
  // ne plus rien recevoir sur le vrai site sans comprendre pourquoi. Le site reel
  // est unique : toutes les notifications y menent.
  const SITE_URL = 'https://airbasechesstour.netlify.app/';

  try {
    // Le serveur va chercher LUI-MEME la liste d'abonnes du bon environnement.
    // La liste eventuellement envoyee par le client est ignoree : cela garantit
    // qu'une requete venant de dev ne peut jamais toucher les abonnes de prod.
    const subsObj = await fbRead(SUB_PATH).catch(() => ({}));
    // __id : identifiant Firebase de l'abonnement, indispensable pour pouvoir le
    // supprimer s'il s'avere mort a l'envoi.
    let subscriptions = Object.entries(subsObj || {})
      .filter(([, s]) => s && s.endpoint && s.keys)
      .map(([id, s]) => ({ ...s, __id: id }));
    // ── TEST DE BOUCLE COMPLETE ──
    // Envoie une VRAIE notification push au seul appareil qui la demande, par le
    // meme circuit qu'une annonce : Firebase -> cette fonction -> cles VAPID ->
    // service push -> telephone. Contrairement a un affichage local, ce test
    // detecte une entree Firebase absente, une adresse perimee ou une cle mal
    // configuree — c'est-a-dire tout ce qui empecherait vraiment de recevoir.
    if (parsed.action === 'test') {
      const cible = (subsObj || {})[parsed.subId];
      if (!cible || !cible.endpoint || !cible.keys)
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, code: 'test_no_entry' }) };
      try {
        await webpush.sendNotification(
          { endpoint: cible.endpoint, keys: { p256dh: cible.keys.p256dh, auth: cible.keys.auth } },
          JSON.stringify({
            title: 'Air Base Chess Tour',
            body: txt(cible.lang || 'fr', 'test'),
            icon: '/icon-192.jpg',
            url: SITE_URL,
            tag: 'abct-test-' + Date.now(),
            actions: [{ action: 'fermer', title: txt(cible.lang || 'fr', 'fermer') }]
          }),
          { TTL: 60, urgency: 'high' }
        );
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, code: 'test_sent' }) };
      } catch (e) {
        // 404/410 : l'adresse est morte. On nettoie, comme a chaque envoi reel.
        if (e.statusCode === 404 || e.statusCode === 410) {
          await fbWrite(SUB_PATH + '/' + parsed.subId, null).catch(() => {});
          return { statusCode: 200, headers, body: JSON.stringify({ ok: false, code: 'test_dead' }) };
        }
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, code: 'test_error', detail: String(e.statusCode || e.message) }) };
      }
    }

    const adminKey = IS_DEV ? 'adminSubIdDev' : 'adminSubId';
    const adminSubId = await fbRead('settings/' + adminKey).catch(() => null);
    const subAdmin = adminSubId ? (subsObj || {})[adminSubId] : null;
    // En maintenance, l'envoi n'est plus annule : il est restreint a l'appareil
    // admin. Les joueurs ne sont pas deranges, mais l'admin garde un retour reel
    // pendant ses tests. Lu ICI, au niveau commun aux deux types d'envoi
    // (resultat automatique ET annonce manuelle) — la lecture etait auparavant
    // dans la seule branche "resultat", donc sans effet sur les annonces.
    // Sur dev, la maintenance est ignoree volontairement.
    const maintNow = await fbRead('maintenance').catch(() => true);
    const modeMaintenance = (maintNow === true && !IS_DEV);

    if (!subscriptions.length)
      return { statusCode: 200, headers, body: JSON.stringify({ skipped: 'aucun abonne', env: IS_DEV ? 'dev' : 'prod' }) };

    // ── Chemin automatique : declenche par un joueur (ou l'admin) qui entre un score.
    // Pas de PIN ici, mais le serveur revalide tout lui-meme : reglage admin, maintenance,
    // et construit le texte a partir du match reel (le client ne peut pas envoyer de texte libre).
    if (type === 'auto_result') {
      if (!gameId)
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'gameId requis' }) };

      // En cas de doute (erreur reseau/lecture), on bloque plutot que d'envoyer.
      const autoEnabled = await fbRead('settings/autoNotifyResults').catch(() => false);
      if (autoEnabled !== true)
        return { statusCode: 200, headers, body: JSON.stringify({ skipped: 'auto-notify desactive' }) };

      const path = isFinal ? 'finals/' + gameId : 'games/' + gameId;
      const game = await fbRead(path).catch(() => null);
      if (!game)
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Match introuvable' }) };
      if (game.notified === true)
        return { statusCode: 200, headers, body: JSON.stringify({ skipped: 'deja notifie' }) };

      const p1 = isFinal ? game.player1 : game.playerWhite;
      const p2 = isFinal ? game.player2 : game.playerBlack;
      const sc1 = isFinal ? game.score1 : game.scoreWhite;
      const sc2 = isFinal ? game.score2 : game.scoreBlack;
      if (p1 == null || p2 == null || sc1 == null || sc2 == null)
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Score incomplet' }) };

      // Le corps depend de la langue du destinataire : on fournit une fonction
      // plutot qu'un texte fige, appelee une fois par groupe de langue.
      // ── UNE SEULE LIGNE, INFORMATION ESSENTIELLE EN TETE ──
      // Le corps tenait sur DEUX lignes : "Victoire : X" puis "A 0 - 1 X". Repliee,
      // une notification n'affiche que la premiere : on savait qui avait gagne, ni
      // contre qui ni sur quel score, et il fallait la deplier pour une information
      // qui tient sur une ligne. Le vainqueur passe donc devant, suivi du score puis
      // du perdant ; en cas de nul, l'ordre d'origine est conserve puisqu'il n'y a
      // pas de vainqueur a mettre en avant.
      const gagnant = sc1 > sc2 ? p1 : (sc2 > sc1 ? p2 : null);
      // TITRE : l'issue et le vainqueur. Toujours affiche en entier, meme replie.
      const titreSelonLangue = (lang) => gagnant
        ? txt(lang, 'victoire') + gagnant
        : txt(lang, 'nul');
      // CORPS : la ligne de score, dans l'ordre BLANCS puis NOIRS. Cet ordre est la
      // convention des echecs et la seule facon de savoir qui jouait quelle couleur :
      // ne pas le reordonner pour mettre le vainqueur devant.
      // CONTEXTE en fin de corps : « · Ronde 1 · Gr. 2 ». Le nom du groupe est stocke
      // EN FRANCAIS dans la base (litteralement « Groupe 1 ») : c'est une donnee, pas
      // une cle. On en extrait donc le NUMERO et on reconstruit le libelle dans la
      // langue du destinataire. Si le nom ne contient aucun chiffre, on n'affiche rien
      // plutot que du francais a un germanophone.
      // Les FINALES n'ont pas de contexte : leur ronde est un nom francais (« Quarts »,
      // « Demis ») et non un numero, donc intraduisible de la meme facon. Le titre suffit.
      // Noms de tours des finales. Ils sont stockes EN FRANCAIS dans la base
      // ('Quarts', 'Demis'...) : ce sont des donnees, pas des cles. Cette table les
      // traduit, au singulier puisqu'une notification concerne UN match. Un nom
      // inconnu (renommage futur) n'affiche rien plutot que du francais a un
      // germanophone. Les libelles doivent rester alignes sur roundNames d'index.html.
      const TOURS = {
        '32èmes':     { fr: '32e de finale',          de: 'Runde der letzten 64', en: 'Round of 64',     it: 'Trentaduesimi' },
        '16èmes':     { fr: '16e de finale',          de: 'Sechzehntelfinale',    en: 'Round of 32',     it: 'Sedicesimi' },
        '8èmes':      { fr: '8e de finale',           de: 'Achtelfinale',         en: 'Round of 16',     it: 'Ottavi' },
        'Quarts':     { fr: 'Quart de finale',        de: 'Viertelfinale',        en: 'Quarter-final',   it: 'Quarti di finale' },
        'Demis':      { fr: 'Demi-finale',            de: 'Halbfinale',           en: 'Semi-final',      it: 'Semifinale' },
        'Finale':     { fr: 'Finale',                 de: 'Finale',               en: 'Final',           it: 'Finale' },
        '3ème place': { fr: 'Match pour la 3e place', de: 'Spiel um Platz 3',     en: '3rd place match', it: 'Finale 3° posto' }
      };
      const contexte = (lang) => {
        if (isFinal) {
          const tour = TOURS[game.round];
          return tour ? ` · ${tour[lang] || tour.fr}` : '';
        }
        const r = (typeof game.round === 'number') ? ` · ${txt(lang, 'ronde')} ${game.round}` : '';
        const numGr = String(game.group || '').replace(/\D/g, '');
        const g = numGr ? ` · ${txt(lang, 'groupe')} ${numGr}` : '';
        return r + g;
      };
      const corpsSelonLangue = (lang) => `${p1} ${sc1} — ${sc2} ${p2}${contexte(lang)}`;

      // Marquer avant l'envoi pour eviter un double-envoi en cas d'appels rapproches.
      await fbWrite(path + '/notified', true);

      const eligible = restreindreSiMaintenance(subscriptions, modeMaintenance, subAdmin)
        .filter(s => s?.prefs?.match !== false);
      if (!eligible.length)
        return { statusCode: 200, headers, body: JSON.stringify({ skipped: 'aucun abonne pour la categorie Match' }) };

      const results = await sendToAll(eligible, titreSelonLangue, corpsSelonLangue, SUB_PATH, 'abct-resultat-' + Date.now(), SITE_URL);
      return { statusCode: 200, headers, body: JSON.stringify(results) };
    }

    // ── Chemin admin existant : message libre, protege par PIN ──
    if (!pin)
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'PIN requis' }) };

    const storedPin = await getAdminPin();
    if (storedPin === null || storedPin === undefined)
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'adminPin absent de Firebase' }) };

    if (String(pin).trim() !== String(storedPin).trim())
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'PIN incorrect' }) };

    // Respecte la preference "annonces officielles" cote serveur aussi (le site filtre
    // deja avant l'envoi, mais la preference du joueur doit etre honoree a la source).
    const eligibleOfficiel = restreindreSiMaintenance(subscriptions, modeMaintenance, subAdmin)
      .filter(s => s?.prefs?.officiel !== false);
    if (!eligibleOfficiel.length)
      return { statusCode: 200, headers, body: JSON.stringify({ skipped: 'aucun abonne pour la categorie Officiel' }) };

    const results = await sendToAll(eligibleOfficiel, title, body, SUB_PATH, 'abct-annonce-' + Date.now(), SITE_URL);
    return { statusCode: 200, headers, body: JSON.stringify(results) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
