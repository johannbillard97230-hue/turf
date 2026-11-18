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

## Sources

| Rôle | Source | Contenu |
|---|---|---|
| Valeur | pronostics-turf.info — `presse-partants-pmu.php` | valeur brute publiée (« sa valeur »), âge, n° à la corde, jockey/driver, entraîneur, gains, statistiques courses / victoires / placés, déferrage de la course du jour |
| Citations | pronostics-turf.info — `liste-synthese-de-pronostics-turf.php` | « LISTE RÉCAPITULATIVE — Position / Numéro / Fois cité » de la revue de presse hippique |
| Sexe/Âge & musique | Fiches Canalturf | sexe, âge, musique, 3 dernières sorties, réunion/course |
| Cotes PMU | Canalturf — page « /cotes/ » de la course | historique horodaté des cotes PMU par cheval (relevés ~toutes les 10 min) : « Cote actuelle » = dernier relevé, « Dernière cote » = relevé précédent, heure du relevé affichée |
| Corde (plat) | turf-fr.com — `/quinte/` puis fiche « partants » de la course | numéro de corde réel (stalles de départ) des courses de plat, que pronostics-turf.info ne publie pas (en plat, « Poteau » est remplacé par « Poids ») |
| Arrivée & prochaine course | Canalturf — médaillon « dernières courses support Quinté+ » → page `/resultats-PMU/`, et page `courses_liste_pronostics_demain.php` | arrivée du dernier Quinté+ disputé (8 premiers : place, dossard, nom) ; heure de la prochaine course — aujourd'hui si la course du jour n'est pas courue, demain sinon (comparaison sur les dates publiées, jamais sur l'horloge du navigateur) |

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
- **Dernière arrivée Quinté+** : les 8 premiers du dernier Quinté+ disputé
  (place, dossard, nom — repris à l'identique de la page résultat Canalturf,
  avec la date de la course affichée). Places colorées comme les sorties :
  1er vert, 2ème bleu, 3ème orange, 4ème violet, 5ème rose, 6-8 neutres.
- **Prochaine course** : heure de départ lue telle que publiée (sans
  conversion de fuseau horaire). Si le dernier résultat correspond à la
  course du jour (dates ISO comparées), la course du jour est déjà courue
  et l'heure affichée est celle du Quinté+ de demain ; sinon c'est celle
  de la course du jour. N/D si la source ne la fournit pas.
