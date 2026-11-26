/* ============================================================
   TURFMETRICS PRO — app.js
   Orchestration : actualisation, affichage, sélection des
   8 chevaux (sessionStorage), rapport de récupération.
   ============================================================ */

window.TM = window.TM || {};

TM.App = (() => {
  "use strict";

  const CLE_SESSION = "turfmetrics.selection8";
  const MAX_SELECTION = 8;

  const $ = id => document.getElementById(id);

  const etat = {
    partantsTries: [],
    chargementEnCours: false,
    favoris: new Set(),
    plat: false // course de plat : la colonne Déferrage affiche la corde
  };

  /* ---------- Sélection (session du navigateur) ---------- */

  function lireSelection() {
    try {
      const brut = sessionStorage.getItem(CLE_SESSION);
      const liste = brut ? JSON.parse(brut) : [];
      return Array.isArray(liste) ? liste.slice(0, MAX_SELECTION) : [];
    } catch { return []; }
  }

  function ecrireSelection(liste) {
    sessionStorage.setItem(CLE_SESSION, JSON.stringify(liste));
  }

  function basculerSelection(numero) {
    let sel = lireSelection();
    if (sel.includes(numero)) {
      sel = sel.filter(n => n !== numero);
      // Retrait volontaire du favori : respecté jusqu'à la fin de session
      if (etat.favoris.has(numero)) sessionStorage.setItem(`${CLE_SESSION}.retire.${numero}`, "1");
    } else {
      if (sel.length >= MAX_SELECTION) return false; // bloqué à 8
      sel.push(numero);
      sessionStorage.removeItem(`${CLE_SESSION}.retire.${numero}`);
    }
    ecrireSelection(sel);
    majSelectionUI();
    majCasesTableau();
    return true;
  }

  /* ---------- Favori de la course ----------
     Le favori est le cheval dont la COTE ACTUELLE est la plus faible
     (donnée réelle issue des relevés PMU/Canalturf — les cotes ne
     servent JAMAIS à classer le tableau, uniquement à identifier le
     favori). Ex æquo : tous les chevaux à la cote minimale.
     Sans cotes publiées : aucun favori, rien n'est deviné. */

  function numerosFavoris(partants) {
    let min = null;
    for (const p of partants) {
      if (p.coteActuelle == null) continue;
      if (min === null || p.coteActuelle < min) min = p.coteActuelle;
    }
    if (min === null) return new Set();
    return new Set(partants.filter(p => p.coteActuelle === min).map(p => p.numero));
  }

  // Sélection automatique : le favori est ajouté à la sélection (dans
  // la limite des 8) dès que les cotes sont disponibles. L'utilisateur
  // peut le retirer manuellement à tout moment — sa décision est
  // respectée pour la session (le favori n'est pas ré-imposé).
  function synchroniserFavori(favoris) {
    if (!favoris.size) return;
    let sel = lireSelection();
    let modifie = false;
    for (const num of favoris) {
      if (sel.includes(num)) continue;
      const cleRetrait = `${CLE_SESSION}.retire.${num}`;
      if (sessionStorage.getItem(cleRetrait)) continue; // retiré volontairement
      if (sel.length >= MAX_SELECTION) break;
      sel.push(num);
      modifie = true;
    }
    if (modifie) ecrireSelection(sel);
  }

  function majSelectionUI() {
    const sel = lireSelection();
    const compteur = $("compteur");
    compteur.textContent = `${sel.length}/${MAX_SELECTION}`;
    compteur.classList.toggle("plein", sel.length === MAX_SELECTION);

    const liste = $("selection-liste");
    const vide = $("selection-vide");
    liste.innerHTML = "";
    vide.hidden = sel.length > 0;

    const parNum = new Map(etat.partantsTries.map(p => [p.numero, p]));
    for (const num of sel) {
      const p = parNum.get(num);
      const li = document.createElement("li");
      li.className = "jeton";
      const nom = document.createElement("span");
      const numEl = document.createElement("span");
      numEl.className = "jeton-num";
      numEl.textContent = num;
      nom.append(numEl, document.createTextNode(" " + (p ? p.nom : "—")));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "×";
      btn.setAttribute("aria-label", `Retirer le numéro ${num} de la sélection`);
      btn.addEventListener("click", () => basculerSelection(num));
      li.append(nom, btn);
      liste.appendChild(li);
    }
  }

  function majCasesTableau() {
    const sel = lireSelection();
    const plein = sel.length >= MAX_SELECTION;
    document.querySelectorAll(".case-sel").forEach(caseEl => {
      const num = parseInt(caseEl.dataset.numero, 10);
      const coche = sel.includes(num);
      caseEl.checked = coche;
      caseEl.disabled = !coche && plein;
      const ligne = caseEl.closest("tr");
      if (ligne) ligne.classList.toggle("selectionne", coche);
      const carte = caseEl.closest(".carte-cheval");
      if (carte) carte.classList.toggle("selectionne", coche);
    });
  }

  /* ---------- Affichage ---------- */

  function echappe(txt) {
    const d = document.createElement("div");
    d.textContent = txt == null ? "" : String(txt);
    return d.innerHTML;
  }

  function afficheND(rouge) {
    return `<span class="nd${rouge ? " rouge" : ""}">N/D</span>`;
  }

  function majSources(statuts, enCours) {
    const correspondance = {
      valeur: statuts.valeur,
      citations: statuts.citations,
      fiches: statuts.fiches,
      cotes: statuts.cotes,
      corde: statuts.corde,
      handicap: statuts.handicap
    };
    document.querySelectorAll(".source-pill").forEach(pill => {
      const s = correspondance[pill.dataset.source];
      const etatTxt = pill.querySelector(".pill-etat");
      pill.classList.remove("ok", "ko", "partiel", "attente");
      if (!s) { etatTxt.textContent = "—"; return; }
      if (enCours) {
        pill.classList.add("attente");
        etatTxt.textContent = "…";
      } else if (s.etat === "na") {
        // Source sans objet pour la course du jour (ex. turf-fr.com
        // en attelé : la corde y est déjà lue dans les valeurs).
        pill.classList.add("attente");
        etatTxt.textContent = "Sans objet";
        pill.title = s.detail || "";
      } else {
        pill.classList.add(s.etat === "ok" ? "ok" : s.etat === "partiel" ? "partiel" : "ko");
        etatTxt.textContent = s.etat === "ok" ? "✓ OK" : s.etat === "partiel" ? "Partiel" : "✗ Échec";
        pill.title = s.detail || "";
      }
    });
  }

  function afficherCourse(course, partants) {
    if (!course) return;

    /* ---------- Cote de référence (« cote du matin ») ----------
       Premier relevé valide enregistré pour cette course sur ce
       navigateur, FIGÉ ensuite (TM.CotesRef — écriture unique,
       jamais d'écrasement par une actualisation).
       - Référence candidate : le PREMIER point de la série horodatée
         de la source (= premier relevé publié de la journée). Si la
         première consultation a lieu avant l'ouverture des relevés,
         rien n'est enregistré (N/D) — la première cote valide vue
         ensuite devient la référence, avec son heure réelle affichée.
       - Clé : date de course (ISO publiée par la source) + identifiant
         de course + dossard → jamais de mélange entre deux courses
         ni de réutilisation d'une journée sur l'autre. */
    const dateIso = TM.Sources.isoDepuisDateTexte(course.dateTexte) || null;
    if (dateIso && window.TM && TM.CotesRef) {
      TM.CotesRef.purger(dateIso);
      for (const p of partants) {
        p.cotePremiere = p.cotePremiere != null ? p.cotePremiere : null;
        if (p.cotePremiere != null) {
          TM.CotesRef.enregistrer(dateIso, course, p.numero, p.cotePremiere, p.heurePremiere || null, p.nom);
        }
        const ref = TM.CotesRef.lire(dateIso, course, p.numero);
        p.coteReference = ref ? ref.cote : null;
        p.heureReference = ref ? ref.heure : null;
      }
    } else {
      for (const p of partants) { p.coteReference = null; p.heureReference = null; }
    }

    $("titre-course").textContent = course.nom || "Course du jour";
    $("fact-hippodrome").textContent = course.hippodrome || "N/D";
    $("fact-rc").textContent = course.reunionCourse || "N/D";
    $("fact-partants").textContent = String(partants.length);
    $("fact-distance").textContent = course.distance || "N/D";
    $("fact-allocation").textContent = course.allocation || "N/D";
    $("fact-discipline").textContent = course.discipline || "N/D";
    // Heure du dernier relevé de cotes publié par la source (Canalturf)
    const elCotes = $("fact-cotes-heure");
    if (elCotes) elCotes.textContent = course.heureCotes ? course.heureCotes : "N/D";
    // En-têtes adaptés à la discipline réellement publiée :
    //   attelé → « Corde » (poteau) + « Déferrage »
    //   plat   → « Poids » + « Corde » (le déferrage est sans objet
    //            en plat : sa colonne accueille le n° de corde réel,
    //            lu sur turf-fr.com — jamais déduit ni fabriqué)
    const plat = partants.some(p => p.poids != null) && !partants.some(p => p.poteau != null);
    etat.plat = plat;
    const th = $("th-corde");
    if (th) th.textContent = plat ? "Poids" : "Corde";
    const thDef = $("th-def");
    if (thDef) thDef.textContent = plat ? "Corde" : "Déferrage";
  }

  function renduTaux(p) {
    const t = TM.Classement.tauxReussite(p);
    if (!t) return afficheND();
    const pc = t.pourcent.toFixed(1).replace(".", ",");
    return `
      <div class="taux-ligne">
        <span class="pourcent">${pc}%</span>
        <span class="detail">(${t.victoires} V + ${t.places} P) / ${t.courses} courses</span>
      </div>
      <div class="barre"><div class="barre-remplissage" style="width:${Math.min(100, t.pourcent)}%"></div></div>`;
  }

  function renduValeur(p) {
    if (p.valeur == null) return { html: afficheND(true), largeur: 0 };
    return { html: `<span class="valeur-chiffre">${p.valeur}</span>`, largeur: p.valeur };
  }

  function renduCitations(p) {
    if (p.citations == null) return afficheND();
    return `<span class="cit-chiffre">${p.citations}</span>`;
  }

  /* Corde (attelé) ou Poids (plat) : la source publie l'un ou l'autre
     selon la discipline — on affiche la donnée réelle, jamais un
     numéro de corde inventé en plat. */
  function renduCorde(p) {
    if (p.poteau != null) return `<span class="corde-num">${p.poteau}</span>`;
    if (p.poids != null) return `<span class="corde-num" title="Poids porté (course de plat)">${echappe(p.poids)} kg</span>`;
    return afficheND();
  }

  /* Colonne DÉFERRAGE (attelé) / CORDE (plat) : en plat le déferrage
     est sans objet — la colonne affiche le numéro de corde réel publié
     par turf-fr.com (« C3 », « C12 »…). N/D si la source ne l'a pas
     fourni : rien n'est déduit du dossard ni fabriqué. */
  function renduDeferrage(p) {
    if (etat.plat) {
      if (p.corde == null) return afficheND();
      return `<span class="corde-num corde-plat" title="Numéro de corde (stalles de départ) — source turf-fr.com">C${p.corde}</span>`;
    }
    if (p.deferreCode == null) return afficheND();
    const cls = p.deferreCode === "D4" ? "def-code d4" : "def-code";
    const titreTxt = p.deferre || p.deferreInfo || "";
    const titre = titreTxt ? ` title="${echappe(titreTxt)}"` : "";
    return `<span class="${cls}"${titre}>${p.deferreCode}</span>`;
  }

  function etiquetteCorde() {
    const th = $("th-corde");
    return th && th.textContent === "Poids" ? "Poids" : "Corde";
  }

  function etiquetteDef() {
    const th = $("th-def");
    return th ? th.textContent : "Déferrage";
  }

  /* Statistiques réelles (victoires / places) : presse-partants en
     priorité, fiche Canalturf en repli. null si indisponible — rien
     n'est fabriqué. */
  function statsDe(p) {
    if (!p) return null;
    if (p.victoires != null || p.places != null) {
      return { victoires: p.victoires, places: p.places };
    }
    if (p.fiche && (p.fiche.victoires != null || p.fiche.places != null)) {
      return { victoires: p.fiche.victoires, places: p.fiche.places };
    }
    return null;
  }

  /* Distinctions : plus de victoires (or) / plus de places (turquoise).
     Ex æquo : tous les chevaux à égalité sont distingués. */
  function calculDistinctions(partants) {
    let maxV = 0, maxP = 0;
    for (const p of partants) {
      const s = statsDe(p);
      if (!s) continue;
      if (s.victoires != null && s.victoires > maxV) maxV = s.victoires;
      if (s.places != null && s.places > maxP) maxP = s.places;
    }
    return p => {
      const s = statsDe(p);
      return {
        vic: !!(s && maxV > 0 && s.victoires === maxV),
        plc: !!(s && maxP > 0 && s.places === maxP)
      };
    };
  }

  function badgesDistinction(dist) {
    let h = "";
    if (dist.vic) h += `<span class="distinction dist-vic" title="Plus grand nombre de victoires parmi les partants (ex æquo inclus)">★ Max victoires</span>`;
    if (dist.plc) h += `<span class="distinction dist-plc" title="Plus grand nombre de places parmi les partants (ex æquo inclus)">◆ Max places</span>`;
    return h ? `<span class="distinctions">${h}</span>` : "";
  }

  /* Cotes PMU relevées par Canalturf : « actuelle » = dernier point
     de la série horodatée, « dernière » = point précédent.
     Format identique à PMU Play (2.9, 8.8, 71) ; N/D si la source
     n'a pas de valeur — rien n'est inventé. */
  function renduCote(valeur, heure) {
    if (valeur == null) return afficheND();
    const titre = heure ? ` title="Relevé ${echappe(heure)} (source Canalturf)"` : "";
    return `<span class="cote-chiffre"${titre}>${String(valeur).replace(".", ",")}</span>`;
  }

  /* Cote de référence (« cote du matin ») : premier relevé valide
     enregistré pour cette course sur ce navigateur — figé ensuite.
     L'heure affichée est celle du relevé enregistré : si la première
     cote disponible n'a été vue qu'en cours de journée, l'heure le
     dit clairement (jamais présentée comme un relevé du matin). */
  function renduCoteReference(p) {
    if (p.coteReference == null) return afficheND();
    const titre = p.heureReference
      ? ` title="Premier relevé enregistré à ${echappe(p.heureReference)} — référence figée pour cette course (stockage local de ce navigateur)"`
      : ' title="Référence figée pour cette course (stockage local de ce navigateur)"';
    return `<span class="cote-ref"${titre}><span class="cote-chiffre">${String(p.coteReference).replace(".", ",")}</span>` +
      (p.heureReference ? `<span class="cote-ref-heure">${echappe(p.heureReference)}</span>` : "") + `</span>`;
  }

  /* Variation de cote PMU : (actuelle − référence) / référence × 100,
     la référence étant la COTE DU MATIN figée — jamais le relevé
     précédent. Aucun calcul si une des deux cotes manque ou si la
     référence vaut 0 → N/D. Simple évolution de cote, jamais une
     prédiction. */
  function renduVariation(p) {
    const d = p.coteReference, a = p.coteActuelle;
    if (d == null || a == null || !(d > 0)) return afficheND();
    const v = Math.round(((a - d) / d) * 1000) / 10;
    const cls = v < 0 ? "var-baisse" : v > 0 ? "var-hausse" : "var-stable";
    const fleche = v < 0 ? "\u25BC" : v > 0 ? "\u25B2" : "\u25B6";
    const pct = Math.abs(v).toFixed(1).replace(".", ",");
    const signe = v > 0 ? "+" : v < 0 ? "\u2212" : "";
    const flux = String(d).replace(".", ",") + " \u2192 " + String(a).replace(".", ",");
    const titre = "Variation depuis la cote matin (référence figée, source Canalturf) — simple évolution de la cote : une baisse n'est en aucun cas une garantie de performance.";
    return `<span class="variation-bloc ${cls}" title="${titre}"><span class="var-flux">${flux}</span><span class="var-valeur">${fleche} ${signe}${pct} %</span></span>`;
  }

  function renduSexeAge(p) {
    if (p.fiche && p.fiche.sexeAge) return `<span class="sexe-age">${echappe(p.fiche.sexeAge)}</span>`;
    if (p.age != null) return `<span class="sexe-age">${p.age} ans</span>`;
    return afficheND();
  }

  function badgeFavori(p) {
    if (!etat.favoris.has(p.numero)) return "";
    const cote = p.coteActuelle != null ? String(p.coteActuelle).replace(".", ",") : "N/D";
    return `<span class="favori-badge" title="Favori de la course — cote actuelle ${cote} (plus faible cote PMU relevée)">★ Favori</span>`;
  }

  function ligneIdentite(p) {
    const duo = [p.jockey, p.entraineur].filter(Boolean).join(" · ");
    return `
      <span class="identite">
        <span class="num-cheval">${p.numero}</span>
        <span>
          <span class="nom-cheval">${echappe(p.nom)}</span>${badgeFavori(p)}
          <span class="jockey">${duo ? echappe(duo) : ""}</span>
        </span>
      </span>`;
  }

  /* Coloration individuelle des places : 1er vert, 2e bleu, 3e orange,
     4e violet, 5e rose. Les autres résultats gardent l'apparence
     standard. L'ordre chronologique des sorties n'est pas modifié. */
  function classePlace(place) {
    if (!place) return "place";
    const t = String(place).toLowerCase().replace(/\s/g, "").replace("ème", "e");
    if (t === "1er" || t === "1e" || t === "1") return "place p1";
    if (t === "2e" || t === "2") return "place p2";
    if (t === "3e" || t === "3") return "place p3";
    if (t === "4e" || t === "4") return "place p4";
    if (t === "5e" || t === "5") return "place p5";
    return "place";
  }

  function renduSorties(p) {
    if (!p.fiche || !p.fiche.sorties.length) return afficheND();
    return p.fiche.sorties.map(s => {
      const cls = classePlace(s.place);
      const course = s.course ? ` — ${echappe(s.course)}` : "";
      return `<span class="sortie" title="${echappe(s.place)} · ${echappe(s.date)} · ${echappe(s.hippodrome)}${course}"><span class="${cls}">${echappe(s.place)}</span> · ${echappe(s.date)} · ${echappe(s.hippodrome)}${course}</span>`;
    }).join("");
  }

  function ligneTableau(p, rang, valeurMax, citMax, dist) {
    const tr = document.createElement("tr");
    tr.dataset.numero = p.numero;
    tr.dataset.rang = rang;
    if (rang <= 10) tr.classList.add("top10");
    if (dist && dist.vic) tr.classList.add("dist-v");
    if (dist && dist.plc) tr.classList.add("dist-p");
    if (etat.favoris.has(p.numero)) tr.classList.add("favori");

    const largeurValeur = valeurMax > 0 && p.valeur != null ? Math.max(3, Math.round((p.valeur / valeurMax) * 100)) : 0;
    const largeurCit = citMax > 0 && p.citations != null ? Math.max(3, Math.round((p.citations / citMax) * 100)) : 0;
    const v = renduValeur(p);

    tr.innerHTML = `
      <td class="col-sel">
        <span class="case-sel-wrap">
          <input type="checkbox" class="case-sel" data-numero="${p.numero}"
                 aria-label="Sélectionner le numéro ${p.numero}, ${echappe(p.nom)}">
        </span>
      </td>
      <td class="col-nom">${ligneIdentite(p)}</td>
      <td class="col-valeur">
        <div class="valeur-bloc">
          ${v.html}
          <div class="barre"><div class="barre-remplissage" style="width:${largeurValeur}%"></div></div>
        </div>
      </td>
      <td class="col-cit">
        <div class="citations-bloc">
          ${renduCitations(p)}
          <div class="cit-barre"><span style="width:${largeurCit}%"></span></div>
        </div>
      </td>
      <td class="col-corde">${renduCorde(p)}</td>
      <td class="col-def">${renduDeferrage(p)}</td>
      <td class="col-coted">${renduCoteReference(p)}</td>
      <td class="col-cotea">${renduCote(p.coteActuelle, p.heureCotes)}</td><td class="col-variation">${renduVariation(p)}</td>
      <td class="col-sexe">${renduSexeAge(p)}</td>
      <td class="col-taux"><div class="taux">${renduTaux(p)}${dist ? badgesDistinction(dist) : ""}</div></td>
      <td class="col-sorties"><div class="sorties">${renduSorties(p)}</div></td>`;
    return tr;
  }

  function carteMobile(p, rang, valeurMax, citMax, dist) {
    const div = document.createElement("article");
    div.className = "carte-cheval" + (rang <= 10 ? " top10" : "");
    if (dist && dist.vic) div.classList.add("dist-v");
    if (dist && dist.plc) div.classList.add("dist-p");
    if (etat.favoris.has(p.numero)) div.classList.add("favori");
    div.dataset.numero = p.numero;
    const largeurValeur = valeurMax > 0 && p.valeur != null ? Math.max(3, Math.round((p.valeur / valeurMax) * 100)) : 0;
    const t = TM.Classement.tauxReussite(p);
    const v = renduValeur(p);
    const duo = [p.jockey, p.entraineur].filter(Boolean).join(" · ");

    div.innerHTML = `
      <div class="carte-ligne1">
        <span class="carte-id">
          <span class="num-cheval">${p.numero}</span>
          <span>
            <span class="nom-cheval">${echappe(p.nom)}</span>${badgeFavori(p)}
            <span class="jockey">${duo ? echappe(duo) : ""}</span>
          </span>
        </span>
        ${v.html}
      </div>
      <div class="carte-valeur">
        <div class="barre"><div class="barre-remplissage" style="width:${largeurValeur}%"></div></div>
      </div>
      <div class="carte-infos">
        <span><span class="etiquette">Citations</span>${renduCitations(p)}</span>
        <span><span class="etiquette">${etiquetteCorde()}</span>${renduCorde(p)}</span>
        <span><span class="etiquette">${etiquetteDef()}</span>${renduDeferrage(p)}</span>
        <span><span class="etiquette">Cote matin</span>${renduCoteReference(p)}</span>
        <span><span class="etiquette">Cote actuelle</span>${renduCote(p.coteActuelle, p.heureCotes)}</span><span><span class="etiquette">Variation depuis le matin</span>${renduVariation(p)}</span>
        <span><span class="etiquette">Sexe · Âge</span>${renduSexeAge(p)}</span>
        <span><span class="etiquette">Taux de réussite</span>${t ? `<span class="pourcent" style="font-family:var(--fonte-mono);color:var(--emeraude);font-weight:600">${t.pourcent.toFixed(1).replace(".", ",")}%</span> <span class="detail">(${t.victoires} V + ${t.places} P) / ${t.courses}</span>` : afficheND()}${dist ? badgesDistinction(dist) : ""}</span>
        <span class="sorties"><span class="etiquette">3 dernières sorties</span>${renduSorties(p)}</span>
      </div>
      <div class="carte-sel-ligne">
        <label>
          <input type="checkbox" class="case-sel" data-numero="${p.numero}">
          Ajouter à mes 8 chevaux
        </label>
      </div>`;
    return div;
  }

  function afficherTableau(partantsTries) {
    const tbody = $("tbody-partants");
    const cartes = $("cartes-partants");
    tbody.innerHTML = "";
    cartes.innerHTML = "";

    if (!partantsTries.length) {
      tbody.innerHTML = `<tr class="ligne-etat"><td colspan="11">Aucun partant récupéré. Consultez le rapport de récupération.</td></tr>`;
      return;
    }

    const valeurMax = Math.max(...partantsTries.map(p => p.valeur == null ? 0 : p.valeur), 0);
    const citMax = Math.max(...partantsTries.map(p => p.citations == null ? 0 : p.citations), 0);
    const distinctions = calculDistinctions(partantsTries);

    // Favori (plus faible cote actuelle) : mis en évidence et ajouté
    // automatiquement à la sélection (dans la limite des 8, sans
    // ré-imposer un favori retiré volontairement).
    etat.favoris = numerosFavoris(partantsTries);
    synchroniserFavori(etat.favoris);

    partantsTries.forEach((p, i) => {
      const dist = distinctions(p);
      tbody.appendChild(ligneTableau(p, i + 1, valeurMax, citMax, dist));
      cartes.appendChild(carteMobile(p, i + 1, valeurMax, citMax, dist));
    });

    document.querySelectorAll(".case-sel").forEach(caseEl => {
      caseEl.addEventListener("change", () => {
        const num = parseInt(caseEl.dataset.numero, 10);
        const ok = basculerSelection(num);
        if (!ok) caseEl.checked = false; // 8 déjà atteints : on refuse
      });
    });
    majCasesTableau();
  }

  /* Dernière arrivée du Quinté+ (8 premiers, donnée réelle Canalturf)
     + heure de la prochaine course (aujourd'hui si la course du jour
     n'est pas courue, demain sinon). N/D si la source ne fournit pas
     la donnée — rien n'est reconstitué. */
  function afficherArriveeProchaine(course) {
    const meta = $("arrivee-meta");
    const liste = $("arrivee-liste");
    const nd = $("arrivee-nd");
    liste.innerHTML = "";

    const arr = course && course.arriveeDerniere;
    if (arr && arr.arrivee && arr.arrivee.length) {
      const morceaux = [];
      if (arr.dateTexte) morceaux.push(arr.dateTexte);
      if (arr.nom) morceaux.push(arr.nom);
      if (arr.hippodrome) morceaux.push(arr.hippodrome);
      meta.textContent = morceaux.join(" — ") || "—";
      nd.hidden = true;
      for (const c of arr.arrivee) {
        const li = document.createElement("li");
        const cls = classePlace(c.place === 1 ? "1er" : c.place + "e");
        li.innerHTML = `<span class="${cls}">${c.place}${c.place === 1 ? "er" : "e"}</span>`
          + `<span class="arr-num">${c.numero}</span>`
          + `<span class="arr-nom">${echappe(c.nom)}</span>`;
        liste.appendChild(li);
      }
    } else {
      meta.textContent = "—";
      nd.hidden = false;
    }

    const pro = course && course.prochaineCourse;
    $("prochaine-heure").textContent = pro && pro.heure ? pro.heure : "N/D";
    const bits = [];
    // Date réelle de la course (publiée par la source) plutôt qu'un
    // libellé « aujourd'hui / demain » — repli sur le libellé si la
    // date n'est pas disponible, jamais de date devinée.
    if (pro && pro.dateTexte) bits.push(pro.dateTexte);
    else if (pro && pro.jour) bits.push(pro.jour.charAt(0).toUpperCase() + pro.jour.slice(1));
    if (pro && pro.nom) bits.push(pro.nom);
    $("prochaine-nom").textContent = bits.length ? bits.join(" — ") : (pro ? "—" : "Indisponible à la source");
  }

  /* Bloc « Analyse du handicap » (handicaps de plat uniquement).
     Rendu des données calculées dans sources.js : moyenne du
     peloton, écarts, avantage poids (kg), forme et profil
     qualitatif avec justification chiffrée. Le bloc reste masqué
     pour toute course non handicap ou en cas de donnée manquante —
     rien n'est reconstitué. */
  function afficherHandicap(course) {
    const bloc = $("bloc-handicap");
    const hc = course && course.handicapData;
    if (!hc || !hc.lignes || !hc.lignes.length) {
      bloc.hidden = true;
      return;
    }
    bloc.hidden = false;

    const fmt = v => (Math.round(v * 10) / 10).toString().replace(".", ",");
    const signe = v => (v >= 0 ? "+" : "") + fmt(v);
    const nd = '<span class="hc-nd">N/D</span>';

    const labelBande = { sprint: "Sprint (≤ 1400 m)", intermediaire: "Distance intermédiaire", long: "Longue distance (≥ 2200 m)" };
    $("hc-course").textContent = [course.nom, hc.distance, hc.bande ? labelBande[hc.bande] : null]
      .filter(Boolean).join(" · ");
    $("hc-moyenne").textContent = fmt(hc.moyenne);
    $("hc-evalues").textContent = hc.nbEvalues === hc.nbPartants
      ? `${hc.nbEvalues} partants évalués`
      : `${hc.nbEvalues}/${hc.nbPartants} partants évalués (valeur absente exclue, jamais remplacée par zéro)`;

    const classeProfil = p => p === "PROFIL FAVORABLE" ? "profil-favorable"
      : p === "PROFIL À SURVEILLER" ? "profil-surveiller"
      : p === "PROFIL MOINS FAVORABLE" ? "profil-moins" : "profil-nd";
    const badge = l => l.profil
      ? `<span class="badge-profil ${classeProfil(l.profil)}" title="${echappe(l.justification || "")}">${l.profil}</span>`
      : nd;

    const tbody = $("hc-tbody");
    tbody.innerHTML = "";
    for (const l of hc.lignes) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="hc-num">${l.numero}</td>`
        + `<td class="hc-nom" title="${echappe(l.justification || "données insuffisantes — pas de profil")}">${echappe(l.nom)}</td>`
        + `<td class="hc-val">${l.valeur != null ? fmt(l.valeur) : nd}</td>`
        + `<td class="hc-ecart">${l.ecart != null ? signe(l.ecart) : nd}</td>`
        + `<td>${l.poids != null ? fmt(l.poids) + " kg" : nd}</td>`
        + `<td class="hc-corde">${l.corde != null ? "C" + l.corde : nd}</td>`
        + `<td class="hc-avantage">${l.avantage != null ? signe(l.avantage) + " kg" : nd}</td>`
        + `<td class="hc-forme">${l.forme ? l.forme.top5 + "/" + l.forme.sorties : nd}</td>`
        + `<td>${badge(l)}</td>`;
      tbody.appendChild(tr);
    }

    // Mobile : cartes empilées, une par cheval
    const cartes = $("hc-cartes");
    cartes.innerHTML = "";
    for (const l of hc.lignes) {
      const c = document.createElement("article");
      c.className = "hc-carte";
      c.innerHTML =
        `<header><span class="hc-num">${l.numero}</span><strong>${echappe(l.nom)}</strong>${badge(l)}</header>`
        + `<dl>`
        + `<div><dt>Valeur handicap</dt><dd>${l.valeur != null ? fmt(l.valeur) : "N/D"}</dd></div>`
        + `<div><dt>Écart / moyenne</dt><dd>${l.ecart != null ? signe(l.ecart) : "N/D"}</dd></div>`
        + `<div><dt>Poids porté</dt><dd>${l.poids != null ? fmt(l.poids) + " kg" : "N/D"}</dd></div>`
        + `<div><dt>Corde</dt><dd>${l.corde != null ? "C" + l.corde : "N/D"}</dd></div>`
        + `<div><dt>Avantage poids</dt><dd>${l.avantage != null ? signe(l.avantage) + " kg" : "N/D"}</dd></div>`
        + `<div><dt>Forme (top-5)</dt><dd>${l.forme ? l.forme.top5 + "/" + l.forme.sorties : "N/D"}</dd></div>`
        + `</dl>`
        + (l.justification ? `<p class="hc-justif">${echappe(l.justification)}</p>` : "");
      cartes.appendChild(c);
    }
  }

  function afficherRapport(partants, statuts, erreurs) {
    const nb = partants.length;
    const citationsKO = statuts.citations && statuts.citations.etat === "ko";
    const sansCitation = partants.filter(p => p.citations === 0).length;
    const citationsND = partants.filter(p => p.citations == null).length;
    const sansSexeAge = partants.filter(p => !(p.fiche && p.fiche.sexeAge) && p.age == null).length;
    const sansSorties = partants.filter(p => !p.fiche || !p.fiche.sorties.length).length;

    $("rapport-resume").textContent = nb === 0
      ? "Aucun cheval analysé — la source des valeurs (pronostics-turf.info) est indisponible."
      : `${nb} chevaux analysés — ${sansCitation} sans citation (0) — ${citationsKO ? citationsND + " citations N/D — " : ""}${erreurs.length} erreur(s) de récupération`;

    const details = [];
    for (const cle of Object.keys(statuts)) {
      const s = statuts[cle];
      const libelle = s.etat === "ok" ? "opérationnel"
        : s.etat === "partiel" ? "partiellement opérationnel"
        : s.etat === "na" ? "sans objet pour cette course"
        : "indisponible";
      details.push({ txt: `${s.nom} : ${libelle}${s.detail ? " — " + s.detail : ""}`, erreur: s.etat === "ko" });
    }
    // Tous les canaux ont échoué → expliquer pourquoi et comment réparer
    if (nb === 0) {
      const proxyVu = erreurs.some(e => /proxy/.test(e));
      const directVu = erreurs.some(e => /accès direct/.test(e));
      if (proxyVu && directVu) {
        details.push({
          txt: "La page est servie sans les fonctions proxy (aperçu statique) ou le proxy est en échec : pronostics-turf.info est désormais protégé par une vérification anti-bot (YOORhosting) que la dernière version du proxy contourne automatiquement. Vérifiez que le site déployé inclut bien les fichiers proxy à jour (netlify/functions/proxy.js ou api/proxy.js) — redéployez le ZIP complet si besoin.",
          erreur: true
        });
      }
    }
    if (sansCitation > 0) details.push({ txt: `${sansCitation} cheval(aux) non cité(s) dans la revue de presse — affiché(s) 0`, erreur: false });
    if (sansSexeAge > 0) details.push({ txt: `${sansSexeAge} cheval(aux) sans Sexe/Âge (fiche indisponible)`, erreur: false });
    if (sansSorties > 0 && sansSorties <= nb) details.push({ txt: `${sansSorties} cheval(aux) sans dernières sorties exploitables`, erreur: false });
    details.push({ txt: "Les cellules marquées N/D indiquent une donnée indisponible. Un cheval « non cité » affiche 0. Aucune valeur n'est fabriquée ni modifiée.", erreur: false });
    for (const e of erreurs.slice(0, 6)) details.push({ txt: e, erreur: true });

    const ul = $("rapport-details");
    ul.innerHTML = "";
    for (const d of details) {
      const li = document.createElement("li");
      li.textContent = d.txt;
      if (d.erreur) li.classList.add("erreur");
      ul.appendChild(li);
    }
  }

  /* ---------- Actualisation ---------- */

  async function actualiser() {
    if (etat.chargementEnCours) return;
    etat.chargementEnCours = true;

    const btn = $("btn-actualiser");
    btn.disabled = true;
    btn.classList.add("charge");
    $("loader").hidden = false;
    majSources({ valeur: { etat: "attente" }, citations: { etat: "attente" }, fiches: { etat: "attente" }, cotes: { etat: "attente" }, corde: { etat: "attente" } }, true);

    const etape = txt => { $("loader-text").textContent = txt; };

    try {
      const { course, partants, statuts, erreurs } = await TM.Sources.actualiserTout(etape);

      if (partants.length) {
        etat.partantsTries = TM.Classement.trier(partants);
        afficherCourse(course, partants);
        afficherTableau(etat.partantsTries);
        majSelectionUI(); // réaffiche les noms des chevaux sélectionnés
      }
      afficherArriveeProchaine(course);
      afficherHandicap(course);
      afficherRapport(partants, statuts, erreurs);
      majSources(statuts, false);
      $("heure-synchro").textContent = new Date().toLocaleTimeString("fr-FR");
    } catch (e) {
      $("rapport-resume").textContent = "Échec global de l'actualisation : " + e.message;
    } finally {
      $("loader").hidden = true;
      btn.disabled = false;
      btn.classList.remove("charge");
      etat.chargementEnCours = false;
    }
  }

  /* ---------- Démarrage ---------- */

  function init() {
    $("date-du-jour").textContent = new Date().toLocaleDateString("fr-FR", {
      weekday: "long", day: "2-digit", month: "2-digit", year: "numeric"
    });

    /* Bandeau des états repliable — réservé au mobile : le bouton est masqué
       au-delà de 880 px et la présentation ordinateur est inchangée.
       État conservé en mémoire uniquement (développé par défaut à chaque
       ouverture, conservé pendant toute la navigation dans la page).
       Les pastilles restent dans le DOM : les statuts continuent d'être
       mis à jour même lorsque le bandeau est réduit. */
    const btnSources = $("btn-sources-toggle");
    if (btnSources) {
      const nb = document.querySelectorAll("#sources .source-pill").length;
      const titre = btnSources.querySelector(".sources-toggle-titre");
      if (titre && nb) titre.textContent = `ÉTAT DES SOURCES · ${nb} INDICATEURS`;
      const libelle = btnSources.querySelector(".sources-toggle-label");
      btnSources.addEventListener("click", () => {
        const replie = document.querySelector(".topbar").classList.toggle("sources-replie");
        btnSources.setAttribute("aria-expanded", String(!replie));
        if (libelle) libelle.textContent = replie ? "Afficher les états" : "Réduire les états";
      });
    }

    $("btn-actualiser").addEventListener("click", actualiser);
    majSelectionUI();
    actualiser(); // chargement immédiat à l'ouverture
  }

  document.addEventListener("DOMContentLoaded", init);
  return { actualiser };
})();
