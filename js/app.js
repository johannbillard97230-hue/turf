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
      corde: statuts.corde
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
      <td class="col-coted">${renduCote(p.cotePrecedente, p.heureCotes)}</td>
      <td class="col-cotea">${renduCote(p.coteActuelle, p.heureCotes)}</td>
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
        <span><span class="etiquette">Dernière cote</span>${renduCote(p.cotePrecedente, p.heureCotes)}</span>
        <span><span class="etiquette">Cote actuelle</span>${renduCote(p.coteActuelle, p.heureCotes)}</span>
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
          txt: "La page est servie sans les fonctions proxy (aperçu statique) : le navigateur bloque l'appel direct aux sources (CORS) et les proxys publics gratuits sont hors service. Déployez le dossier sur Netlify ou Vercel — la fonction proxy incluse y est installée automatiquement et l'application fonctionne alors sans réglage.",
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
    $("btn-actualiser").addEventListener("click", actualiser);
    majSelectionUI();
    actualiser(); // chargement immédiat à l'ouverture
  }

  document.addEventListener("DOMContentLoaded", init);
  return { actualiser };
})();
