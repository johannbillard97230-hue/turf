/* ============================================================
   TURFMETRICS PRO — classement.js
   Moteur du classement des partants.

   RÈGLES INVIOLABLES (cahier des charges) :
   - tri par VALEUR DÉCROISSANTE, toujours ;
   - jamais de tri sur les cotes ;
   - jamais de modification artificielle des valeurs récupérées ;
   - classement secondaire stable en cas d'égalité.

   VALEUR : la valeur affichée est la valeur brute publiée par
   pronostics-turf.info (page presse-partants-pmu.php, mention
   « sa valeur: XXXX »). Elle est reprise à l'identique —
   aucune pondération, aucun recalcul.
   ============================================================ */

window.TM = window.TM || {};

TM.Classement = (() => {
  "use strict";

  /* Tri verrouillé : valeur décroissante ; égalité → citations
     décroissantes ; égalité → numéro croissant (stable).
     Une valeur indisponible (null) relègue le cheval en fin de
     tableau sans jamais fabriquer de donnée. */
  function trier(partants) {
    const v = p => (p.valeur == null ? -Infinity : p.valeur);
    const c = p => (p.citations == null ? -Infinity : p.citations);
    return [...partants].sort((a, b) =>
      (v(b) - v(a)) ||
      (c(b) - c(a)) ||
      (a.numero - b.numero)
    );
  }

  /* Taux de réussite depuis les chiffres réels publiés :
     (victoires + placés) / courses. Jamais extrapolé.
     Source principale : statistiques de presse-partants-pmu.php ;
     secours : fiche Canalturf. */
  function tauxReussite(p) {
    const src = (p && p.courses != null && p.victoires != null && p.places != null)
      ? p
      : (p && p.fiche && p.fiche.courses != null && p.fiche.victoires != null && p.fiche.places != null)
        ? p.fiche
        : null;
    if (!src || src.courses === 0) return null;
    return {
      pourcent: Math.round(((src.victoires + src.places) / src.courses) * 1000) / 10,
      victoires: src.victoires,
      places: src.places,
      courses: src.courses
    };
  }

  return { trier, tauxReussite };
})();
