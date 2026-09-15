# flosrn/orca — canal fork entretenu

Cette branche n'est pas du code Orca. C'est la **branche de pilotage** du canal
fork : un Orca patché (personnalisations de Flo) qui suit la dernière release
stable d'upstream. Chaque nuit, la CI merge cette release dans la branche
d'intégration du fork, la teste, la package et la publie en Release.

## Pourquoi une branche par défaut qui ne contient pas de code

GitHub ne déclenche un `schedule` **que depuis la branche par défaut du dépôt**.
Une branche orpheline qui ne porte que ce README, le workflow et les gates ne
rebase jamais, ne conflicte jamais, et aucun des ~30 workflows d'upstream ne vit
dessus — donc aucun n'est déclenchable par erreur sur ce fork. Effet de bord
voulu : la page d'accueil du fork dit ce que ce dépôt est.

## Les refs

| ref | rôle | qui écrit |
| --- | --- | --- |
| `fork-pipeline` (défaut) | ce README, le workflow, `gates/` | un humain |
| `main` | miroir d'`upstream/main`, jamais modifié | `gh repo sync` |
| `$SOURCE_BRANCH` (variable, défaut `fix/fork-v1.4.203`) | **la branche d'intégration du fork complet** : upstream + toutes les personnalisations | un humain pour le contenu ; la CI l'avance en **fast-forward** après un merge nocturne vert |
| `$FORK_BASE_REF` (variable, défaut `feat/fork-1.4.200`) | le plancher d'ascendance : toute source publiée doit le contenir | personne |
| `fork-channel` | le dernier build publié avec succès, avancé en **fast-forward seul**. Posé une fois à la main sur le commit du build installé ; jamais deviné | **la CI seule** ensuite |
| tags `fork-<AAAAMMJJ>-<HHMM>-<sha12>` | le SHA exact buildé et publié, immuable | **la CI seule** |

```bash
gh variable set SOURCE_BRANCH --repo flosrn/orca --body fix/fork-v1.4.203
gh variable set FORK_BASE_REF --repo flosrn/orca --body feat/fork-1.4.200   # optionnel
# amorçage, une fois : le sha= de /Applications/Orca.app/Contents/Resources/fork-channel.txt
gh api --method POST repos/flosrn/orca/git/refs -f ref=refs/heads/fork-channel -f sha=<sha-installé>
```

## Ce que la nightly fait (`.github/workflows/fork-nightly.yml`)

1. **source** — fige `$SOURCE_BRANCH` sur un SHA (à défaut `fork-channel`),
   épingle la dernière release stable d'upstream (`releases/latest`, forme
   `vX.Y.Z`), et la **merge** dans la source — jamais de rebase, jamais de
   stratégie qui choisit un côté. Puis trois gardes d'ascendance, toutes avant
   le tag :
   - la source contient `$FORK_BASE_REF` (ni upstream nu, ni lignée abandonnée) ;
   - la source contient la release stable épinglée ;
   - la source contient le build publié (`fork-channel`).
   Rien à faire seulement si ce commit exact est déjà publié en Release.
   Sinon : tag immuable `fork-*` sur le SHA.
2. **test** — `pnpm typecheck`, vitest sur `src/main/runtime/orchestration` et
   `src/main/runtime/rpc`, puis deux gates en app réelle sous Xvfb :
   `gates/renderer-boot-crash-free.spec.ts` (aucun error boundary au boot) et
   les specs de `gates/custom-meter-specs.txt`, qui doivent exister **dans la
   source** et passer (les compteurs de quota perso sont livrés, pas supposés).
   Tu customises ailleurs que les compteurs : ajoute ton spec à cette liste.
3. **build-mac** / **build-linux** — zip macOS arm64 **non signé** et `.deb`
   amd64 ; chaque artefact doit annoncer le SHA buildé et ne pas contenir
   `app-update.yml`.
4. **release** — Release en brouillon avec les artefacts et `SHA256SUMS`, puis
   avance fast-forward de `$SOURCE_BRANCH` (si la source vient d'elle) et de
   `fork-channel`, puis publication. Une avance refusée ne publie rien.
5. **cleanup** — un run rouge retire son tag et son brouillon.
6. **alert** — échec ou annulation : message Telegram.

Pourquoi le merge et l'ascendance : `~/orca-fork/source-guard.sh` refuse
d'installer un build dont la source n'est pas égale ou descendante de celle en
place. Un rebase réécrit les SHA et casse cette preuve chaque nuit ; un merge la
préserve par construction.

## Quand le merge conflicte

Le job `source` échoue **avant** de tagger, liste les fichiers dans le résumé du
run et alerte. La résolution est humaine, une fois par release :

```bash
git fetch origin fix/fork-v1.4.203
git fetch https://github.com/stablyai/orca.git refs/tags/vX.Y.Z:refs/tags/vX.Y.Z
git switch -c integrate/vX.Y.Z origin/fix/fork-v1.4.203
git merge vX.Y.Z            # résous, puis commit
git push origin HEAD:fix/fork-v1.4.203   # fast-forward, jamais --force
```

La nuit suivante trouve la release déjà intégrée et n'a plus rien à merger.

## Builder un ref tel quel (`source_ref`)

```bash
gh workflow run fork-nightly.yml --repo flosrn/orca --ref fork-pipeline -f source_ref=<sha>
```

Une branche, un tag ou un SHA de **ce** dépôt (pas de `refs/…`, pas d'URL, pas
de révision calculée) ; donne un SHA pour que le build ne dépende pas d'un push
pendant le run. Aucun merge, aucune écriture de `$SOURCE_BRANCH` — mais les
trois gardes s'appliquent, et une publication avance `fork-channel` comme une
nightly : le prochain build devra en descendre. `force` ne sert à rien avec
`source_ref`.

## Pourquoi `publish: null` au build

`config/electron-builder.config.cjs` (côté code, upstream) publie vers
`stablyai/orca` : laisser ça en place écrirait un `app-update.yml` dans le
bundle, et le fork proposerait de s'écraser lui-même avec l'officiel. Le
workflow écrit au build une config dérivée, `config/electron-builder.fork.config.cjs`,
qui neutralise `publish` — jamais commitée. Une étape vérifie ensuite
l'absence d'`app-update.yml` dans les deux artefacts.

## Consommer les artefacts

- **Mac** : `~/orca-fork/orca-fork.sh` (alias `orca-update`) — garde de
  provenance, téléchargement, sha256, quarantine, **re-signature « Orca Dev »**
  (les grants TCC y sont épinglés), bascule, canari.
- **VPS** : `~/.omp/agent/versions.yml` porte `orca_channel`, et
  `sync-toolchain.ts --apply` installe le `.deb` en vérifiant le sha256 épinglé.
  Il ordonne encore les tags par nom : le fast-forward de `fork-channel` est sa
  seule garantie d'ascendance.

## Secrets attendus

```bash
gh secret set FORK_PUSH_TOKEN --repo flosrn/orca    # PAT classic, scopes repo + workflow
gh secret set TELEGRAM_BOT_TOKEN --repo flosrn/orca
gh secret set TELEGRAM_CHAT_ID  --repo flosrn/orca
```

Sans `FORK_PUSH_TOKEN` le run s'arrête avant tout build : `GITHUB_TOKEN` ne
peut ni tagger ni avancer une branche dont l'arbre contient les workflows
d'upstream (scope `workflow`). Sans les secrets Telegram le run reste rouge, il
perd seulement la notification.

## Chemin de sortie

Quand les personnalisations sont dans un build officiel, ou abandonnées :

1. `bash ~/orca-fork/rollback.sh` — l'app officielle parquée reprend sa place.
2. `~/.omp/agent/versions.yml` : `orca_channel: official`, et on retire le bloc
   `orca_tag` / `orca_artifacts`.
3. `bun ~/.omp/agent/scripts/bump-toolchain.ts` — le VPS revient sur le `.deb`
   officiel.
4. Ici : supprimer `fork-channel`, remettre la branche par défaut sur `main`
   (`gh repo edit flosrn/orca --default-branch main`), supprimer cette branche.
