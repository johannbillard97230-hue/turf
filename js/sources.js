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

  // Noms des chevaux de la fiche course turf-fr, par dossard.
  // Ils servent au contrôle de cohérence : un numéro de corde n'est
  // appliqué que si le nom turf-fr correspond au nom de la presse
  // (jamais de corde d'un AUTRE cheval affichée).
  function parsePartantsTurfFrNoms(texte) {
    const noms = {};
    const re = /<tr[^>]*data-tri-num="(\d+)"[\s\S]*?partants-horse-name">\s*([^<]+?)\s*<\/span>/g;
    let m;
    while ((m = re.exec(texte)) !== null) {
      const numero = parseInt(m[1], 10);
      if (Number.isFinite(numero)) noms[numero] = m[2].trim();
    }
    return noms;
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
  const URL_LISTE_JOUR = "https://www.canalturf.com/courses_liste_pronostics.php";

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
     COHÉRENCE ENTRE SOURCES — garde-fou anti-mélange de courses
     En soirée, la presse (source des valeurs) bascule sur la course
     du lendemain alors que la page Quinté Canalturf peut être
     restée sur celle du jour (et inversement le matin). Fusionner
     par n° de dossard deux courses différentes afficherait la
     fiche, la corde et les cotes d'un AUTRE cheval sous le nom du
     premier. On compare donc les NOMS dossard par dossard avant
     toute fusion ; si les courses diffèrent, la course de la presse
     est recherchée dans les listes Canalturf ; si elle reste
     introuvable, aucune donnée Canalturf n'est fusionnée (N/D).
     ============================================================ */

  // Seuil de concordance au-delà duquel deux listes de partants
  // sont jugées décrire la même course (60 % des dossards communs
  // avec nom identique — en pratique 0 % ou ~100 %).
  const SEUIL_MEME_COURSE = 0.6;

  // Clé de comparaison d'un nom de cheval : majuscules, accents
  // retirés, lettres uniquement (« Félix aux Ormes » ≡ « FELIX AUX
  // ORMES », « Muenchen » ≡ « MUENCHEN »).
  function cleNom(nom) {
    return (nom || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toUpperCase().replace(/[^A-Z]/g, "");
  }

  // Compare deux listes de partants : dossards communs, dossards
  // dont le nom est identique des deux côtés, ratio de concordance.
  function comparerPartants(presse, ct) {
    const parNum = new Map();
    for (const c of ct) if (c.numero != null && !parNum.has(c.numero)) parNum.set(c.numero, c);
    let communs = 0, identiques = 0;
    const numerosOk = new Set();
    for (const p of presse) {
      const c = parNum.get(p.numero);
      if (!c) continue;
      communs++;
      if (cleNom(c.nom) === cleNom(p.nom)) { identiques++; numerosOk.add(p.numero); }
    }
    return { communs, identiques, ratio: communs ? identiques / communs : 0, numerosOk };
  }

  // « JJ-MM-AAAA » (date textuelle de la presse) → « AAAA-MM-JJ »
  // (repère ISO comparable aux dates Canalturf / turf-fr).
  function isoDepuisDateTexte(dateTexte) {
    const m = (dateTexte || "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }

  // Listes de pronostics Canalturf (aujourd'hui / demain) : chaque
  // item renvoie vers la page pronostics-PMU d'une course, dont
  // l'URL contient la date et l'hippodrome ; l'icône pl_quint
  // identifie la course support du Quinté+.
  function parseListeCourses(texte) {
    const courses = [];
    const re = /<a class="list-group-item[^"]*" href="(https:\/\/www\.canalturf\.com\/pronostics-PMU\/(\d{4}-\d{2}-\d{2})\/([a-z0-9-]+)\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(texte)) !== null) {
      const bloc = m[4];
      const h = bloc.match(/(\d{2}:\d{2})<br/);
      const n = bloc.match(/<strong>([^<]+)<\/strong>/);
      courses.push({
        url: m[1],
        dateIso: m[2],
        hippodrome: m[3],
        heure: h ? h[1] : null,
        nom: n ? n[1].trim() : null,
        quinte: bloc.includes("pl_quint")
      });
    }
    return courses;
  }

  /* ============================================================
     PAGE « PRONOSTICS » D'UNE COURSE (Canalturf)
     Ex. pronostics-PMU/AAAA-MM-JJ/hippodrome/id_nom.html
     Tableau des partants : n° / cheval (lien idcheval + musique) /
     corde ou déferrage / jockey-entraîneur / poids / valeur (plat).
     Les colonnes sont repérées par leur libellé d'en-tête (la
     structure diffère entre plat et trot). Les lignes « NP »
     (non-partants) n'ont ni dossard ni données : le nom seul est
     conservé pour identification.
     ============================================================ */
  function parsePagePronosticsCourse(doc, url) {
    const mUrl = (url || "").match(/pronostics-PMU\/(\d{4}-\d{2}-\d{2})\/([a-z0-9-]+)\//i);
    const course = {
      dateCourse: mUrl ? mUrl[1] : null,
      hippodrome: mUrl ? mUrl[2].replace(/-/g, " ").toUpperCase() : null,
      discipline: null, distance: null, handicap: null
    };

    // Ligne d'identité : « PLAT, 2500 metres , PSF , Corde a DROITE
    // 50.900- HANDICAP DIVISE Pour … »
    const divInfo = Array.from(doc.querySelectorAll("div")).find(d =>
      /text-xs/.test(d.className || "") && /metres/i.test(d.textContent || ""));
    if (divInfo) {
      const t = normalise(divInfo.textContent);
      const m = t.match(/([A-Za-zÀ-ÿ]+)\s*,\s*([\d ]+)\s*metres/i);
      if (m) {
        course.discipline = m[1].toUpperCase();
        course.distance = m[2].replace(/\s/g, "") + " m";
      }
      course.handicap = /\bHANDICAP\b/i.test(t);
    }

    // Tableau des partants : celui dont l'en-tête contient « Cheval »
    let table = null, ths = [];
    for (const t of doc.querySelectorAll("table")) {
      const entetes = Array.from(t.querySelectorAll("thead th")).map(th => normalise(th.textContent).toLowerCase());
      if (entetes.includes("cheval")) { table = t; ths = entetes; break; }
    }
    if (!table) throw new Error("tableau des partants introuvable sur la page pronostics");
    const iCorde = ths.indexOf("corde");
    const iPoids = ths.indexOf("poids");
    const iVal = ths.indexOf("val.");

    const partants = [];
    for (const tr of table.querySelectorAll("tr")) {
      if (tr.closest("thead")) continue;
      const tds = tr.querySelectorAll("td");
      if (tds.length < 2) continue;
      const numTxt = normalise(tds[0].textContent);
      const lien = tr.querySelector("a[href*='idcheval=']");
      if (!lien) continue;
      const mId = (lien.getAttribute("href") || "").match(/idcheval=(\d+)/);
      const titre = lien.getAttribute("title") || "";
      const mNom = titre.match(/du cheval\s+(.+)$/i);
      const nom = mNom
        ? normalise(mNom[1]).toUpperCase()
        : normalise(lien.textContent).replace(/\([^)]*\).*$/, "").trim().toUpperCase();
      if (!nom) continue;
      const np = /^NP$/i.test(numTxt);
      const p = {
        numero: np ? null : parseInt(numTxt, 10),
        np,
        nom,
        idCheval: mId ? mId[1] : null,
        corde: null, poids: null, valeurHandicap: null, musique: null
      };
      if (!np && Number.isFinite(p.numero)) {
        const small = tds[1] ? tds[1].querySelector("small") : null;
        if (small) p.musique = normalise(small.textContent) || null;
        if (iCorde > 0 && tds[iCorde]) {
          const c = normalise(tds[iCorde].textContent);
          if (/^\d+$/.test(c)) p.corde = parseInt(c, 10);
        }
        if (iPoids > 0 && tds[iPoids]) {
          const mP = normalise(tds[iPoids].textContent).match(/([\d.,]+)\s*kg/i);
          if (mP) p.poids = parseFloat(mP[1].replace(",", "."));
        }
        if (iVal > 0 && tds[iVal]) {
          const v = normalise(tds[iVal].textContent);
          if (/^\d+([.,]\d+)?$/.test(v)) p.valeurHandicap = parseFloat(v.replace(",", "."));
        }
      }
      partants.push(p);
    }
    if (!partants.length) throw new Error("aucun partant extrait de la page pronostics");
    return { course, partants };
  }

  /* ============================================================
     MODULE HANDICAP — analyse du handicap et potentiel Top 5
     (courses de PLAT en handicap uniquement)
     Fonctions pures : aucune donnée fabriquée, aucun coefficient
     importé. La moyenne porte sur les valeurs disponibles (une
     valeur absente est exclue du calcul, jamais remplacée par 0).
     ============================================================ */

  // Musique Canalturf : « 4p2p2p4p9p0p(25)0p4p0p » — lue de gauche
  // à droite (plus récent → plus ancien). Chaque sortie est un
  // chiffre (la place, 0 = non placé) ou un code incident en
  // MAJUSCULE (D, R, T, A…), suivi d'une lettre minuscule de
  // discipline (p, m, a, c…) qui n'est PAS une sortie. Forme =
  // nombre de top-5 sur les 6 dernières sorties connues.
  // Aucune pondération.
  function parseMusiqueForme(musique) {
    if (!musique) return null;
    const propre = String(musique).replace(/\(\d{2,4}\)/g, " ");
    const jetons = propre.match(/\d+|[A-Z]/g) || [];
    if (!jetons.length) return null;
    const sorties = Math.min(6, jetons.length);
    let top5 = 0;
    for (let i = 0; i < sorties; i++) {
      const j = jetons[i];
      if (/^\d+$/.test(j)) {
        const v = parseInt(j, 10);
        if (v >= 1 && v <= 5) top5++;
      }
    }
    return { top5, sorties };
  }

  // Analyse du peloton. lignes : [{numero, nom, corde, valeur,
  // poids, forme}]. Renvoie la moyenne, l'avantage poids (résidu de
  // la régression poids = a + b × valeur calibrée sur le peloton
  // lui-même) et le profil de chaque cheval (rangs en tiers par
  // axe, règle déterministe affichée dans l'interface).
  function analyserPelotonHandicap(lignes) {
    const evalues = lignes.filter(l => l.valeur != null);
    if (!evalues.length) return null;
    const moyenne = evalues.reduce((s, l) => s + l.valeur, 0) / evalues.length;

    // Régression intra-peloton (moindres carrés) sur les couples
    // (valeur, poids) complets : le poids « attendu » d'un cheval
    // découle de sa valeur, calibré sur cette course précise.
    const couples = evalues.filter(l => l.poids != null);
    let a = null, b = null;
    if (couples.length >= 3) {
      const xm = couples.reduce((s, l) => s + l.valeur, 0) / couples.length;
      const ym = couples.reduce((s, l) => s + l.poids, 0) / couples.length;
      let num = 0, den = 0;
      for (const l of couples) {
        num += (l.valeur - xm) * (l.poids - ym);
        den += (l.valeur - xm) * (l.valeur - xm);
      }
      if (den > 0) { b = num / den; a = ym - b * xm; }
    }

    for (const l of lignes) {
      l.ecart = l.valeur != null ? l.valeur - moyenne : null;
      if (l.valeur != null && l.poids != null && a != null) {
        l.poidsAttendu = a + b * l.valeur;
        l.avantage = l.poids - l.poidsAttendu; // négatif = décharge (avantage)
      } else {
        l.poidsAttendu = null;
        l.avantage = null;
      }
    }

    // Rangs en tiers par axe — déterministe (tri par mesure puis n°)
    const tiers = {};
    const attribuer = (ordonnes, cle) => {
      const n = ordonnes.length;
      ordonnes.forEach((l, i) => {
        if (!tiers[l.numero]) tiers[l.numero] = {};
        tiers[l.numero][cle] = n < 3 ? 1 : Math.min(2, Math.floor(i * 3 / n));
      });
    };
    // valeur handicap : plus haut = mieux
    attribuer(
      lignes.filter(l => l.valeur != null)
        .sort((x, y) => (y.valeur - x.valeur) || (x.numero - y.numero)),
      "valeur");
    // avantage poids : résidu le plus négatif (décharge) = mieux
    attribuer(
      lignes.filter(l => l.avantage != null)
        .sort((x, y) => (x.avantage - y.avantage) || (x.numero - y.numero)),
      "avantage");
    // forme : ratio top-5/sorties puis top-5, plus haut = mieux
    attribuer(
      lignes.filter(l => l.forme != null)
        .sort((x, y) => ((y.forme.top5 / y.forme.sorties) - (x.forme.top5 / x.forme.sorties))
          || (y.forme.top5 - x.forme.top5) || (x.numero - y.numero)),
      "forme");

    // Profils : ≥ 2 axes dans le tiers supérieur sans aucun dans le
    // tiers inférieur → FAVORABLE ; ≥ 2 axes dans le tiers inférieur
    // → MOINS FAVORABLE ; sinon À SURVEILLER. Cheval incomplet
    // (donnée manquante) → pas de profil (N/D).
    const fmt = v => (Math.round(v * 10) / 10).toString().replace(".", ",");
    for (const l of lignes) {
      const t = tiers[l.numero];
      if (!t || t.valeur == null || t.avantage == null || t.forme == null) {
        l.profil = null;
        l.justification = null;
        continue;
      }
      const axes = [t.valeur, t.avantage, t.forme];
      const haut = axes.filter(x => x === 0).length;
      const bas = axes.filter(x => x === 2).length;
      if (haut >= 2 && bas === 0) l.profil = "PROFIL FAVORABLE";
      else if (bas >= 2) l.profil = "PROFIL MOINS FAVORABLE";
      else l.profil = "PROFIL À SURVEILLER";
      const morceaux = [];
      if (l.valeur != null) morceaux.push(`valeur ${fmt(l.valeur)} (${l.ecart >= 0 ? "+" : ""}${fmt(l.ecart)} vs moyenne)`);
      if (l.avantage != null) {
        if (l.avantage <= -1) morceaux.push(`décharge de ${fmt(-l.avantage)} kg`);
        else if (l.avantage >= 1) morceaux.push(`surcharge de ${fmt(l.avantage)} kg`);
        else morceaux.push(`poids conforme à sa valeur (${l.avantage >= 0 ? "+" : ""}${fmt(l.avantage)} kg)`);
      }
      if (l.forme) morceaux.push(`${l.forme.top5} top-5 sur ${l.forme.sorties} sorties`);
      l.justification = morceaux.join(" · ");
    }
    return { moyenne, nbEvalues: evalues.length, nbPartants: lignes.length, lignes };
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
      corde:     { nom: "Canalturf / turf-fr.com — n° de corde (courses de plat)", etat: "attente", detail: "" },
      handicap:  { nom: "Canalturf — valeurs handicap & potentiel Top 5 (handicaps de plat)", etat: "attente", detail: "" },
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
    //
    // CONTRÔLE DE COHÉRENCE : la page Quinté Canalturf peut être
    // restée sur la course de la veille alors que la presse est déjà
    // passée à la suivante (bascule en soirée) — ou l'inverse le
    // matin. Avant toute fusion, les NOMS sont comparés dossard par
    // dossard ; si les courses diffèrent, la course de la presse est
    // recherchée dans les listes Canalturf (récupération) ; si elle
    // reste introuvable, AUCUNE donnée Canalturf n'est fusionnée
    // (N/D affiché — jamais de mélange entre deux courses).
    etape("Connexion à Canalturf (fiches chevaux)…");
    let courseCT = null, partantsCT = [];
    let coursePageQuinte = null;   // course affichée par la page Quinté (médaillon, sonde résultat)
    let nomsCoherents = new Set(); // dossards dont le nom Canalturf = nom presse
    let ctCoherent = false, ctRecupere = false;
    let listesCourses = [];        // items des listes jour/demain (réutilisés pour la prochaine course)
    let courseListee = null;       // course de la presse trouvée dans une liste (heure publiée)
    let pronoCourseDejaLue = null; // page pronostics déjà analysée (récupération) — réutilisée par le module handicap
    const datePresseIso = isoDepuisDateTexte(course.dateTexte);
    try {
      const { texte } = await fetchTexte(URL_QUINTE, erreurs, "Canalturf — page Quinté");
      const r = parsePageQuinte(parseHTML(texte));
      coursePageQuinte = r.course;
      const cmp = comparerPartants(partants, r.partants);
      if (cmp.communs > 0 && cmp.ratio >= SEUIL_MEME_COURSE) {
        courseCT = r.course;
        partantsCT = r.partants;
        nomsCoherents = cmp.numerosOk;
        ctCoherent = true;
      } else {
        erreurs.push("Canalturf — page Quinté : la course affichée n'est pas celle de la presse "
          + `(${cmp.identiques}/${cmp.communs} noms concordants) — recherche de la course analysée`);
      }
    } catch (e) {
      erreurs.push("Canalturf — page Quinté : " + e.message);
    }

    // 3a. Récupération : retrouver la course de la presse dans les
    // listes de pronostics (date + hippodrome + icône Quinté+), puis
    // vérifier à nouveau les noms sur sa page pronostics.
    if (!ctCoherent) {
      etape("Recherche de la course analysée sur Canalturf…");
      for (const u of [URL_LISTE_JOUR, URL_LISTE_DEMAIN]) {
        try {
          const { texte } = await fetchTexte(u, erreurs, "Canalturf — liste des pronostics");
          listesCourses.push(...parseListeCourses(texte));
        } catch (e) { /* liste indisponible : tentative avec la suivante */ }
      }
      const clePresse = cleNom(course.hippodrome);
      const quintes = listesCourses.filter(c => c.quinte);
      courseListee = quintes.find(c => c.dateIso === datePresseIso
          && clePresse
          && (cleNom(c.hippodrome) === clePresse
            || clePresse.includes(cleNom(c.hippodrome))
            || cleNom(c.hippodrome).includes(clePresse)))
        || quintes.find(c => c.dateIso === datePresseIso)
        || null;
      if (courseListee) {
        try {
          const { texte: pageProno } = await fetchTexte(courseListee.url, erreurs, "Canalturf — page pronostics de la course");
          const rc = parsePagePronosticsCourse(parseHTML(pageProno), courseListee.url);
          const cmp2 = comparerPartants(partants, rc.partants);
          if (cmp2.communs > 0 && cmp2.ratio >= SEUIL_MEME_COURSE) {
            ctCoherent = true;
            ctRecupere = true;
            partantsCT = rc.partants;
            pronoCourseDejaLue = rc;
            nomsCoherents = cmp2.numerosOk;
            courseCT = {
              nom: courseListee.nom,
              hippodrome: rc.course.hippodrome,
              reunionCourse: coursePageQuinte ? coursePageQuinte.reunionCourse : null,
              dateCourse: rc.course.dateCourse,
              depart: courseListee.heure,
              urlCotes: courseListee.url.replace("/pronostics-PMU/", "/cotes/"),
              urlDernierResultat: coursePageQuinte ? coursePageQuinte.urlDernierResultat : null,
              dateDernierResultat: coursePageQuinte ? coursePageQuinte.dateDernierResultat : null,
              handicap: rc.course.handicap
            };
          } else {
            erreurs.push(`Canalturf — page pronostics retrouvée mais non concordante (${cmp2.identiques}/${cmp2.communs} noms) — fusion refusée`);
          }
        } catch (e) {
          erreurs.push("Canalturf — page pronostics de la course : " + e.message);
        }
      }
      if (!ctCoherent) {
        erreurs.push("Canalturf n'affiche pas la même course que la presse et la course analysée n'a pas été retrouvée — fiches, cotes et corde non fusionnées (N/D)");
      }
    }

    // Fusion des identifiants fiches : dossard ET nom identiques
    // exigés. Les non-partants Canalturf (lignes « NP » sans dossard)
    // sont identifiés par leur seul nom.
    if (ctCoherent) {
      const parNum = new Map(partantsCT.filter(c => c.numero != null).map(c => [c.numero, c]));
      const npParNom = new Map(partantsCT.filter(c => c.numero == null).map(c => [cleNom(c.nom), c]));
      for (const p of partants) {
        if (nomsCoherents.has(p.numero) && parNum.has(p.numero)) {
          p.idCheval = parNum.get(p.numero).idCheval;
        } else {
          const np = npParNom.get(cleNom(p.nom));
          if (np) p.idCheval = np.idCheval;
        }
      }
      // Compléments d'identité de course que la page presse ne donne pas
      if (courseCT) {
        course.reunionCourse = courseCT.reunionCourse;
        course.depart = courseCT.depart;
        if (!course.discipline && courseCT.discipline) course.discipline = courseCT.discipline;
      }
    } else if (courseListee && courseListee.heure) {
      // Course retrouvée dans une liste mais page non vérifiée :
      // l'heure publiée est utilisable, le reste reste à N/D.
      course.depart = courseListee.heure;
    }

    // 3b. Fiches chevaux (par lots de 4 pour ménager la source).
    // Sans course Canalturf vérifiée, aucune fiche n'est demandée :
    // un identifiant issu d'une autre course afficherait la fiche
    // d'un autre cheval — on préfère N/D.
    etape("Lecture des fiches chevaux…");
    let ok = 0, tentes = 0;
    if (!ctCoherent) {
      for (const p of partants) p.fiche = null;
      statuts.fiches.etat = "ko";
      statuts.fiches.detail = "Canalturf n'affiche pas la même course que la presse — aucune fiche fusionnée (N/D), relancez une actualisation plus tard";
    } else {
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
    statuts.fiches.detail = (ctRecupere
      ? "course retrouvée via les listes Canalturf (page Quinté désynchronisée) — "
      : "") + (ok === 0 && tentes === 0
      ? "aucune fiche accessible"
      : `${ok}/${partants.length} fiches récupérées`);
    }

    // 3c. COTES PMU : page /cotes/ de Canalturf (lien dérivé de la
    // page Quinté). Avant l'ouverture des relevés (environ 2 h avant
    // la course), la page n'a pas encore de séries → N/D partout,
    // jamais de valeur fabriquée.
    etape("Récupération des cotes PMU (Canalturf)…");
    if (courseCT && courseCT.urlCotes) {      try {
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
      statuts.cotes.detail = ctCoherent
        ? "lien vers la page cotes introuvable sur la page Quinté"
        : "Canalturf n'affiche pas la même course que la presse — cotes non fusionnées (N/D)";
    }

    // 3d. CORDE DES COURSES DE PLAT : pronostics-turf.info ne publie
    // le n° de corde qu'en attelé (« Poteau ») — en plat il est remplacé
    // par le poids. Deux sources, toutes deux contrôlées :
    //  a) la page pronostics Canalturf, lorsque la course y a été
    //     retrouvée et vérifiée nom par nom (récupération) ;
    //  b) turf-fr.com, dont la fiche course porte la date dans son
    //     URL — si elle diffère de la date presse, la source affiche
    //     une AUTRE course et ses numéros sont ignorés ; le nom du
    //     cheval est en outre vérifié pour chaque dossard.
    // La détection du plat se fait sur les données réelles (poids
    // présent, poteau absent), jamais sur le libellé de discipline.
    const estPlat = partants.some(p => p.poids != null) && !partants.some(p => p.poteau != null);
    if (!estPlat) {
      // Attelé : la corde est déjà lue dans la source des valeurs.
      statuts.corde.etat = "na";
      statuts.corde.detail = "course attelée — numéros à la corde déjà fournis par la source des valeurs";
    } else {
      etape("Récupération des numéros de corde…");
      for (const p of partants) p.corde = null;
      // a) Canalturf (course vérifiée lors de la récupération)
      let nbCT = 0;
      if (ctRecupere) {
        const parNumCT = new Map(partantsCT.filter(c => c.numero != null).map(c => [c.numero, c]));
        for (const p of partants) {
          const c = parNumCT.get(p.numero);
          if (c && c.corde != null && nomsCoherents.has(p.numero)) { p.corde = c.corde; nbCT++; }
        }
      }
      // b) turf-fr.com, seulement si sa fiche course est celle de la
      //    course analysée (date de l'URL = date publiée par la presse)
      let detailTfr = "";
      try {
        const { texte: pageQuinteTfr } = await fetchTexte(URL_TURF_FR_QUINTE, erreurs, "turf-fr.com — page Quinté");
        const urlCourse = parsePageTurfFrQuinte(pageQuinteTfr);
        if (!urlCourse) throw new Error("lien vers la fiche course introuvable sur turf-fr.com/quinte/");
        const mDateTfr = urlCourse.match(/\/course\/(\d{4}-\d{2}-\d{2})\//);
        if (datePresseIso && mDateTfr && mDateTfr[1] !== datePresseIso) {
          throw new Error(`turf-fr.com affiche la course du ${dateTexteIso(mDateTfr[1])}, pas celle analysée (${dateTexteIso(datePresseIso)}) — numéros ignorés`);
        }
        const { texte: pageCourseTfr } = await fetchTexte(urlCourse, erreurs, "turf-fr.com — fiche course");
        const cordes = parsePartantsTurfFr(pageCourseTfr);
        const nomsTfr = parsePartantsTurfFrNoms(pageCourseTfr);
        let nbTfr = 0;
        for (const p of partants) {
          if (p.corde != null) continue; // déjà fourni par Canalturf (course vérifiée)
          if (cordes[p.numero] !== undefined && cordes[p.numero] !== null
              && cleNom(nomsTfr[p.numero]) === cleNom(p.nom)) {
            p.corde = cordes[p.numero];
            nbTfr++;
          }
        }
        detailTfr = nbTfr ? `${nbTfr} via turf-fr.com` : "aucun via turf-fr.com (noms non concordants)";
      } catch (e) {
        detailTfr = "turf-fr.com : " + e.message;
      }
      const nbCordes = partants.filter(p => p.corde != null).length;
      if (!nbCordes) {
        statuts.corde.etat = "ko";
        statuts.corde.detail = detailTfr || "aucun numéro de corde exploitable";
      } else {
        statuts.corde.etat = nbCordes === partants.length ? "ok" : "partiel";
        statuts.corde.detail = `${nbCordes}/${partants.length} numéros de corde récupérés`
          + (nbCT ? ` (${nbCT} via Canalturf, course vérifiée)` : "")
          + (detailTfr ? ` — ${detailTfr}` : "");
      }
    }

    // 3f. MODULE HANDICAP — analyse du handicap et potentiel Top 5.
    // Réservé aux courses de PLAT dont le libellé publié est un
    // HANDICAP (ligne d'identité de la page pronostics). Source :
    // le tableau des partants de la page pronostics Canalturf
    // (valeur handicap, poids, corde, musique), vérifié nom par nom.
    // La course a pu être lue lors de la récupération (3a) : on la
    // réutilise, sinon elle est déduite de l'URL cotes. Une valeur
    // absente est exclue de la moyenne (jamais remplacée par 0) et
    // affichée N/D. Le classement principal et la sélection des 8
    // chevaux ne sont pas touchés.
    course.handicapData = null;
    if (!estPlat) {
      statuts.handicap.etat = "na";
      statuts.handicap.detail = "course attelée — analyse du handicap sans objet";
    } else if (!ctCoherent || !courseCT || !courseCT.urlCotes) {
      statuts.handicap.etat = "ko";
      statuts.handicap.detail = "course Canalturf non vérifiée — valeurs handicap non fusionnées (N/D)";
    } else {
      etape("Analyse du handicap (Canalturf)…");
      try {
        let rc = pronoCourseDejaLue;
        if (!rc) {
          const urlPronoH = courseCT.urlCotes.replace("/cotes/", "/pronostics-PMU/");
          const { texte: pagePronoH } = await fetchTexte(urlPronoH, erreurs, "Canalturf — page pronostics (handicap)");
          rc = parsePagePronosticsCourse(parseHTML(pagePronoH), urlPronoH);
          const cmpH = comparerPartants(partants, rc.partants);
          if (!(cmpH.communs > 0 && cmpH.ratio >= SEUIL_MEME_COURSE)) {
            throw new Error("page pronostics non concordante avec la presse — analyse refusée");
          }
        }
        if (rc.course.handicap !== true) {
          statuts.handicap.etat = "na";
          statuts.handicap.detail = "course non handicap (libellé publié) — module sans objet";
        } else {
          const parNumH = new Map(rc.partants.filter(c => c.numero != null).map(c => [c.numero, c]));
          const lignes = [];
          for (const p of partants) {
            const c = parNumH.get(p.numero) || {};
            lignes.push({
              numero: p.numero,
              nom: p.nom,
              corde: c.corde != null ? c.corde : (p.corde != null ? p.corde : null),
              valeur: c.valeurHandicap != null ? c.valeurHandicap : null,
              poids: c.poids != null ? c.poids : (p.poids != null ? p.poids : null),
              forme: parseMusiqueForme(c.musique)
            });
          }
          lignes.sort((x, y) => x.numero - y.numero);
          const analyse = analyserPelotonHandicap(lignes);
          if (!analyse) throw new Error("aucune valeur handicap publiée sur la page pronostics");
          analyse.distance = rc.course.distance;
          course.handicapData = analyse;
          const nbVal = analyse.nbEvalues;
          statuts.handicap.etat = nbVal === partants.length ? "ok" : "partiel";
          statuts.handicap.detail = `handicap confirmé — moyenne du peloton calculée sur ${nbVal}/${partants.length} valeurs publiées`
            + (ctRecupere ? " (course vérifiée via les listes)" : "");
        }
      } catch (e) {
        statuts.handicap.etat = "ko";
        statuts.handicap.detail = e.message;
      }
    }

    // 3e. ARRIVÉE DU DERNIER QUINTÉ+ + HEURE DE LA PROCHAINE COURSE
    //
    // Plusieurs pages résultat candidates, chacune datée par sa
    // source (jamais par l'horloge du navigateur) :
    //  A. la course affichée par la page Quinté — utile quand elle
    //     est restée sur la course du jour alors que la presse est
    //     déjà passée à celle du lendemain : c'est elle la dernière
    //     courue ;
    //  B. la course analysée — son URL résultat se déduit de l'URL
    //     pronostic (même transformation que pour les cotes) : elle
    //     est mise en ligne dès l'arrivée, souvent AVANT le médaillon ;
    //  C. le médaillon « dernières courses support Quinté+ ».
    // La plus RÉCENTE contenant une arrivée définitive l'emporte :
    // ainsi, quelle que soit la page désynchronisée, l'arrivée
    // affichée est toujours le dernier résultat réel.
    course.arriveeDerniere = null;
    course.prochaineCourse = null;

    etape("Récupération de l'arrivée du dernier Quinté+…");
    const candidats = [];
    const urlVues = new Set();
    const ajouterCandidat = (urlQuelconque, dateIso) => {
      if (!urlQuelconque || !dateIso) return;
      const u = urlQuelconque.replace("/cotes/", "/resultats-PMU/").replace("/pronostics-PMU/", "/resultats-PMU/");
      if (!u.includes("/resultats-PMU/") || urlVues.has(u)) return;
      urlVues.add(u);
      candidats.push({ url: u, dateIso });
    };
    if (coursePageQuinte) {
      ajouterCandidat(coursePageQuinte.urlCotes, coursePageQuinte.dateCourse);
      ajouterCandidat(coursePageQuinte.urlDernierResultat, coursePageQuinte.dateDernierResultat);
    }
    if (courseCT) ajouterCandidat(courseCT.urlCotes, courseCT.dateCourse);

    const trouves = [];
    for (const c of candidats) {
      try {
        const { texte: pageRes } = await fetchTexte(c.url, erreurs, "Canalturf — page résultat");
        if (contientArrivee(pageRes)) {
          trouves.push({ resultat: parsePageResultat(pageRes, c.dateIso), dateIso: c.dateIso });
        }
      } catch (e) {
        // Page absente ou inaccessible : course pas encore courue ou
        // lien périmé — ce n'est pas une erreur, candidate suivante.
      }
    }
    let dateDernierResultat = null;
    if (trouves.length) {
      trouves.sort((a, b) => b.dateIso.localeCompare(a.dateIso));
      course.arriveeDerniere = trouves[0].resultat;
      dateDernierResultat = trouves[0].dateIso;
      statuts.arrivee.etat = "ok";
      statuts.arrivee.detail = `arrivée du ${course.arriveeDerniere.dateTexte || "dernier Quinté+"} — ${course.arriveeDerniere.arrivee.length} premiers chevaux`;
    } else {
      statuts.arrivee.etat = "ko";
      statuts.arrivee.detail = candidats.length
        ? "aucune page résultat ne contient d'arrivée définitive"
        : "lien vers le dernier résultat introuvable sur la page Quinté";
    }

    // Prochaine course : la comparaison se fait sur les dates publiées
    // par la source (ISO), jamais sur l'horloge du navigateur. La
    // référence est la date de la course ANALYSÉE (celle de la presse).
    const dateRef = (courseCT && courseCT.dateCourse) || datePresseIso;
    const courseAnalyseeCourue = !!(dateDernierResultat && dateRef && dateDernierResultat >= dateRef);
    if (!courseAnalyseeCourue) {
      // Course analysée pas encore courue : c'est elle la prochaine.
      const dateTxt = dateRef ? dateTexteIso(dateRef) : null;
      if (dateRef || course.depart) {
        course.prochaineCourse = { heure: course.depart || null, nom: course.nom || null, jour: null, dateTexte: dateTxt };
      }
      if (statuts.arrivee.etat === "ok") {
        statuts.arrivee.detail += " — prochaine course : " + (dateTxt || "N/D") + " " + (course.depart || "N/D");
      }
    } else {
      // Course analysée déjà courue : le prochain Quinté+ est celui
      // d'un jour ultérieur, lu dans les listes Canalturf (déjà
      // récupérées si une récupération de course a eu lieu).
      try {
        if (!listesCourses.length) {
          for (const u of [URL_LISTE_JOUR, URL_LISTE_DEMAIN]) {
            try {
              const { texte } = await fetchTexte(u, erreurs, "Canalturf — liste des pronostics");
              listesCourses.push(...parseListeCourses(texte));
            } catch (e) { /* liste indisponible : tentative suivante */ }
          }
        }
        const suivantes = listesCourses
          .filter(c => c.quinte && c.dateIso && c.dateIso > dateRef)
          .sort((a, b) => a.dateIso.localeCompare(b.dateIso));
        const pro = suivantes[0];
        if (!pro || !pro.heure) throw new Error("course support du prochain Quinté+ introuvable");
        course.prochaineCourse = { heure: pro.heure, nom: pro.nom, jour: null, dateTexte: dateTexteIso(pro.dateIso) };
        statuts.arrivee.detail += " — prochaine course : " + dateTexteIso(pro.dateIso) + " " + pro.heure;
      } catch (e) {
        // L'arrivée reste affichée ; seule l'heure de la prochaine
        // course passe à N/D (rien n'est deviné).
        statuts.arrivee.etat = statuts.arrivee.etat === "ok" ? "partiel" : statuts.arrivee.etat;
        statuts.arrivee.detail += " — heure de la prochaine course indisponible : " + e.message;
      }
    }

    return { course, partants, statuts, erreurs };
  }

  return { actualiserTout, parsePressePartants, parseSynthesePresse, parsePageQuinte, parsePagePronostic, parsePageCotes, parseFicheCheval, parsePageTurfFrQuinte, parsePartantsTurfFr, parsePartantsTurfFrNoms, parsePageResultat, parsePagePronosticsDemain, parseListeCourses, parsePagePronosticsCourse, comparerPartants, cleNom, isoDepuisDateTexte, parseMusiqueForme, analyserPelotonHandicap };
})();
