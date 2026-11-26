/* ============================================================
   TURFMETRICS PRO — cotesref.js
   Cote de référence (« cote du matin ») : premier relevé valide
   enregistré pour une course et un cheval, FIGÉ ensuite.

   RÈGLE ABSOLUE : une référence existante n'est JAMAIS écrasée —
   l'enregistrement n'a lieu que si la clé n'existe pas encore et
   que la cote est valide. Aucune actualisation ordinaire ne peut
   la remplacer ; une nouvelle course ou une nouvelle journée crée
   des clés distinctes (jamais de mélange, jamais de réutilisation).

   Stockage : localStorage du navigateur (aucun backend, aucune
   base). Limites assumées : les références vivent sur l'appareil
   et le navigateur de l'utilisateur — elles ne sont pas partagées
   entre appareils et disparaissent si les données du navigateur
   sont effacées.
   ============================================================ */

window.TM = window.TM || {};

TM.CotesRef = (() => {
  "use strict";

  const CLE = "turfmetrics.coteref.v1";

  function lireTout() {
    try {
      const brut = localStorage.getItem(CLE);
      const obj = brut ? JSON.parse(brut) : {};
      return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
    } catch { return {}; }
  }

  function ecrireTout(obj) {
    try { localStorage.setItem(CLE, JSON.stringify(obj)); } catch { /* quota : on ne bloque jamais l'affichage */ }
  }

  /* Clé d'identification : date de course (ISO publiée par la source,
     jamais l'horloge du navigateur) | identifiant de course | dossard.
     L'identifiant de course combine réunion/course et hippodrome pour
     distinguer deux courses du même jour. */
  function cleCourse(course) {
    const rc = (course && course.reunionCourse) || "";
    const hip = (course && course.hippodrome) || "";
    return (rc + "|" + hip).toUpperCase().replace(/\s+/g, "");
  }

  function cle(dateIso, course, numero) {
    return [dateIso, cleCourse(course), String(numero)].join("|");
  }

  /* Purge discrète des références des journées passées : une
     référence n'est jamais réutilisée d'un jour sur l'autre. */
  function purger(dateIsoJour) {
    if (!dateIsoJour) return;
    const obj = lireTout();
    let modifie = false;
    for (const k of Object.keys(obj)) {
      if (k.split("|")[0] !== dateIsoJour) { delete obj[k]; modifie = true; }
    }
    if (modifie) ecrireTout(obj);
  }

  /* Enregistrement À ÉCRITURE UNIQUE.
     - clé déjà présente → on ne touche à rien (retour false) ;
     - cote invalide (absente, non numérique ou ≤ 0) → rien n'est
       enregistré : une donnée manquante ne devient jamais une
       référence.
     Retourne true uniquement lorsqu'une nouvelle référence est créée. */
  function enregistrer(dateIso, course, numero, cote, heure, nom) {
    if (!dateIso || numero == null) return false;
    const v = typeof cote === "number" ? cote : parseFloat(cote);
    if (!Number.isFinite(v) || !(v > 0)) return false;
    const obj = lireTout();
    const k = cle(dateIso, course, numero);
    if (obj[k]) return false; // RÈGLE ABSOLUE : jamais d'écrasement
    obj[k] = { cote: v, heure: heure || null, nom: nom || null };
    ecrireTout(obj);
    return true;
  }

  function lire(dateIso, course, numero) {
    if (!dateIso || numero == null) return null;
    const r = lireTout()[cle(dateIso, course, numero)];
    return r && Number.isFinite(r.cote) && r.cote > 0 ? r : null;
  }

  return { enregistrer, lire, purger, cle };
})();
