# TurfMetrics Pro — PRD & Implementation Log

## Problème initial
Web app d'analyse des chevaux pour les courses PMU. Première étape: construire une interface
récupérant, croisant, calculant et présentant dans un tableau structuré les infos clés de
chaque cheval. Sources: pronostics-turf.info (valeur, âge, courses/vict/places), pronostics-turf.info/ (citations), paris-turf.com/quinte/aujourdhui (sexe/âge, musique).
Tableau classé par Valeur décroissante (verrouillé). Gestion N/D pour données manquantes.
Historique sauvegardé. Pas encore de système de sélection automatique du Quinté.

## Utilisateur et objectif
- **Persona**: Turfiste utilisant une méthode propriétaire de sélection basée sur la valeur.
- **Objectif V1**: Base de données/tableau fiable, croisant 3 sources, pour analyse rapide.

## Choix utilisateur
- Scraping en direct à chaque rafraîchissement
- Course par défaut: Quinté+ du jour (automatique)
- Thème sombre "turf pro" (émeraude/or, typographie Barlow Condensed + Outfit + JetBrains Mono)
- Historique en base MongoDB
- Si source indisponible: N/D + bandeau d'alerte

## Architecture
- **Backend** FastAPI (`/app/backend/server.py`, `scrapers.py`) sur port 8001, prefix `/api`.
- **Frontend** React 19 + Tailwind + Sonner + Lucide (`/app/frontend/src/App.js`).
- **MongoDB** collection `race_analyses` (`_pk`, `id`, `created_at`, `race`, `horses`, `sources`, `warnings`).
- **Proxy scraping**: `r.jina.ai` (Cloudflare bloque les requêtes directes vers paris-turf et pronostics-turf). Headers minimaux (User-Agent: curl/8.4).
- 3 scrapers en `asyncio.gather`.

## Endpoints
- `GET /api/analysis/current` — scrape live + fusion + tri par valeur desc, non persisté.
- `POST /api/analysis/save` — scrape + sauvegarde en MongoDB.
- `GET /api/analysis/history?limit=30` — résumés des analyses sauvegardées.
- `GET /api/analysis/{id}` — détail d'une analyse (404 si inconnue).

## Modèle horse
```
number, name, valeur, citations, sexe_age (F3/M7/H9 ou ?N),
age, courses, victoires, places, win_rate (=((V+P)/C)*100, 1 décimale),
musique (brute Paris-Turf), last3 ("Xp - Xp - Xp"), jockey, entraineur
```

## Règles métier
- Tri verrouillé par `valeur DESC`, chevaux à valeur nulle placés en dernier.
- Calcul `win_rate = round((victoires + places) / courses * 100, 1)`.
- `last3` extrait de la musique Paris-Turf: tokens `(position)(type)` × 3 premiers après le `Nj•` et en ignorant les marqueurs annuels `(YY)`.
- N/D affiché si donnée absente — le cheval reste dans le tableau et son classement n'est pas modifié.

## Statut global
- V1 implémentée et testée (100% backend, 100% frontend).
- 3 sources scrapées en direct via r.jina.ai, 18 chevaux retournés pour la course du jour.
- Historique opérationnel.
- Tableau trié par Valeur décroissante avec médailles or/argent/bronze.
- Bandeau d'alerte N/D fonctionnel.
- Boutons Rafraîchir / Enregistrer / Historique avec toasts Sonner.

## Backlog (futures itérations)
### P1
- Sélection manuelle d'une course (menu déroulant R/C de la journée)
- Détail cheval (drawer avec jockey/entraîneur/gains/historique complet)
- Export CSV / impression du tableau

### P2 (préparation stratégie)
- Pondération manuelle des critères (sliders Valeur / Citations / Taux / Forme)
- Score composite propriétaire
- Comparateur de 2 chevaux côte à côte
- Suivi de performance de la méthode (hit rate sur l'arrivée réelle)

### P3
- Cotes en direct (PMU/ZEturf API)
- Indice jockey/driver + entraîneur sur 30 jours
- Statistiques terrain/distance/corde
- Alertes push quand le Quinté du lendemain est publié

## Fichiers clés
- `/app/backend/server.py` — API routes & merge logic
- `/app/backend/scrapers.py` — 3 scrapers Jina + parse markdown
- `/app/backend/requirements.txt` — httpx, bs4, lxml, motor, fastapi…
- `/app/frontend/src/App.js` — UI complète (Hero, Table, Sidebar, Toasts)
- `/app/frontend/src/index.css` — Thème turf pro (grain, animations, pbar)
- `/app/frontend/public/index.html` — Google Fonts

## Journal
- 2026-10-03 — MVP V1 livrée (scraping 3 sources, tableau trié verrouillé, historique, N/D, bandeau alertes). 100% des tests passés.
- 2026-10-03 — V1.1 Fiabilisation des données :
  - Citations distinguées : `0` (cheval non cité, source OK) vs `N/D` (source KO)
  - Suppression du fallback `?N` sur Sexe/Âge → N/D si Paris-Turf absent (jamais déduit du nom)
  - Nouveau champ `performances: list[{position, type, year}]` structuré pour la stratégie à venir
  - Parsing chronologique de la musique (left=plus récent) avec gestion des marqueurs `(YY)`
  - Nouveau champ `days_since_last` (jours depuis la dernière course)
  - Bandeau d'alerte reformaté avec headline : « N chevaux analysés — K sans citation — E erreurs »
  - Taux de réussite affiché au format exact : « 50,0 % (2 V + 4 P) / 12 courses »
  - 25 tests backend passés (13 Phase 1 + 13 Phase 2), 100% UI OK
- 2026-10-03 — V1.2 Nouvelle colonne & victoires max :
  - Ajout de la colonne **Corde** entre Citations et Sexe/Âge
  - Discrimination `N/A` (discipline sans corde : Attelé/Monté) vs `N/D` (Plat/Haie/Steeple sans donnée)
  - Agrégat `stats.max_victoires` calculé côté backend
  - Mise en vert émeraude uniquement du chiffre + "V" du ou des chevaux au max de victoires
  - Scraper paris-turf passé en mode `X-Return-Format: markdown` (navigateur headless Jina) + retry + détection stub Cloudflare
  - 10 tests Phase 3 passés (35 au total), 100% UI OK
- 2026-10-03 — V1.4 Correction fiabilité cote (bug utilisateur) :
  - **Nouvelle source officielle `PMU.fr`** (API JSON publique `offline.turfinfo.api.pmu.fr`) pour les cotes live
  - Paris-Turf ne lit plus la cote (c'était la "cote probable" = estimation, pas la cote live) — `include_cote=False` par défaut
  - Chaque snapshot cote tagué avec `source`, `source_url`, `type_rapport (DIRECT|REFERENCE)`, `cote_time`, `trend`, `trend_pct`
  - 4ème pastille source `pmu_cotes` dans le header + badge "PMU · LIVE" + heure du rapport sur chaque cellule cote
  - Affichage heure de cote localisée Europe/Paris
  - Vérifié : horse #3 Golden Weaver passe de 52/1 (ancienne cote probable Paris-Turf) à 24/1 DIRECT (valeur réelle du marché PMU au moment de la récupération)
  - 14 tests Phase 5 passés (63 au total), UI 100% OK
- 2026-10-03 — V1.3 Suivi des cotes :
  - Nouvelles colonnes **Cote** (ex: `3/1`, `5,9/1`) et **Évolution cote** (`29/1 → 3/1 · -26 · -89,7 %`)
  - Collection MongoDB `cote_snapshots` par (race_id, horse_number) — race_id = sha256(name+date)[:16]
  - Logique idempotente : comparaison contre le dernier snapshot avec cote *différente* → mouvement reste visible entre deux refresh identiques (robuste à React StrictMode)
  - Direction : `BAISSE` (vert), `HAUSSE` (rouge), `STABLE` (gris), `NOUVEAU` (ambre + icône Sparkles)
  - Animation CSS keyframes `cote-anim-down/up` + `cote-swap` à chaque changement détecté
  - Nouvelle route `GET /api/cotes/history/{race_id}/{horse_number}` → timeline enrichie (delta, pct, direction entre chaque snapshot)
  - Guard `didInitRef` dans App.js pour éviter double-fetch StrictMode
  - 14 tests Phase 4 passés (49 au total), UI 100% OK
