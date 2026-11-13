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

Les cotes ne sont pas récupérées : la source PMU (géo-restreinte) a été
abandonnée et aucune cote n'est affichée.

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
Canalturf) afin de contourner le blocage CORS du navigateur. Sans elle,
l'accès direct est bloqué par le navigateur.

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
- **3 dernières sorties** : 1er en vert, 2ème en bleu, 3ème en orange — les
  autres résultats gardent l'apparence standard, l'ordre chronologique est
  conservé.
- **Colonne Déferrage** : déferrage de la course du jour — `D4` (déferré des 4),
  `DA` (antérieur), `DP` (postérieur), `—` (non déferré), `N/D` si la source
  ne le précise pas (aucune valeur inventée).
