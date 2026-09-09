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
      var thisIdx = FINALS_ROUND_SEQUENCE.indexOf(game.round);
      if (thisIdx < 0) return null;          // ex. '3ème place' : pas de date propre
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

  // Un match est "en retard" dès le lendemain de son échéance : la date calculée EST la
  // date limite (le match doit être terminé et le score saisi avant la fin de ce jour-là).
  // ⚠️ Ne pas rajouter d'intervalle de grâce ici : historiquement l'échéance marquait le
  // DÉBUT de la fenêtre de jeu, ce qui justifiait d'attendre un intervalle de plus. Depuis
  // que l'échéance est la vraie date limite, ce délai supplémentaire doublait l'attente.
  function isMatchLate(game, isFinal, settings, allFinals) {
    var due = matchDueDate(game, isFinal, settings, allFinals);
    if (!due) return false;
    var dueEnd = new Date(due);
    dueEnd.setHours(23, 59, 59, 999); // toute la journée de l'échéance reste jouable
    return Date.now() > dueEnd.getTime();
  }

  var api = {
    FINALS_ROUND_SEQUENCE: FINALS_ROUND_SEQUENCE,
    matchDueDate: matchDueDate,
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
