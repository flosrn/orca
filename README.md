# flosrn/orca — canal fork entretenu

Cette branche n'est pas du code Orca. C'est la **branche de pilotage** du canal
fork décrit par [ADR 0026][adr] : un Orca patché qui tourne sur le Mac de Flo
tant que le correctif `worker-start` n'est pas dans un build officiel.

Le correctif lui-même est proposé en amont dans **stablyai/orca#16425**. Ce fork
est un pont, pas un produit : quand la PR passe, tout ce qui est décrit ici est
retiré (voir « Chemin de sortie » en bas).

## Pourquoi une branche par défaut qui ne contient pas de code

GitHub ne déclenche un `schedule` **que depuis la branche par défaut du dépôt**.
Trois dispositions étaient possible ; celle-ci est retenue :

| disposition | coût |
| --- | --- |
| workflow sur `main` (miroir upstream) | `main` cesse d'être un miroir : il faut le rebaser et le force-pusher tous les jours pour garder le commit du workflow au-dessus, sur la branche par défaut, c'est-à-dire l'endroit le plus cher à casser. |
| workflow sur la branche patch | interdit : la surface du patch est gelée, et cette branche est le head de la PR upstream — tout commit s'y ajoute au diff que des tiers relisent. |
| **branche `fork-pipeline` orpheline, par défaut** | elle ne rebase jamais, elle ne contient rien qui puisse conflicter, et aucune des ~29 workflows d'upstream ne vit dessus — donc aucune n'est déclenchable par erreur sur ce fork. |

Effet de bord voulu : la page d'accueil du fork montre ce fichier, donc ce que
ce dépôt est. Un visiteur ne prend pas ce fork pour une copie d'Orca.

## Les refs

| branche / ref | rôle | qui écrit |
| --- | --- | --- |
| `fork-pipeline` (défaut) | ce README, le workflow, le cache `rerere` | un humain |
| `main` | miroir d'`upstream/main`, jamais modifié | `gh repo sync` |
| `feat/argv-worker-start` | **head de la PR upstream #16425. GELÉE.** | un humain, jamais la CI |
| tags `fork-*` | le patch rejoué sur `upstream/main` du jour | **la CI seule** |

La CI ne touche jamais `feat/argv-worker-start`. C'est délibéré : force-pusher le
head d'une PR ouverte chaque nuit relancerait la CI d'upstream sur leur machine
tous les jours pour un rebase que personne n'a demandé. Le rebase quotidien
atterrit donc sur un tag `fork-*`, SHA exact = upstream + patch, rien de plus.

Un tag plutôt qu'une branche `fork-channel` : `GITHUB_TOKEN` n'a pas le scope
`workflow`, et une branche nouvelle portant les ~30 workflows d'upstream
(absents de cette branche par défaut) est rejetée. Un tag n'installe aucun
workflow et conserve le SHA intact.

## Ce que le workflow fait (`.github/workflows/fork-nightly.yml`)

1. **rebase** — `git cherry-pick` des commits de `feat/argv-worker-start` (la
   plage `merge-base(upstream/main, patch)..patch`, rien de plus) sur
   `upstream/main`, avec `git rerere` amorcé depuis `rerere-cache/`. Résultat
   poussé comme tag `fork-*`.
2. **test** — `pnpm typecheck` + vitest sur `src/main/runtime/orchestration` et
   `src/main/runtime/rpc`, les deux seuls répertoires que le patch touche.
3. **build-mac** / **build-linux** — zip macOS arm64 **non signé** et `.deb`
   amd64, en parallèle.
4. **release** — un tag `fork-<AAAAMMJJ>-<HHMM>-<sha12>` sur ce fork, avec les
   deux artefacts et un `SHA256SUMS`.
5. **alert** — si quoi que ce soit échoue (conflit de rebase compris), un
   message Telegram.

Le jour où le rebase conflicte, le job échoue **avant** de builder quoi que ce
soit, liste les fichiers en conflit dans le résumé du run, et alerte. La
résolution est humaine (5–15 min), et elle s'enregistre pour la fois suivante :

```bash
cd ~/Code/flosrn/orca
git config rerere.enabled true
git fetch upstream main
git rebase upstream/main feat/argv-worker-start   # résous, puis:
# la résolution est maintenant dans .git/rr-cache — publie-la:
git fetch origin fork-pipeline
git worktree add /tmp/fp origin/fork-pipeline     # ou clone à part
cp -R .git/rr-cache/. /tmp/fp/rerere-cache/
cd /tmp/fp && git add rerere-cache && git commit -m 'rerere: <fichier en conflit>' && git push
```

`rerere` ne devine rien : il rejoue **à l'identique** une résolution qu'un humain
a déjà faite sur les mêmes hunks. C'est exactement ce qu'on veut d'un rebase
automatique — il ne prend aucune décision nouvelle.

## Pourquoi `publish: null` au build

`config/electron-builder.config.cjs` (côté code, upstream) porte
`publish: { provider: 'github', owner: 'stablyai', repo: 'orca' }`. Laisser ça
en place ferait écrire un `app-update.yml` dans le bundle, c'est-à-dire un build
fork qui interroge les releases d'upstream et propose de s'écraser lui-même avec
l'officiel. Le workflow écrit donc au moment du build un fichier de config
dérivé, `config/electron-builder.fork.config.cjs`, qui neutralise `publish` —
**jamais commité sur la branche patch**, pour ne pas grossir le diff de la PR.

Une étape du workflow vérifie ensuite l'absence de `app-update.yml` dans les
deux artefacts. Sans ça, la propriété tiendrait par croyance.

## Consommer les artefacts

- **Mac** : `~/orca-fork/update.sh` — télécharge, vérifie le sha256, purge la
  quarantine, **re-signe avec le certificat local « Orca Dev »** (les grants TCC
  y sont épinglés ; un artefact CI non re-signé les perd tous), stage sous
  `~/orca-fork/builds/<tag>/`. Il ne bascule jamais l'app : `swap.sh` reste un
  geste humain, Orca quitté.
- **VPS** : `~/.omp/agent/versions.yml` porte la dimension `orca_channel`, et
  `sync-toolchain.ts --apply` installe le `.deb` de la release en vérifiant le
  sha256 épinglé.

## Secrets attendus

Un seul canal d'alerte, deux secrets. Sans eux le workflow **reste rouge** quand
il échoue, il perd seulement la notification — un canal d'alerte muet qui donne
l'illusion d'une surveillance serait pire que pas d'alerte.

```bash
gh secret set TELEGRAM_BOT_TOKEN --repo flosrn/orca
gh secret set TELEGRAM_CHAT_ID  --repo flosrn/orca
```

## Chemin de sortie

Quand #16425 (ou un correctif équivalent) est dans un build officiel :

1. `bash ~/orca-fork/rollback.sh` — l'app officielle parquée reprend sa place.
2. `~/.omp/agent/versions.yml` : `orca_channel: official`, et on retire le bloc
   `orca_tag` / `orca_artifacts`.
3. `bun ~/.omp/agent/scripts/bump-toolchain.ts` — le VPS revient sur le `.deb`
   officiel.
4. Ici : supprimer `fork-channel`, remettre la branche par défaut sur `main`
   (`gh repo edit flosrn/orca --default-branch main`), supprimer cette branche.
   Le fork peut rester en place, au repos.

[adr]: https://github.com/flosrn/orca/blob/fork-pipeline/README.md
