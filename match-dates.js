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

  // Date d'échéance d'un match.
  //   Poule  -> poolStartDate + (round - 1) * poolInterval
  //   Finale -> finalsStartDate + position * finalsInterval, où la position est
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

      var df = new Date(startDate);
      if (isNaN(df.getTime())) return null;  // date de réglage invalide
      df.setDate(df.getDate() + (position + 1) * interval);
      return df;
    }

    var poolStart = s.poolStartDate;
    var poolInterval = s.poolInterval || 4;
    if (!poolStart || !game.round) return null;
    var d = new Date(poolStart);
    if (isNaN(d.getTime())) return null;
    d.setDate(d.getDate() + game.round * poolInterval);
    return d;
  }

  // Un match est "en retard" quand plus d'un intervalle complet s'est écoulé
  // APRÈS sa date d'échéance (on laisse donc une marge d'un intervalle).
  function isMatchLate(game, isFinal, settings, allFinals) {
    var s = settings || {};
    var interval = (isFinal ? s.finalsInterval : s.poolInterval) || 4;
    var due = matchDueDate(game, isFinal, settings, allFinals);
    if (!due) return false;
    var daysPassed = (Date.now() - due.getTime()) / (1000 * 60 * 60 * 24);
    return daysPassed > interval;
  }

  var api = {
    FINALS_ROUND_SEQUENCE: FINALS_ROUND_SEQUENCE,
    matchDueDate: matchDueDate,
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
