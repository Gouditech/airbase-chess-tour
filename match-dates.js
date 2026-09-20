// ═══════════════════════════════════════════════════════════════════
// Air Base Chess Tour — LOGIQUE DES DATES D'ÉCHÉANCE (source unique)
//
// Ce fichier est utilisé À LA FOIS par :
//   • le site (index.html)            -> via <script src="match-dates.js">
//   • l'alerte quotidienne (Netlify)  -> via require('../../match-dates.js')
//
// ⚠️ C'est le SEUL endroit où modifier le calcul des retards.
//    Ne pas recopier ces fonctions ailleurs.
// ═══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  var FINALS_ROUND_SEQUENCE = ['32èmes', '16èmes', '8èmes', 'Quarts', 'Demis', 'Finale'];

  // Analyse une date 'AAAA-MM-JJ' en heure LOCALE.
  // new Date('2026-09-30') l'interprète comme minuit UTC : sur un appareil réglé
  // sur un fuseau en retard sur UTC, l'affichage recule d'un jour. En construisant
  // la date à partir de ses composantes, on obtient minuit local — la même date
  // partout, quel que soit l'appareil ou son fuseau.
  function parseDateLocale(s) {
    if (!s) return null;
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) { var d0 = new Date(s); return isNaN(d0.getTime()) ? null : d0; }
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  // Date d'échéance d'un match.
  //   Poule  -> poolStartDate + round * poolInterval (ronde 1 = départ + 1 intervalle)
  //   Finale -> finalsStartDate + (position + 1) * finalsInterval, où la position est
  //             calculée depuis la PREMIÈRE ronde réellement présente dans ce
  //             bracket (il peut démarrer aux Quarts, aux 8èmes, etc.).
  //
  // settings  : l'objet settings de Firebase
  // allFinals : tableau de TOUS les matchs de finale (pour trouver la 1re ronde)
  // Retourne un objet Date, ou null si non calculable.
  function matchDueDate(game, isFinal, settings, allFinals) {
    var s = settings || {};
    if (!game) return null;

    // ── MATCH ANNULÉ (« -:- ») ──
    // Quand un joueur abandonne le tournoi, l'organisateur marque ses matchs restants
    // comme non joués. Ils n'ont plus d'échéance : ni date affichée sur la carte, ni
    // retard possible. Le verrou est posé ICI, dans le fichier partagé, et non dans
    // chacun des appelants : le site ET l'alerte quotidienne de Netlify passent tous
    // les deux par cette fonction, ils héritent donc de la règle sans pouvoir diverger.
    // Sans ça, le serveur aurait signalé tous les jours, indéfiniment, un match que
    // personne ne jouera jamais.
    if (game.annule) return null;

    if (isFinal) {
      var startDate = s.finalsStartDate;
      var interval = s.finalsInterval || 4;
      if (!startDate || !game.round) return null;

      var rounds = (allFinals || []).map(function (f) { return f.round; });
      var presentRounds = rounds.filter(function (r, i) {
        return FINALS_ROUND_SEQUENCE.indexOf(r) >= 0 && rounds.indexOf(r) === i;
      });
      if (!presentRounds.length) return null;

      var firstIdx = Math.min.apply(null, presentRounds.map(function (r) {
        return FINALS_ROUND_SEQUENCE.indexOf(r);
      }));
      // La petite finale n'est pas un TOUR du tableau — elle ne figure donc pas dans la
      // séquence et ne doit pas peser sur le calcul de la première ronde présente — mais
      // elle se joue en même temps que la finale et mérite la même échéance. Sans ça,
      // c'était le SEUL match du tournoi sans date limite : ni affichée sur la carte, ni
      // prise en compte par l'alerte de retard. Ses deux joueurs n'avaient aucune
      // indication de quand jouer.
      // Elle est optionnelle (réglage admin « match pour la 3e place ») : quand elle
      // n'existe pas, rien de tout ceci ne s'exécute. Et quand elle existe, la finale
      // existe forcément — elle n'est créée que si des demi-finales sont présentes.
      var rondePourDate = (game.round === '3ème place') ? 'Finale' : game.round;
      var thisIdx = FINALS_ROUND_SEQUENCE.indexOf(rondePourDate);
      if (thisIdx < 0) return null;
      var position = thisIdx - firstIdx;
      if (position < 0) return null;

      var df = parseDateLocale(startDate);
      if (!df) return null;                  // date de réglage invalide
      df.setDate(df.getDate() + (position + 1) * interval);
      return df;
    }

    var poolStart = s.poolStartDate;
    var poolInterval = s.poolInterval || 4;
    if (!poolStart || !game.round) return null;
    var d = parseDateLocale(poolStart);
    if (!d) return null;
    d.setDate(d.getDate() + game.round * poolInterval);
    return d;
  }

  // ── OUVERTURE DE LA RONDE ──
  // Une ronde n'est pas qu'une date limite : elle a une fenêtre. La ronde 1 s'ouvre le
  // jour du départ du tournoi, la ronde 2 quand la 1 se ferme, et ainsi de suite ; les
  // tours de finale suivent la même règle depuis `finalsStartDate`.
  // L'échéance vaut départ + (position + 1) x intervalle, donc l'ouverture vaut
  // simplement échéance - intervalle. Une seule soustraction, valable pour les poules
  // comme pour les finales, et qui redonne exactement la date de départ réglée par
  // l'organisateur pour la première ronde — aucune date n'est inventée.
  // ⚠️ Rien n'INTERDIT de jouer plus tôt, et c'est voulu : deux joueurs disponibles ont
  // tout intérêt à prendre de l'avance. Cette fenêtre décrit le rythme prévu, elle ne le
  // rend pas obligatoire — d'où un affichage qui la présente et ne l'impose pas.
  function roundWindowStart(game, isFinal, settings, allFinals) {
    var due = matchDueDate(game, isFinal, settings, allFinals);
    if (!due) return null;
    var s = settings || {};
    var interval = isFinal ? (s.finalsInterval || 4) : (s.poolInterval || 4);
    var d = new Date(due.getTime());
    d.setDate(d.getDate() - interval);
    return d;
  }

  // Un match est "en retard" dès le lendemain de son échéance : la date calculée EST la
  // date limite (le match doit être terminé et le score saisi avant la fin de ce jour-là).
  // ⚠️ Ne pas rajouter d'intervalle de grâce ici : historiquement l'échéance marquait le
  // DÉBUT de la fenêtre de jeu, ce qui justifiait d'attendre un intervalle de plus. Depuis
  // que l'échéance est la vraie date limite, ce délai supplémentaire doublait l'attente.
  // ── LE SITE ET LE SERVEUR DOIVENT BASCULER AU MÊME INSTANT ──
  // `setHours(23,59,59,999)` ferme la journée dans le fuseau de la MACHINE. Le téléphone
  // du joueur est en Suisse, la fonction Netlify tourne en UTC : le site marquait donc un
  // match en retard jusqu'à deux heures avant le serveur, et « Vérifier les retards
  // maintenant » pouvait répondre « aucun retard » pendant que l'écran en affichait un.
  // L'échéance est une date CIVILE suisse. On compare donc des dates civiles, pas des
  // instants : la journée d'aujourd'hui EN SUISSE contre la journée de l'échéance. Le
  // passage à l'heure d'hiver (25 octobre 2026, en plein tournoi) est géré par le fuseau
  // lui-même, sans arithmétique à faire.
  function enJourneeCivile(d) {
    var mm = d.getMonth() + 1, jj = d.getDate();
    return d.getFullYear() + '-' + (mm < 10 ? '0' : '') + mm + '-' + (jj < 10 ? '0' : '') + jj;
  }
  function aujourdhuiEnSuisse() {
    try {
      // 'en-CA' rend AAAA-MM-JJ, directement comparable comme texte.
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(new Date());
    } catch (e) {
      return enJourneeCivile(new Date());   // repli : fuseau de la machine
    }
  }
  function isMatchLate(game, isFinal, settings, allFinals) {
    var due = matchDueDate(game, isFinal, settings, allFinals);
    if (!due) return false;
    // `due` est construite à minuit LOCAL à partir de ses composantes : ses composantes
    // SONT la date civile voulue, quel que soit le fuseau de la machine.
    return aujourdhuiEnSuisse() > enJourneeCivile(due);
  }

  var api = {
    FINALS_ROUND_SEQUENCE: FINALS_ROUND_SEQUENCE,
    matchDueDate: matchDueDate,
    roundWindowStart: roundWindowStart,
    parseDateLocale: parseDateLocale,
    isMatchLate: isMatchLate
  };

  // Node (fonction Netlify)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // Navigateur (site)
  if (global) {
    global.ABCT_DATES = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : null);
