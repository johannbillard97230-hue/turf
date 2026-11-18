/* ============================================================
   TURFMETRICS PRO — sources.js
   Couche d'accès aux données + parseurs HTML/JSON.
   Aucune donnée n'est fabriquée : ce qui n'est pas trouvé
   reste indisponible (affiché « N/D » dans l'interface).
   ============================================================ */

window.TM = window.TM || {};

TM.Sources = (() => {
  "use strict";

  /* ---------- Configuration ---------- */

  // Source propriétaire des VALEURS et des statistiques des partants
  const URL_PRESSE_PARTANTS = "https://www.pronostics-turf.info/presse-partants-pmu.php";
  // Source propriétaire des CITATIONS (revue de presse hippique)
  const URL_LISTE_SYNTHESE = "https://www.pronostics-turf.info/liste-synthese-de-pronostics-turf.php";
  // Compléments : fiches chevaux (sexe, musique, dernières sorties)
  const URL_QUINTE = "https://www.canalturf.com/courses_quinte.php";
  // Numéros de corde des courses de PLAT (absents des deux sources
  // ci-dessus qui sont orientées trot) : turf-fr.com les publie dans
  // la fiche « partants » de chaque course.
  const URL_TURF_FR_QUINTE = "https://www.turf-fr.com/quinte/";

  // pronostics-turf.info publie ses pages en iso-8859-1 / windows-1252
  const ENCODAGE_PT = "windows-1252";

  // Proxys same-origin (déployés avec l'app sur Netlify ou Vercel)
  const PROXY_ENDPOINTS = [
    "/.netlify/functions/proxy?url=",
    "/api/proxy?url="
  ];

  // Les proxys publics de secours (allorigins.win, corsproxy.io,
  // codetabs) ont été retirés : hors service ou clé désormais exigée.

  /* ---------- Utilitaires ---------- */

  function avecTimeout(promise, ms, etiquette) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`Délai dépassé (${ms / 1000}s) — ${etiquette}`)), ms))
    ]);
  }

  function normalise(txt) {
    return (txt || "").replace(/  /g, " ").replace(/\s+/g, " ").trim();
  }

  /* ---------- Récupération multi-canaux ----------
     Ordre : proxy same-origin (Netlify puis Vercel) → accès direct
     → proxy public. Chaque canal qui échoue est consigné. */

  async function fetchTexte(url, erreurs, etiquette, { timeoutMs = 20000, decodage = null } = {}) {
    // decodage : null → texte brut (UTF-8) ; sinon charset historique
    // (ex. windows-1252). Certains canaux convertissent déjà en UTF-8 :
    // on essaie d'abord l'UTF-8 strict, sinon le charset demandé.
    const lire = r => {
      if (!decodage) return r.text();
      return r.arrayBuffer().then(buf => {
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(buf);
        } catch {
          return new TextDecoder(decodage).decode(buf);
        }
      });
    };

    // Deux canaux seulement : les proxys same-origin déployés avec
    // l'app (Netlify / Vercel), puis l'accès direct (utile en local
    // ou si une source autorise le CORS). Les proxys publics
    // (allorigins, corsproxy…) sont hors service ou exigent une clé :
    // ils allongeaient l'attente sans jamais aboutir.
    const tentatives = [];

    for (const base of PROXY_ENDPOINTS) {
      tentatives.push({
        nom: "proxy " + (base.startsWith("/.netlify") ? "Netlify" : "Vercel"),
        lancer: () => fetch(base + encodeURIComponent(url), { headers: { "Accept": "*/*" } })
          .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return lire(r); })
      });
    }

    tentatives.push({
      nom: "accès direct",
      lancer: () => fetch(url, { headers: { "Accept": "*/*" } })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return lire(r); })
    });

    let dernierEchec = null;
    for (const t of tentatives) {
      try {
        const texte = await avecTimeout(t.lancer(), timeoutMs, etiquette);
        if (texte && texte.length > 200) return { texte, via: t.nom };
        throw new Error("réponse vide ou trop courte");
      } catch (e) {
        dernierEchec = e;
        erreurs.push(`${etiquette} — canal « ${t.nom} » : ${e.message}`);
      }
    }
    throw dernierEchec || new Error("tous les canaux ont échoué");
  }

  function parseHTML(texte) {
    return new DOMParser().parseFromString(texte, "text/html");
  }

  /* ============================================================
     SOURCE PRONOSTICS-TURF.INFO — presse-partants-pmu.php
     Course du jour + partants avec, pour chacun, la VALEUR
     publiée (reprise à l'identique, jamais modifiée), l'âge,
     le n° à la corde, le jockey/driver, l'entraîneur, les
     gains et les statistiques courses / victoires / placés.
     ============================================================ */

  const FERS = {
    "des4": "Déferré des 4",
    "anterieur": "Déferré antérieur",
    "posterieur": "Déferré postérieur",
    "0": "Non déferré"
  };

  // Code court affiché dans la colonne DÉFERRAGE (course du jour).
  // Une icône inconnue => null => N/D (aucune valeur inventée).
  const FERS_CODE = {
    "des4": "D4",
    "anterieur": "DA",
    "posterieur": "DP",
    "0": "—"
  };

  // Course de plat : la source remplace « Poteau » par « Poids » et
  // l'icône de déferrage par une icône générique de partant — notions
  // réservées à l'attelé. L'application affiche alors le poids dans la
  // colonne et « — » au déferrage : rien n'est inventé.
  function estFerConnu(cle) {
    return Object.prototype.hasOwnProperty.call(FERS_CODE, cle);
  }

  function parsePressePartants(doc) {
    const course = {
      nom: null, hippodrome: null, dateTexte: null, distance: null,
      allocation: null, discipline: null, nbPartants: null,
      reunionCourse: null, depart: null
    };

    const h2s = Array.from(doc.querySelectorAll("h2"));
    const h3s = Array.from(doc.querySelectorAll("h3"));

    const h2Course = h2s.find(h => !/PARTANTS/i.test(h.textContent) && h.textContent.trim().length > 3);
    if (h2Course) course.nom = normalise(h2Course.textContent);

    const h3Lieu = h3s.find(h => /à\s+[A-ZÀ-Ý]/i.test(h.textContent));
    if (h3Lieu) {
      const t = normalise(h3Lieu.textContent);
      const m = t.match(/à\s+([A-ZÀ-Ý][A-ZÀ-Ý'\- ]*?)\s+[A-Za-zÀ-ÿ]+\s+le\s+(\d{2})\s*-\s*(\d{2})\s*-\s*(\d{4})/i);
      if (m) {
        course.hippodrome = m[1].trim();
        course.dateTexte = `${m[2]}-${m[3]}-${m[4]}`;
      }
    }

    const h3Dist = h3s.find(h => /Distance\s*:/i.test(h.textContent));
    if (h3Dist) {
      const t = normalise(h3Dist.textContent);
      const m = t.match(/Distance\s*:\s*([\d ]+)\s*m\S*\s*-\s*Allocation\s*:\s*([\d ]+)\s*euros\s*»\s*(.+?)\s*$/i);
      if (m) {
        course.distance = m[1].replace(/\s/g, "") + " m";
        course.allocation = Number(m[2].replace(/\s/g, "")).toLocaleString("fr-FR") + " €";
        course.discipline = m[3].trim();
      }
    }

    const h2Part = h2s.find(h => /PARTANTS/i.test(h.textContent));
    if (h2Part) {
      const m = h2Part.textContent.match(/(\d+)\s*PARTANTS/i);
      if (m) course.nbPartants = parseInt(m[1], 10);
    }

    // --- Partants : <strong>N » Nom (sa valeur: XXXX)</strong> suivi
    //     du span.arial8 « Age: .. - Poteau: .. - Jockey/Driver: .. - … »
    const partants = [];
    doc.querySelectorAll("strong").forEach(st => {
      const m = normalise(st.textContent).match(/(\d+)\s*»\s*(.+?)\s*\(sa valeur\s*:\s*(\d+)\s*\)/i);
      if (!m) return;
      const p = st.closest("p");
      const span = p ? p.querySelector("span.arial8") : null;
      const d = span ? normalise(span.textContent).replace(/\s*-\s*/g, " - ") : "";
      const champ = re => { const x = d.match(re); return x ? x[1].trim() : null; };
      const entier = re => { const v = champ(re); return v != null && /^\d+$/.test(v) ? parseInt(v, 10) : null; };

      const img = p ? p.querySelector("img") : null;
      const mFer = img && (img.getAttribute("src") || "").match(/fers\/([^/.]+)\.gif/);

      let jockey = champ(/Jockey\/Driver\s*:\s*(.+?)\s+-/i);
      if (jockey) jockey = jockey.replace(/^[^A-ZÀ-Ý]+/, "").trim() || null;

      partants.push({
        numero: parseInt(m[1], 10),
        nom: m[2].trim(),
        valeur: parseInt(m[3], 10),   // valeur brute publiée — jamais modifiée
        age: entier(/Age\s*:\s*(\d+)/i),
        poteau: entier(/Poteau\s*:\s*(\d+)/i),
        poids: champ(/Poids\s*:\s*([\d,\.]+)/i),
        jockey,
        entraineur: champ(/Entraîneur\s*:\s*(.+?)\s+-/i),
        gains: entier(/Gains\s*:\s*(\d+)/i),
        courses: entier(/Courses\s*:\s*(\d+)/i),
        victoires: entier(/Victoires\s*:\s*(\d+)/i),
        places: entier(/Places\s*:\s*(\d+)/i),
        deferre: mFer ? (FERS[mFer[1]] || null) : null,
        // Icône non documentée (ex. course de plat : icône générique) :
        // déferrage « sans objet » plutôt que N/D — ce n'est pas une
        // donnée manquante, la notion ne s'applique pas.
        deferreCode: mFer
          ? (FERS_CODE[mFer[1]] !== undefined ? FERS_CODE[mFer[1]] : "—")
          : null,
        deferreInfo: mFer && !estFerConnu(mFer[1]) ? "sans objet (course de plat)" : null,
        citations: null,   // renseigné par la liste-synthèse
        idCheval: null,    // renseigné par Canalturf (fiches)
        fiche: null
      });
    });
    if (!partants.length) throw new Error("aucun partant extrait de presse-partants-pmu.php");

    return { course, partants };
  }

  /* ============================================================
     SOURCE PRONOSTICS-TURF.INFO — liste-synthese-de-pronostics-turf.php
     « LISTE RÉCAPITULATIVE — Position / Numéro / Fois cité » :
     nombre de citations de chaque cheval dans la revue de presse.
     Un cheval absent de la liste est « non cité » → 0 (règle
     métier : un cheval non cité affiche 0, pas N/D).
     ============================================================ */

  function parseSynthesePresse(doc) {
    const citations = {};
    let marqueur = null;
    doc.querySelectorAll("div").forEach(dv => {
      if (!marqueur && /Fois cit/i.test(dv.textContent) && dv.children.length === 0) marqueur = dv;
    });
    if (!marqueur) return { citations, trouve: false };

    let conteneur = marqueur.parentElement;
    let table = null;
    while (conteneur && !table) {
      table = conteneur.querySelector("table");
      conteneur = conteneur.parentElement;
    }
    if (!table) return { citations, trouve: false };

    table.querySelectorAll("tr").forEach(tr => {
      const tds = tr.querySelectorAll("td");
      if (tds.length >= 3) {
        const numero = parseInt(tds[1].textContent.trim(), 10);
        const fois = parseInt(tds[2].textContent.trim(), 10);
        if (Number.isFinite(numero) && Number.isFinite(fois)) citations[numero] = fois;
      }
    });
    return { citations, trouve: Object.keys(citations).length > 0 };
  }

  /* ============================================================
     SOURCE CANALTURF — page Quinté (course + partants → idCheval)
     ============================================================ */

  function parsePageQuinte(doc) {
    const corps = normalise(doc.body ? doc.body.textContent : "");

    // --- Titre de la course : <h2>Les partants du Quinté+ NOM</h2>
    let nomCourse = null, table = null;
    const h2s = doc.querySelectorAll("h2");
    for (const h2 of h2s) {
      const t = normalise(h2.textContent);
      const m = t.match(/partants du Quinté\+?\s*(.+)$/i);
      if (m) {
        nomCourse = m[1].trim();
        const section = h2.closest("section");
        table = (section && section.querySelector("table")) || h2.parentElement.querySelector("table");
        break;
      }
    }
    if (!table) throw new Error("tableau des partants introuvable sur la page Quinté");

    // --- Hippodrome : caption « ... à PARIS-VINCENNES »
    let hippodrome = null;
    const caption = table.querySelector("caption");
    if (caption) {
      const m = normalise(caption.textContent).match(/ à ([A-ZÀ-Ý' \-]+)$/);
      if (m) hippodrome = m[1].trim();
    }

    // --- Partants
    const partants = [];
    for (const tr of table.querySelectorAll("tbody tr")) {
      const tds = tr.querySelectorAll("td");
      if (tds.length < 4) continue;
      const numero = parseInt(tds[0].textContent, 10);
      const lien = tds[1].querySelector("a[href*='idcheval=']");
      if (!numero || !lien) continue;
      const mId = lien.href.match(/idcheval=(\d+)/);
      partants.push({
        numero,
        nom: normalise(lien.textContent).toUpperCase(),
        idCheval: mId ? mId[1] : null,
        jockey: normalise(tds[2].textContent) || null
      });
    }
    if (!partants.length) throw new Error("aucun partant extrait de la page Quinté");

    // --- Métadonnées de la course (texte descriptif de la page)
    const mRC = corps.match(/\(R\d+C\d+\)/);
    const course = {
      nom: nomCourse,
      hippodrome,
      reunionCourse: mRC ? mRC[0].replace(/[()]/g, "") : null,
      nbPartants: (corps.match(/Ce sont (\d+) partants/) || [])[1] || String(partants.length),
      discipline: null,
      distance: null,
      allocation: null,
      depart: null
    };
    // Lien vers la page « pronostics » de la course : on en déduit
    // mécaniquement l'URL « /cotes/ » (évolution des cotes PMU).
    const lienCourse = doc.querySelector("a[href*='/pronostics-PMU/']");
    if (lienCourse) course.urlCotes = (lienCourse.getAttribute("href") || "").replace("/pronostics-PMU/", "/cotes/") || null;
    const mDisc = corps.match(/course de ([A-ZÀ-Ý ]+?)\s*,\s*courue sur ([\d ]+)m avec une allocation de ([\d.,]+)\s*€/);
    if (mDisc) {
      course.discipline = mDisc[1].trim();
      course.distance = mDisc[2].replace(/\s/g, "") + " m";
      course.allocation = Number(mDisc[3].replace(/\s/g, "").replace(",", ".")).toLocaleString("fr-FR") + " €";
    }
    // --- Heure de départ : élément <time datetime="AAAA-MM-JJTHH:MM:SS+..">
    //     L'heure est lue directement dans la chaîne publiée (HH:MM),
    //     SANS conversion Date : une conversion appliquerait le fuseau
    //     horaire du navigateur et afficherait une heure fausse.
    for (const t of doc.querySelectorAll("time[datetime]")) {
      const dt = t.getAttribute("datetime") || "";
      const mH = dt.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      if (mH) {
        course.dateCourse = mH[1]; // repère ISO pour comparer au dernier résultat
        course.depart = mH[2];
        break;
      }
    }

    // --- Dernier Quinté+ disputé : médaillon « Les dernières courses
    //     support Quinté+ » — premier lien = résultat le plus récent.
    //     Si sa date égale celle de la course du jour, la course du jour
    //     est déjà courue : la « prochaine course » est celle de demain.
    const aRes = doc.querySelector("section.course-medaillon a[href*='resultats-PMU/']");
    if (aRes) {
      const href = aRes.getAttribute("href") || "";
      const mD = href.match(/resultats-PMU\/(\d{4}-\d{2}-\d{2})\//);
      course.urlDernierResultat = href || null;
      if (mD) course.dateDernierResultat = mD[1];
    }

    // --- URL de la page pronostic du jour
    let pronosticUrl = null;
    const aujourd = new Date();
    const iso = `${aujourd.getFullYear()}-${String(aujourd.getMonth() + 1).padStart(2, "0")}-${String(aujourd.getDate()).padStart(2, "0")}`;
    const liens = doc.querySelectorAll("a[href*='pronostics-PMU/']");
    for (const a of liens) {
      if (a.href.includes(`/pronostics-PMU/${iso}/`)) { pronosticUrl = a.href; break; }
    }
    if (!pronosticUrl && liens.length) pronosticUrl = liens[0].href;

    return { course, partants, pronosticUrl };
  }

  /* ============================================================
     SOURCE PRESSE — page pronostic (3 sélections réelles)
     Canalturf (8), ZEturf (8), Presse hippique (10)
     ============================================================ */

  function lignesSelection(table) {
    const res = [];
    for (const tr of table.querySelectorAll("tr")) {
      const tds = tr.querySelectorAll("td");
      if (tds.length < 2) continue;
      const numero = parseInt(tds[0].textContent, 10);
      const nom = normalise(tds[1].textContent).toUpperCase();
      if (numero && nom) res.push({ numero, nom });
    }
    return res;
  }

  function parsePagePronostic(doc) {
    const selections = [];

    // --- Sélection Canalturf : 3 tableaux (BASE / CHANCES REGULIERES / OUTSIDERS)
    const tabCT = doc.getElementById("tab-prono-ct");
    if (tabCT) {
      const chevaux = [];
      for (const table of tabCT.querySelectorAll("table")) {
        const groupe = normalise(table.querySelector("th") ? table.querySelector("th").textContent : "");
        for (const c of lignesSelection(table)) chevaux.push({ ...c, groupe });
      }
      if (chevaux.length) selections.push({ id: "canalturf", nom: "Sélection Canalturf", chevaux });
    }

    // --- Sélection ZEturf : tableau unique N°/Cheval/Driver
    const tabZT = doc.getElementById("tab-prono-zt");
    if (tabZT) {
      const table = tabZT.querySelector("table");
      const chevaux = table ? lignesSelection(table) : [];
      if (chevaux.length) selections.push({ id: "zeturf", nom: "Sélection ZEturf", chevaux });
    }

    // --- Sélection de la presse : 10 chevaux issus de 14 journaux
    const tabPR = doc.getElementById("tab-prono-pr");
    if (tabPR) {
      const table = tabPR.querySelector("table");
      const chevaux = table ? lignesSelection(table) : [];
      if (chevaux.length) selections.push({ id: "presse", nom: "Sélection de la presse (14 journaux)", chevaux });
    }

    if (!selections.length) throw new Error("aucune sélection trouvée sur la page pronostic");
    return { selections };
  }

  /* ============================================================
     SOURCE CANALTURF — fiche cheval
     (sexe/âge, musique, victoires/placés, dernières sorties)
     ============================================================ */

  const SEXES = { H: "Hongre", M: "Mâle", F: "Femelle" };

  function parseFicheCheval(doc) {
    const corps = normalise(doc.body ? doc.body.textContent : "");
    const fiche = {
      sexeAge: null, sexeComplet: null, musique: null, gains: null,
      courses: null, victoires: null, places: null, sorties: []
    };

    const mSexe = corps.match(/Sexe\/Age\s*:\s*([HMF])(\d+)/);
    if (mSexe) {
      fiche.sexeAge = `${mSexe[1]} · ${mSexe[2]} ans`;
      fiche.sexeComplet = `${SEXES[mSexe[1]] || mSexe[1]}, ${mSexe[2]} ans`;
    }

    const mMus = corps.match(/Perf\.\s*:\s*([0-9a-zA-Z()]+)/);
    if (mMus) fiche.musique = mMus[1].replace(/Course\(s\).*$/i, "") || null;

    const mGains = corps.match(/Gains\s*:\s*([\d ]+)\s*€/);
    if (mGains) fiche.gains = mGains[1].replace(/\s/g, " ") + "€";

    const mC = corps.match(/Course\(s\)\s*:\s*(\d+)/);
    const mV = corps.match(/Victoire\(s\)\s*:\s*(\d+)/);
    const mP = corps.match(/Placé\(s\)\s*:\s*(\d+)/);
    if (mC) fiche.courses = parseInt(mC[1], 10);
    if (mV) fiche.victoires = parseInt(mV[1], 10);
    if (mP) fiche.places = parseInt(mP[1], 10);

    // --- Dernières performances : tableau structuré
    //     <tr><td>place (« 8ème », « N-Pl »…)</td><td>date</td>
    //     <td><a href="…/resultats-PMU/AAAA-MM-JJ/hippodrome/id_course.html"
    //            title="… course NOM DE LA COURSE">…</a></td></tr>
    //     L'hippodrome est lu dans l'URL du résultat, le nom de course
    //     dans le titre du lien : aucune donnée n'est devinée.
    const h2Perf = Array.from(doc.querySelectorAll("h2"))
      .find(h => /Dernières performances/i.test(h.textContent));
    if (h2Perf) {
      // candidat valide : lignes à 3 colonnes dont la 2ᵉ est une date
      const estTablePerf = t => {
        const tds = t && t.querySelector("tr") ? t.querySelector("tr").querySelectorAll("td") : [];
        return tds.length >= 3 && /\d{2}\/\d{2}\/\d{4}/.test(tds[1].textContent);
      };
      let table = null;
      let el = h2Perf.nextElementSibling;
      while (!table && el) {
        const t = el.tagName === "TABLE" ? el : el.querySelector("table");
        if (estTablePerf(t)) table = t;
        el = el.nextElementSibling;
      }
      if (!table && h2Perf.parentElement) {
        for (const t of h2Perf.parentElement.querySelectorAll("table")) {
          if (estTablePerf(t)) { table = t; break; }
        }
      }
      if (table) {
        for (const tr of table.querySelectorAll("tr")) {
          if (fiche.sorties.length >= 3) break;
          const tds = tr.querySelectorAll("td");
          if (tds.length < 3) continue;
          const place = normalise(tds[0].textContent).replace(/^N\s*-?\s*Pl?$/i, "NP") || null;
          const date = normalise(tds[1].textContent) || null;
          const lieu = tds[2].querySelector("a");
          let hippodrome = null, course = null;
          if (lieu) {
            const mH = (lieu.getAttribute("href") || "").match(/resultats-PMU\/[\d-]+\/([a-z0-9-]+)\//i);
            if (mH) hippodrome = mH[1].toUpperCase();
            // nom de course : texte visible du lien (« HIPPODROME - COURSE »
            // après la cote) — complet même quand le nom contient des
            // guillemets ; l'attribut title, lui, peut être tronqué.
            const mT = normalise(lieu.textContent).match(/\)\s*-\s*[\d.,]*\/1\s*(.+?)\s*$/);
            if (mT) {
              const morceaux = mT[1].split(" - ");
              const hipTxt = morceaux.shift() || null; // 1ᵉʳ morceau = hippodrome
              if (!hippodrome) hippodrome = hipTxt;
              course = morceaux.join(" - ") || null;
            }
            if (!course) {
              const mC = (lieu.getAttribute("title") || "").match(/course\s+(.+?)\s*$/i);
              if (mC) course = mC[1];
            }
          }
          if (place && date) fiche.sorties.push({ place, date, hippodrome, course });
        }
      }
    }
    return fiche;
  }

  /* ============================================================
     SOURCE CANALTURF — page /cotes/ (évolution des cotes PMU)
     La page embarque, par cheval, l'historique horodaté des cotes
     PMU (points toutes les ~10 minutes, ex. {"elapsed":"20:30",
     "value":6.1}). On en tire, pour chaque numéro de cheval :
       - coteActuelle : dernier point de la série
       - cotePrecedente : point précédent (N/D si un seul point)
       - heureCotes : heure du dernier relevé publiée par la source
     Aucune valeur n'est fabriquée : série absente → tout à null.
     ============================================================ */

  function parsePageCotes(texte) {
    const cotes = {};
    let heureMax = null;
    const reSerie = /var\s+cote_data_(\d+)\s*=\s*\[([\s\S]*?)\];/g;
    let m;
    while ((m = reSerie.exec(texte)) !== null) {
      const numero = parseInt(m[1], 10);
      const points = [];
      const rePoint = /\{\s*"elapsed"\s*:\s*"([\d:]+)"\s*,\s*"value"\s*:\s*([\d.]+)\s*\}/g;
      let pt;
      while ((pt = rePoint.exec(m[2])) !== null) {
        const v = parseFloat(pt[2]);
        if (Number.isFinite(v)) points.push({ heure: pt[1], valeur: v });
      }
      if (!points.length) continue;
      const dernier = points[points.length - 1];
      cotes[numero] = {
        coteActuelle: dernier.valeur,
        cotePrecedente: points.length > 1 ? points[points.length - 2].valeur : null,
        heureCotes: dernier.heure
      };
      if (!heureMax || dernier.heure > heureMax) heureMax = dernier.heure;
    }
    return { cotes, heureMax };
  }

  /* ============================================================
     SOURCE TURF-FR.COM — numéro de corde des courses de PLAT
     La page /quinte/ renvoie vers la fiche « partants » de la
     course du jour ; chaque ligne y indique le dossard et la
     méta « … · Corde N ». Le numéro de corde est une donnée
     réelle publiée : il est lu tel quel, jamais déduit.
     ============================================================ */

  // Page /quinte/ → URL de la fiche course du jour.
  // Deux ancres possibles, dans l'ordre : le JSON-LD « SportsEvent »
  // (url canonique) puis le premier lien complet /course/AAAA-MM-JJ/rNcM-…
  function parsePageTurfFrQuinte(texte) {
    let m = texte.match(/"url"\s*:\s*"https:\/\/www\.turf-fr\.com(\/course\/\d{4}-\d{2}-\d{2}\/r\d+c\d+[^"]*)"/);
    if (m) return "https://www.turf-fr.com" + m[1];
    m = texte.match(/href="(\/course\/\d{4}-\d{2}-\d{2}\/r\d+c\d+[^"]*)"/);
    if (m) return "https://www.turf-fr.com" + m[1];
    return null;
  }

  // Fiche course → correspondance numéro (dossard) → n° de corde.
  // La page duplique son contenu (versions bureau / mobile) : la
  // correspondance est dédoublonnée par numéro. Si deux valeurs
  // contradictoires apparaissent pour un même numéro, la corde est
  // jugée inexploitable pour ce numéro (null → N/D, rien d'inventé).
  function parsePartantsTurfFr(texte) {
    const cordes = {};
    const re = /<tr[^>]*data-tri-num="(\d+)"[\s\S]*?partants-horse-meta">[^<]*?Corde\s+(\d+)[^<]*<\/p>/g;
    let m;
    while ((m = re.exec(texte)) !== null) {
      const numero = parseInt(m[1], 10);
      const corde = parseInt(m[2], 10);
      if (!Number.isFinite(numero) || !Number.isFinite(corde)) continue;
      if (cordes[numero] !== undefined && cordes[numero] !== corde) {
        cordes[numero] = null; // contradiction détectée : on ne tranche pas
      } else {
        cordes[numero] = corde;
      }
    }
    return cordes;
  }

  /* ============================================================
     SOURCE CANALTURF — arrivée du dernier Quinté+ disputé
     Le médaillon « Les dernières courses support Quinté+ » de la
     page Quinté renvoie vers la page /resultats-PMU/ la plus
     récente. On y lit le tableau « Résultat Pmu - Arrivée » :
     place, dossard, nom — repris à l'identique, limité aux 8
     premiers. Page absente ou tableau introuvable → tout à null
     (N/D affiché, rien n'est reconstitué).
     ============================================================ */

  function parsePageResultat(texte, dateIso) {
    // Nom et hippodrome : « Arrivée définitive du PRIX X à HIPPODROME »
    const mTitre = texte.match(/Arrivée définitive du ([^<]+?) à ([A-ZÀ-Ý' \-]+?)</i);
    const nom = mTitre ? mTitre[1].trim() : null;
    const hippodrome = mTitre ? mTitre[2].trim() : null;

    // Lignes du tableau d'arrivée : place / dossard / nom
    const arrivee = [];
    const re = /<tr><td>(\d+)(?:er|&egrave;me|ème)<\/td><td class="text-bold">(\d+)<\/td><td class="text-bold"><a [^>]*>([^<]+)<\/a><\/td>/g;
    let m;
    while ((m = re.exec(texte)) !== null && arrivee.length < 8) {
      arrivee.push({
        place: parseInt(m[1], 10),
        numero: parseInt(m[2], 10),
        nom: m[3].trim()
      });
    }
    if (!arrivee.length) throw new Error("tableau d'arrivée introuvable sur la page résultat");

    let dateTexte = null;
    if (dateIso) dateTexte = dateTexteIso(dateIso);
    return { nom, hippodrome, dateTexte, arrivee };
  }

  // Uniquement utile pour savoir si une page résultat contient une
  // arrivée publiée, sans lever d'erreur (course pas encore courue).
  function contientArrivee(texte) {
    return /<tr><td>\d+(?:er|&egrave;me|ème)<\/td><td class="text-bold">\d+<\/td><td class="text-bold"><a /.test(texte || "");
  }

  /* ============================================================
     SOURCE CANALTURF — heure de la prochaine course Quinté+
     (page « pronostics de demain »). Chaque item de réunion liste
     les jeux proposés : celui qui porte l'icône Quinté (pl_quint)
     est la course support du prochain Quinté+. On lit son heure
     et son nom, tels que publiés.
     ============================================================ */

  const URL_LISTE_DEMAIN = "https://www.canalturf.com/courses_liste_pronostics_demain.php";

  // Date ISO (AAAA-MM-JJ) → affichage JJ/MM/AAAA, sans objet Date
  // (aucune conversion de fuseau horaire n'est appliquée).
  function dateTexteIso(dateIso) {
    const m = (dateIso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
  }

  function parsePagePronosticsDemain(texte) {
    const re = /<a class="list-group-item[^"]*" href="(https:\/\/www\.canalturf\.com\/pronostics-PMU\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(texte)) !== null) {
      if (!m[2].includes("pl_quint")) continue;
      const h = m[2].match(/(\d{2}:\d{2})<br/);
      const n = m[2].match(/<strong>([^<]+)<\/strong>/);
      const d = m[1].match(/pronostics-PMU\/(\d{4}-\d{2}-\d{2})\//);
      return {
        heure: h ? h[1] : null,
        nom: n ? n[1].trim() : null,
        url: m[1],
        dateTexte: d ? dateTexteIso(d[1]) : null
      };
    }
    return null;
  }

  /* ============================================================
     Orchestration d'une actualisation complète
     ============================================================ */

  async function actualiserTout(etape) {
    const erreurs = [];
    const statuts = {
      valeur:    { nom: "pronostics-turf.info — valeurs des partants", etat: "attente", detail: "" },
      citations: { nom: "pronostics-turf.info — citations (revue de presse)", etat: "attente", detail: "" },
      fiches:    { nom: "Canalturf — fiches chevaux (sexe/âge, musique, sorties)", etat: "attente", detail: "" },
      cotes:     { nom: "Canalturf — cotes PMU (dernière / actuelle)", etat: "attente", detail: "" },
      corde:     { nom: "turf-fr.com — n° de corde (courses de plat)", etat: "attente", detail: "" },
      arrivee:   { nom: "Canalturf — arrivée du dernier Quinté+", etat: "attente", detail: "" }
    };

    // 1. VALEURS : page presse-partants (source propriétaire — critique)
    etape("Connexion à pronostics-turf.info (valeurs des partants)…");
    let course, partants;
    try {
      const { texte } = await fetchTexte(URL_PRESSE_PARTANTS, erreurs, "pronostics-turf.info — presse-partants", { decodage: ENCODAGE_PT });
      ({ course, partants } = parsePressePartants(parseHTML(texte)));
      statuts.valeur.etat = "ok";
      statuts.valeur.detail = `${partants.length} partants avec valeur publiée`;
    } catch (e) {
      statuts.valeur.etat = "ko";
      statuts.valeur.detail = e.message;
      // Sans la valeur propriétaire, aucun classement n'est possible :
      // on ne fabrique rien, on affiche le rapport d'échec.
      return { course: null, partants: [], statuts, erreurs };
    }

    // 2. CITATIONS : liste-synthèse de la revue de presse
    etape("Récupération des citations (revue de presse)…");
    try {
      const { texte } = await fetchTexte(URL_LISTE_SYNTHESE, erreurs, "pronostics-turf.info — liste-synthèse", { decodage: ENCODAGE_PT });
      const { citations, trouve } = parseSynthesePresse(parseHTML(texte));
      if (!trouve) throw new Error("liste récapitulative des citations introuvable");
      let nbCites = 0;
      for (const p of partants) {
        p.citations = citations[p.numero] != null ? citations[p.numero] : 0; // non cité → 0
        if (p.citations > 0) nbCites++;
      }
      statuts.citations.etat = "ok";
      statuts.citations.detail = `${nbCites}/${partants.length} chevaux cités — un cheval non cité affiche 0`;
    } catch (e) {
      statuts.citations.etat = "ko";
      statuts.citations.detail = e.message;
      // Source citations indisponible : N/D affiché, jamais de 0 fabriqué
      for (const p of partants) p.citations = null;
    }

    // 3. CANALTURF : page Quinté → idCheval (fiches) + réunion/course
    etape("Connexion à Canalturf (fiches chevaux)…");
    let courseCT = null, partantsCT = [];
    try {
      const { texte } = await fetchTexte(URL_QUINTE, erreurs, "Canalturf — page Quinté");
      const r = parsePageQuinte(parseHTML(texte));
      courseCT = r.course;
      partantsCT = r.partants;
      const parNum = new Map(partantsCT.map(p => [p.numero, p]));
      for (const p of partants) {
        const ct = parNum.get(p.numero);
        if (ct) p.idCheval = ct.idCheval;
      }
      // Compléments d'identité de course que la page presse ne donne pas
      if (courseCT) {
        course.reunionCourse = courseCT.reunionCourse;
        course.depart = courseCT.depart;
        if (!course.discipline && courseCT.discipline) course.discipline = courseCT.discipline;
      }
    } catch (e) {
      erreurs.push("Canalturf — page Quinté : " + e.message);
    }

    // 3b. Fiches chevaux (par lots de 4 pour ménager la source)
    etape("Lecture des fiches chevaux…");
    let ok = 0, tentes = 0;
    const lots = [];
    for (let i = 0; i < partants.length; i += 4) lots.push(partants.slice(i, i + 4));
    for (const lot of lots) {
      await Promise.all(lot.map(async p => {
        if (!p.idCheval) { p.fiche = null; return; }
        tentes++;
        try {
          const { texte } = await fetchTexte(
            `https://www.canalturf.com/courses_fiche_cheval.php?idcheval=${p.idCheval}`,
            erreurs, `Fiche ${p.nom}`, { timeoutMs: 15000 }
          );
          p.fiche = parseFicheCheval(parseHTML(texte));
          ok++;
        } catch (e) {
          p.fiche = null; // N/D affiché, erreur consignée
        }
        etape(`Fiches chevaux : ${ok}/${tentes}…`);
      }));
    }
    statuts.fiches.etat = ok === partants.length ? "ok" : (ok > 0 ? "partiel" : "ko");
    statuts.fiches.detail = ok === 0 && tentes === 0
      ? "page Quinté Canalturf indisponible — aucune fiche accessible"
      : `${ok}/${partants.length} fiches récupérées`;

    // 3c. COTES PMU : page /cotes/ de Canalturf (lien dérivé de la
    // page Quinté). Avant l'ouverture des relevés (environ 2 h avant
    // la course), la page n'a pas encore de séries → N/D partout,
    // jamais de valeur fabriquée.
    etape("Récupération des cotes PMU (Canalturf)…");
    if (courseCT && courseCT.urlCotes) {
      try {
        const { texte } = await fetchTexte(courseCT.urlCotes, erreurs, "Canalturf — cotes PMU");
        const { cotes, heureMax } = parsePageCotes(texte);
        if (!Object.keys(cotes).length) {
          // Cas normal en début de journée : la page répond mais les
          // relevés ne commencent qu'environ 2 h avant le départ.
          // Ce n'est pas une panne → pastille orange, pas rouge.
          statuts.cotes.etat = "partiel";
          statuts.cotes.detail = "aucune série publiée pour le moment — les relevés commencent environ 2 h avant le départ, relancez une actualisation plus tard";
        } else {
          let nbCotes = 0;
          for (const p of partants) {
            const c = cotes[p.numero];
            p.coteActuelle = c ? c.coteActuelle : null;
            p.cotePrecedente = c ? c.cotePrecedente : null;
            p.heureCotes = c ? c.heureCotes : null;
            if (c) nbCotes++;
          }
          course.heureCotes = heureMax;
          statuts.cotes.etat = nbCotes === partants.length ? "ok" : "partiel";
          statuts.cotes.detail = `${nbCotes}/${partants.length} chevaux cotés — dernier relevé ${heureMax || "N/D"}`;
        }
      } catch (e) {
        statuts.cotes.etat = "ko";
        statuts.cotes.detail = e.message;
      }
    } else {
      statuts.cotes.etat = "ko";
      statuts.cotes.detail = "lien vers la page cotes introuvable sur la page Quinté";
    }

    // 3d. CORDE DES COURSES DE PLAT : pronostics-turf.info ne publie
    // le n° de corde qu'en attelé (« Poteau ») — en plat il est remplacé
    // par le poids. turf-fr.com le publie dans sa fiche « partants ».
    // La détection du plat se fait sur les données réelles (poids
    // présent, poteau absent), jamais sur le libellé de discipline.
    const estPlat = partants.some(p => p.poids != null) && !partants.some(p => p.poteau != null);
    if (!estPlat) {
      // Attelé : la corde est déjà lue dans la source des valeurs.
      statuts.corde.etat = "na";
      statuts.corde.detail = "course attelée — numéros à la corde déjà fournis par la source des valeurs";
    } else {
      etape("Récupération des numéros de corde (turf-fr.com)…");
      try {
        const { texte: pageQuinteTfr } = await fetchTexte(URL_TURF_FR_QUINTE, erreurs, "turf-fr.com — page Quinté");
        const urlCourse = parsePageTurfFrQuinte(pageQuinteTfr);
        if (!urlCourse) throw new Error("lien vers la fiche course introuvable sur turf-fr.com/quinte/");
        const { texte: pageCourseTfr } = await fetchTexte(urlCourse, erreurs, "turf-fr.com — fiche course");
        const cordes = parsePartantsTurfFr(pageCourseTfr);
        let nbCordes = 0;
        for (const p of partants) {
          p.corde = cordes[p.numero] !== undefined ? cordes[p.numero] : null;
          if (p.corde != null) nbCordes++;
        }
        if (!nbCordes) throw new Error("aucun numéro de corde exploitable sur la fiche course");
        statuts.corde.etat = nbCordes === partants.length ? "ok" : "partiel";
        statuts.corde.detail = `${nbCordes}/${partants.length} numéros de corde récupérés`;
      } catch (e) {
        statuts.corde.etat = "ko";
        statuts.corde.detail = e.message;
        for (const p of partants) p.corde = null; // N/D affiché, rien de fabriqué
      }
    }

    // 3e. ARRIVÉE DU DERNIER QUINTÉ+ + HEURE DE LA PROCHAINE COURSE
    //
    // Priorité : la page résultat de la COURSE DU JOUR. Son URL se
    // déduit mécaniquement de l'URL pronostic (pronostics-PMU →
    // resultats-PMU, même transformation que pour les cotes) : elle
    // est mise en ligne dès l'arrivée, souvent AVANT que le médaillon
    // « dernières courses support Quinté+ » ne soit actualisé. Si elle
    // contient une arrivée définitive, c'est le dernier résultat réel.
    // Repli : premier lien résultat du médaillon.
    //
    // La prochaine course découle des dates publiées (jamais de
    // l'horloge du navigateur) : si le dernier résultat est celui de
    // la course du jour, la prochaine course est le Quinté+ de demain
    // (heure lue sur la page « pronostics de demain ») ; sinon c'est
    // la course du jour elle-même.
    course.arriveeDerniere = null;
    course.prochaineCourse = null;
    let dateDernierResultat = courseCT ? courseCT.dateDernierResultat : null;

    etape("Récupération de l'arrivée du dernier Quinté+…");
    let arriveeTrouvee = false;

    // a) Sonde : résultat de la course du jour (dérivé du pronostic)
    const urlProno = courseCT && courseCT.urlCotes
      ? courseCT.urlCotes.replace("/cotes/", "/pronostics-PMU/")
      : null;
    if (urlProno) {
      const urlResJour = urlProno.replace("/pronostics-PMU/", "/resultats-PMU/");
      try {
        const { texte: pageResJour } = await fetchTexte(urlResJour, erreurs, "Canalturf — résultat de la course du jour");
        if (contientArrivee(pageResJour)) {
          course.arriveeDerniere = parsePageResultat(pageResJour, courseCT.dateCourse);
          dateDernierResultat = courseCT.dateCourse;
          arriveeTrouvee = true;
        }
      } catch (e) {
        // Page absente ou inaccessible : ce n'est pas une erreur en
        // soi (course pas encore courue) — on bascule sur le médaillon.
      }
    }

    // b) Repli : médaillon « dernières courses support Quinté+ »
    if (!arriveeTrouvee) {
      if (courseCT && courseCT.urlDernierResultat) {
        try {
          const { texte: pageRes } = await fetchTexte(courseCT.urlDernierResultat, erreurs, "Canalturf — arrivée du dernier Quinté+");
          course.arriveeDerniere = parsePageResultat(pageRes, courseCT.dateDernierResultat);
          arriveeTrouvee = true;
        } catch (e) {
          statuts.arrivee.etat = "ko";
          statuts.arrivee.detail = e.message;
        }
      } else {
        statuts.arrivee.etat = "ko";
        statuts.arrivee.detail = "lien vers le dernier résultat introuvable sur la page Quinté";
      }
    }
    if (arriveeTrouvee) {
      statuts.arrivee.etat = "ok";
      statuts.arrivee.detail = `arrivée du ${course.arriveeDerniere.dateTexte || "dernier Quinté+"} — ${course.arriveeDerniere.arrivee.length} premiers chevaux`;
    }

    // Prochaine course : la comparaison se fait sur les dates publiées
    // par la source (ISO), jamais sur l'horloge du navigateur.
    const courseDuJourDejaCourue = !!(courseCT && dateDernierResultat && courseCT.dateCourse
      && dateDernierResultat >= courseCT.dateCourse);
    if (!courseDuJourDejaCourue) {
      // Course du jour pas encore courue : c'est elle la prochaine.
      const dateJour = courseCT ? dateTexteIso(courseCT.dateCourse) : null;
      if (course.depart) course.prochaineCourse = { heure: course.depart, nom: course.nom || null, jour: "aujourd'hui", dateTexte: dateJour };
      if (statuts.arrivee.etat === "ok") {
        statuts.arrivee.detail += " — prochaine course : " + (dateJour || "aujourd'hui") + " " + (course.depart || "N/D");
      }
    } else {
      try {
        const { texte: pageDemain } = await fetchTexte(URL_LISTE_DEMAIN, erreurs, "Canalturf — pronostics de demain");
        const demain = parsePagePronosticsDemain(pageDemain);
        if (!demain || !demain.heure) throw new Error("course support du prochain Quinté+ introuvable");
        course.prochaineCourse = { heure: demain.heure, nom: demain.nom, jour: "demain", dateTexte: demain.dateTexte || null };
        statuts.arrivee.detail += " — prochaine course : " + (demain.dateTexte || "demain") + " " + demain.heure;
      } catch (e) {
        // L'arrivée reste affichée ; seule l'heure de la prochaine
        // course passe à N/D (rien n'est deviné).
        statuts.arrivee.etat = statuts.arrivee.etat === "ok" ? "partiel" : statuts.arrivee.etat;
        statuts.arrivee.detail += " — heure de la prochaine course indisponible : " + e.message;
      }
    }

    return { course, partants, statuts, erreurs };
  }

  return { actualiserTout, parsePressePartants, parseSynthesePresse, parsePageQuinte, parsePagePronostic, parsePageCotes, parseFicheCheval, parsePageTurfFrQuinte, parsePartantsTurfFr, parsePageResultat, parsePagePronosticsDemain };
})();
