# Mise à jour automatique des scores (sans Claude)

`update-data.mjs` + le workflow `.github/workflows/live-update.yml` mettent à jour
`data.json` tout seuls pendant les matchs. La page `index.html` relit `data.json`
toutes les 60 s et fusionne les scores par-dessus les données intégrées — **aucune
republication n'est nécessaire** pour voir un score live ou final.

## Comment ça marche
1. Le GitHub Action se déclenche toutes les ~15 min (fenêtres de match, en UTC).
2. `update-data.mjs` interroge l'API publique **FotMob** : matchs du jour + de la
   veille (matchs de nuit), filtre la Coupe du Monde, traduit les noms d'équipes en
   français (clés de `FLAGS`) et écrit `data.json` au format overlay.
3. Si `data.json` a changé, l'Action commit/push automatiquement (avec rebase pour
   ne pas entrer en conflit avec la tâche Claude quotidienne).

## Périmètre
- Couvre la **phase de groupes** (mapping équipe→groupe déterministe) : scores +
  statut `live`/`done`, et buteurs en *best-effort*.
- **Ne couvre pas** la phase finale ni la rédaction des actus : c'est la tâche
  Claude quotidienne (08h GMT) qui consolide tout dans `index.html`, écrit les
  actualités, fiabilise le classement des buteurs et régénère le carnet PDF, puis
  remet `data.json` à vide.

## Tester / régler
- Onglet **Actions** du dépôt → *MAJ live data.json* → **Run workflow** (manuel).
- En local : `DEBUG=1 node scripts/update-data.mjs` (logs détaillés sur stderr).
- Dépendance : l'API FotMob est **non officielle**. Si sa structure change, ajuster
  les chemins de champs dans `statusOf` / `scoreOf` / `goalsOf`, ou mettre
  `FETCH_GOALS=0` pour ne garder que les scores. Aucune clé API requise.
