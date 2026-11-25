# TURFMETRICS PRO

Application web personnelle d'analyse hippique : partants du Quinté+ du jour
classés par **valeur décroissante** (valeur propriétaire pronostics-turf.info,
reprise à l'identique), citations de la revue de presse, statistiques et
sélection personnelle de 8 chevaux.

## Principes

- 100 % statique : aucune base de données, aucun compte, aucun historique.
- Les données sont récupérées à la demande (bouton « Rafraîchir les données »
  et à l'ouverture). La sélection des 8 chevaux vit en `sessionStorage`
  (elle disparaît à la fermeture de l'onglet).
- Aucune donnée n'est fabriquée ni modifiée : une information indisponible
  affiche **N/D** ; un cheval « non cité » dans la revue de presse affiche **0**.
- Sur mobile (≤ 880 px), le bandeau des états des sources est repliable
  (« Réduire / Afficher les états ») pour dégager l'écran vers la course et
  les chevaux ; développé par défaut, l'état est conservé en mémoire pendant
  la navigation et les statuts continuent de se mettre à jour. La présentation
  ordinateur est inchangée.

## Sources

| Rôle | Source | Contenu |
|---|---|---|
| Valeur | pronostics-turf.info — `presse-partants-pmu.php` | valeur brute publiée (« sa valeur »), âge, n° à la corde, jockey/driver, entraîneur, gains, statistiques courses / victoires / placés, déferrage de la course du jour |
| Citations | pronostics-turf.info — `liste-synthese-de-pronostics-turf.php` | « LISTE RÉCAPITULATIVE — Position / Numéro / Fois cité » de la revue de presse hippique |
| Sexe/Âge & musique | Fiches Canalturf | sexe, âge, musique, 3 dernières sorties, réunion/course |
| Cotes PMU | Canalturf — page « /cotes/ » de la course | historique horodaté des cotes PMU par cheval (relevés ~toutes les 10 min) : « Cote actuelle » = dernier relevé, « Dernière cote » = relevé précédent, « Variation cote » = (actuelle − dernière) / dernière × 100, heure du relevé affichée |
| Valeurs handicap | Canalturf — page « pronostics-PMU » de la course | colonnes « Val. », « Poids », « Corde » et musique du tableau des partants (handicaps de plat uniquement) |
| Corde (plat) | turf-fr.com — `/quinte/` puis fiche « partants » de la course ; page pronostics Canalturf en secours (course vérifiée) | numéro de corde réel (stalles de départ) des courses de plat, que pronostics-turf.info ne publie pas (en plat, « Poteau » est remplacé par « Poids ») |
| Arrivée & prochaine course | Canalturf — page résultat de la course du jour (dérivée du pronostic, comme les cotes) en priorité, médaillon « dernières courses support Quinté+ » en repli ; page `courses_liste_pronostics_demain.php` | arrivée du dernier Quinté+ disputé (8 premiers : place, dossard, nom) — la page résultat de la course du jour est mise en ligne dès l'arrivée, souvent avant le médaillon ; heure de la prochaine course — aujourd'hui si la course du jour n'est pas courue, demain sinon (comparaison sur les dates publiées, jamais sur l'horloge du navigateur) |

Les cotes ne sont pas lues directement sur PMU : l'API officielle est
géo-restreinte à la France et inaccessible depuis les fonctions Netlify
(hébergées hors de France). La page Canalturf, déjà utilisée par
l'application, publie le même flux de cotes PMU avec historique — elle est
donc la source retenue. Si la série n'est pas encore publiée (plus de ~2 h
avant la course) ou si un cheval n'a qu'un seul relevé, la colonne affiche
**N/D** — aucune cote n'est estimée.

Les pages pronostics-turf.info sont publiées en windows-1252 : la couche de
récupération détecte automatiquement le charset (UTF-8 strict, sinon
windows-1252) et les proxys relaient les octets bruts sans conversion.

**Protection anti-bot** : pronostics-turf.info est passé derrière une
vérification YOORhosting (challenge JavaScript « Vérification de sécurité »).
Les proxys la résolvent automatiquement : un POST signé (en-tête `X-YOOR-L7`)
vers `/__yg_l7_js_pass_https` pose un cookie de passage (`yg_l7_pass`,
~30 jours), mémorisé le temps de vie de l'instance serverless, puis la page
demandée est servie normalement. Si la réponse reste une page de vérification,
le challenge est rejoué une fois avant d'échouer. Aucune donnée n'est stockée
hors du processus.

**Cohérence entre sources (anti-mélange de courses)** : en soirée, la presse
(source des valeurs) bascule sur la course du lendemain alors que la page
Quinté Canalturf peut être restée sur celle du jour — et inversement le matin.
Fusionner par n° de dossard deux courses différentes afficherait la fiche, la
corde et les cotes d'un autre cheval sous le nom du premier. Avant toute
fusion, les **noms des chevaux sont comparés dossard par dossard** (forme
normalisée : majuscules, sans accents ni signes). Si les courses diffèrent, la
course de la presse est recherchée dans les listes de pronostics Canalturf
(date + hippodrome + icône Quinté+, puis nouvelle vérification nom par nom sur
sa page pronostics) ; si elle reste introuvable, aucune donnée Canalturf n'est
fusionnée (`N/D`, jamais de mélange). turf-fr.com subit le même contrôle : la
date de la course figure dans l'URL de sa fiche — si elle diffère de la date
publiée par la presse, ses numéros de corde sont ignorés, et chaque corde
n'est appliquée que si le nom du cheval concorde. L'arrivée affichée est
toujours la **page résultat datée la plus récente** parmi les candidates
(course de la page Quinté, course analysée, médaillon).

**Module « Analyse du handicap » (handicaps de plat uniquement)** : affiché
entre la carte course et le tableau principal, il ne s'active que si la ligne
d'identité publiée de la course contient le mot HANDICAP (et jamais en trot ni
sur une course à conditions). La **moyenne des valeurs handicap du peloton**
est calculée systématiquement, sur les seules valeurs disponibles — une valeur
absente est exclue du calcul (diviseur réduit) et affichée `N/D`, jamais
remplacée par zéro. Quatre critères, tous mesurés sur la course elle-même :

1. **valeur handicap × distance** — l'écart à la moyenne du peloton est lu
   selon la distance publiée : sur sprint (≤ 1400 m), une valeur nettement
   au-dessus du peloton est pénalisée (un cheval qui porte plus de poids n'a
   pas la distance pour revenir sur ceux qui portent moins) ; sur longue
   distance (≥ 2200 m), elle est valorisée (la classe a le temps de
   s'exprimer) ; « nettement » = au-delà de l'écart-type du peloton, mesuré
   sur la course (aucun seuil arbitraire) ;
2. **avantage poids** — résidu en kg de la régression des moindres carrés
   `poids = a + b × valeur` calibrée sur le peloton de la course (a et b
   mesurés, jamais importés ; négatif = décharge, positif = surcharge) ;
3. **forme récente** — top-5 sur les 6 dernières sorties de la musique
   publiée ;
4. **corde** — C1 à C8 favorable, au-delà défavorable, absente = critère
   exclu (jamais inventée).

Le **potentiel Top 5** est une appréciation qualitative : ≥ 2 critères
favorables sans aucun défavorable → PROFIL FAVORABLE ; ≥ 2 critères
défavorables → PROFIL MOINS FAVORABLE ; sinon PROFIL À SURVEILLER, avec une
justification chiffrée par cheval. Ce n'est pas une probabilité
mathématique. Le classement principal par VALEUR et la sélection des 8
chevaux sont strictement inchangés — le module peut justement les
contredire (ex. la plus haute valeur du handicap n'est pas favorable sur un
sprint).

## Déploiement (Netlify ou Vercel)

Le dossier est prêt tel quel — **aucune étape de build**.

- **Netlify** : glisser-déposer le dossier sur app.netlify.com/drop
  (ou `netlify deploy`). `netlify.toml` déclare déjà la fonction proxy.
- **Vercel** : `vercel` à la racine. La fonction `api/proxy.js` est détectée
  automatiquement.

La micro-fonction proxy (`netlify/functions/proxy.js` / `api/proxy.js`) relaie
uniquement des GET vers les domaines autorisés (pronostics-turf.info,
Canalturf, turf-fr.com) afin de contourner le blocage CORS du navigateur.
Sans elle, l'accès direct est bloqué par le navigateur.

## Structure

```
index.html                  application (page unique)
css/style.css               identité visuelle
js/sources.js               connecteurs + parseurs (aucune donnée inventée)
js/classement.js            tri verrouillé — valeur décroissante
js/app.js                   orchestration, sélection 8 chevaux, rapport
netlify/functions/proxy.js  proxy Netlify
api/proxy.js                proxy Vercel
```

## Valeur & classement

La valeur affichée est la valeur brute publiée par pronostics-turf.info —
aucune pondération, aucun recalcul. Le classement est verrouillé : valeur
décroissante, puis citations décroissantes, puis numéro croissant en cas
d'égalité. Jamais de tri sur les cotes.

## Repères visuels

- **Or** : cheval(s) avec le plus grand nombre de victoires (ex æquo inclus).
- **Turquoise** : cheval(s) avec le plus grand nombre de places (ex æquo inclus).
- **3 dernières sorties** : 1er en vert, 2ème en bleu, 3ème en orange,
  4ème en violet, 5ème en rose — les autres résultats gardent l'apparence
  standard, l'ordre chronologique est conservé. Le classement reste celui
  de la valeur décroissante (la colonne « Rang » a été retirée).
- **Colonne Déferrage** : déferrage de la course du jour — `D4` (déferré des 4),
  `DA` (antérieur), `DP` (postérieur), `—` (non déferré), `N/D` si la source
  ne le précise pas (aucune valeur inventée). **En course de plat**, le
  déferrage est sans objet : la colonne devient « Corde » et affiche le
  numéro de corde réel (`C1`…`C16`, pastille turquoise) publié par
  turf-fr.com — jamais déduit du dossard, `N/D` si indisponible.
- **Favori** : le cheval à la plus faible cote actuelle (donnée réelle des
  relevés PMU/Canalturf) est marqué d'un badge « ★ Favori » et ajouté
  automatiquement à la sélection des 8 dès que les cotes sont publiées
  (ex æquo : tous les chevaux à la cote minimale). Un retrait manuel est
  respecté jusqu'à la fin de la session. Sans cotes : aucun favori. Les
  cotes ne modifient jamais le classement par valeur.
- **Dernière cote / Cote actuelle** : cotes PMU relevées par Canalturf
  (format PMU Play : 2,9 / 8,8 / 71 — décimales respectées). L'heure du
  dernier relevé figure dans l'encadré de la course (« Cotes relevées à »).
  Avant l'ouverture des relevés (~2 h avant le départ), N/D est affiché.
- **Variation cote** : évolution entre la dernière cote relevée et la cote
  actuelle, calculée uniquement à partir de ces deux valeurs Canalturf :
  `(actuelle − dernière) / dernière × 100`, arrondie à 0,1 pt pour
  l'affichage. Baisse = vert (▼), hausse = orange (▲), cote stable = gris
  (▶). Aucun calcul si une des deux cotes manque ou si la dernière vaut 0 :
  N/D. Une variation — à la baisse comme à la hausse — n'est en aucun cas
  une garantie de performance ou de victoire : ce n'est qu'une évolution
  de la cote PMU.
- **Dernière arrivée Quinté+** : les 8 premiers du dernier Quinté+ disputé
  (place, dossard, nom — repris à l'identique de la page résultat Canalturf,
  avec la date de la course affichée). Dès que la course du jour est courue,
  son résultat est lu directement sur sa page résultat (dérivée du lien
  pronostic, comme les cotes) : il est affiché sans attendre que la liste
  « dernières courses » de Canalturf soit actualisée. Places colorées comme
  les sorties : 1er vert, 2ème bleu, 3ème orange, 4ème violet, 5ème rose,
  6-8 neutres.
- **Prochaine course** : heure de départ lue telle que publiée (sans
  conversion de fuseau horaire), avec la **date réelle de la course**
  (publiée par la source, format JJ/MM/AAAA). Si le dernier résultat
  correspond à la course du jour (dates ISO comparées), la course du jour
  est déjà courue et l'heure affichée est celle du Quinté+ suivant (lue
  sur la page des pronostics de demain, date comprise) ; sinon c'est celle
  de la course du jour. N/D si la source ne la fournit pas.
