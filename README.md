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
| `$PATCH_BRANCH` (défaut `feat/argv-worker-start`) | **la source de vérité** — par défaut le head de la PR upstream #16425, rebasé sur `upstream/main` chaque nuit. Réglable sur une branche propre au fork (variable `PATCH_BRANCH`), et la nuit n'écrit alors plus la branche de la PR | un humain pour le contenu, **la CI pour la base** |
| tags `fork-*` | le SHA exact buildé et publié, immuable | **la CI seule** |
| `$CUSTOM_BRANCH` (au choix) | **tes personnalisations**, empilées sur le patch. Buildée et publiée, **jamais poussée nulle part** | **toi seul** |

`PATCH_BRANCH` et `CUSTOM_BRANCH` doivent partager **la même base amont** : la
sélection des customs est `patch...custom` par patch-id, donc une `CUSTOM_BRANCH`
portée sur une base plus récente que le patch ferait entrer la churn amont dans
tes commits et rejouerait le patch en double. Les deux variables bougent
ensemble, en un geste :

```bash
gh variable set PATCH_BRANCH  --repo flosrn/orca --body fork-patch-v1.4.199
gh variable set CUSTOM_BRANCH --repo flosrn/orca --body feat/fork-1.4.199
```

**La surface du patch est gelée, pas sa base.** La CI rejoue la plage
`merge-base(upstream/main, patch)..patch`, puis force-push `$PATCH_BRANCH`.
Avec `PATCH_BRANCH=fork-patch-v1.4.199`, seule cette branche du fork bouge :
la branche liée à la PR upstream reste inchangée.

Le tag existe en plus de la branche parce qu'une branche bouge : la release doit
pointer un SHA immuable, celui qui a été testé et buildé.

## Personnaliser Orca sans que rien ne parte upstream

Le canal build une branche à toi, réglée par la **variable de dépôt**
`CUSTOM_BRANCH` (Settings → Secrets and variables → Actions → Variables). Vide,
le canal est nu : le patch seul, comportement d'origine.

```
upstream/main
  └── $PATCH_BRANCH              ← patch seul, force-pushé par la CI
        └── <ta branche>          ← tes commits. La CI les LIT, ne les écrit pas.
```

Pour commencer :

```bash
git checkout -b feat/mon-orca feat/argv-worker-start
# ... code, commit ...
git push -u origin feat/mon-orca
gh variable set CUSTOM_BRANCH --repo flosrn/orca --body feat/mon-orca
```

Ce qui garantit que ça ne remonte jamais, et qui n'est pas de la discipline :

- **La CI ne pousse ta branche nulle part.** Elle la lit, rejoue tes commits sur
  le patch du jour, et le résultat ne vit que dans le tag immuable de la release.
  Ta copie locale ne divergera donc jamais d'un force-push nocturne.
- **`$PATCH_BRANCH` ne reçoit QUE la plage du patch.** Une garde compte
  les commits poussés sur cette branche et échoue si le compte dépasse la plage
  attendue — une fuite arrête le run avant tout push.
- **La variable refuse `CUSTOM_BRANCH == PATCH_BRANCH`**, pour ne jamais
  réécrire la branche de personnalisations comme une branche patch.
- **Aucune URL vers upstream côté push.** Le remote d'écriture est construit
  depuis `$GITHUB_REPOSITORY` ; le remote `upstream` ne sert qu'au `fetch`.

Ta branche peut être basée sur un état **périmé** du patch : la sélection se fait
par patch-id (`git rev-list --cherry-pick --right-only`), pas par ancêtre commun.
`merge-base` remonterait avant les commits du patch que ta branche porte encore
et les rejouerait en double — mesuré : 4 commits sélectionnés au lieu de 2, dont
les 2 du patch. `test-cherry-selection.sh` garde cette propriété.

Deux contraintes qui restent tiennes :

- **Garde ta branche linéaire** (rebase, pas merge) : `cherry-pick` ne sait pas
  rejouer un commit de merge, et ils sont écartés par `--no-merges`.
- **Les tests du canal restent ciblés** sur `src/main/runtime/orchestration` et
  `src/main/runtime/rpc`, les deux arbres que le patch touche. Le typecheck est
  complet, lui. Si tu customises ailleurs, élargis la liste du job `test` —
  sinon tu build vert sur du code que rien n'exerce. Le seul filet transverse
  est le gate renderer (ci-dessous) : il boote l'app construite et refuse
  la release si un error boundary a tiré. Il attrape ce que les tests
  unitaires ne peuvent pas voir (ils mockent le store), pas une régression
  fonctionnelle dans ta branche.

## Builder un ref tel quel, sans rebase (`source_ref`)

Le chemin nocturne **fabrique** sa source : il rejoue le patch sur
`upstream/main`, empile `$CUSTOM_BRANCH`, et force-push `$PATCH_BRANCH`. C'est
ce qu'on veut chaque nuit, et c'est exactement ce qu'on ne veut pas quand la
source voulue **existe déjà** — une branche perso dans laquelle le patch et tes
commits sont intégrés et testés. Là, rejouer ne sert à rien, et republier la
branche de la PR #16425 pour livrer un binaire serait un effet de bord sur une
branche que des relecteurs upstream lisent.

Dispatch en donnant le ref à builder :

```bash
gh workflow run fork-nightly.yml --repo flosrn/orca --ref fork-pipeline \
  -f source_ref=<sha>
```

**Donne un SHA, pas un nom de branche.** Une branche est acceptée, mais seul un
SHA rend le build indépendant d'un push qui arriverait pendant le run.

Ce que le run fait alors, et rien d'autre :

1. il résout `source_ref` **une seule fois**, dans ce dépôt, en un SHA exact ;
2. il vérifie que ce SHA porte tes personnalisations (ci-dessous) ;
3. il pose un tag immuable `fork-<UTC>-<sha12>` sur **ce** SHA ;
4. il enchaîne les jobs habituels — `test`, `build-mac`, `build-linux`,
   `release` — qui consomment le **tag**, jamais le ref.

Ce qu'il ne fait pas : aucun rebase, aucun `cherry-pick`, aucun fetch d'upstream,
aucun push de `$PATCH_BRANCH` ni de `fork-channel`. Les gates sont les mêmes :
un build manuel n'achète aucune dispense, et la release porte le même fichier
`SHA256SUMS`.

### La garde de composition

Tant que `CUSTOM_BRANCH` est réglée, un `source_ref` qui ne porte pas ses
commits est **refusé avant le tag** : pas de tag, pas de build, pas de release.
La comparaison est faite par patch-id (`git cherry`), donc une source rebasée
ou cherry-pickée passe — les SHA changent, les patch-ids non.

Elle refuse aussi un portage **réadapté** (conflit résolu à la main : le
patch-id change), et c'est voulu — la CI ne peut pas savoir qu'un portage est
fidèle. Le réglage est alors de faire pointer la paire `PATCH_BRANCH` /
`CUSTOM_BRANCH` sur les branches de la nouvelle base ; le résumé du run
imprime la commande. Assumer un canal nu se dit explicitement :
`gh variable delete CUSTOM_BRANCH --repo flosrn/orca`.

Chaque release porte la ligne `personnalisations : incorporated | bare`, et le
zip macOS porte dans `Contents/Resources/orca-local-build.json` le SHA de la
source réellement buildée — une étape du build le vérifie.

Trois choses à savoir :

- **`source_ref` ne peut désigner qu'un ref de CE dépôt.** L'API interrogée ne
  connaît que `flosrn/orca`, et une garde n'accepte qu'un nom de ref simple :
  pas d'URL, pas de `owner/repo:ref`, et pas de révision calculée (`main~3`,
  `HEAD^`, `..`) dont le résultat dépendrait du moment de la lecture.
- **`FORK_PUSH_TOKEN` est requis** ici aussi, pour créer le tag. Absent, le run
  s'arrête net avec la commande à lancer, avant tout build.
- **Un run manuel ne fait jamais sauter une nightly.** Son identité est écrite
  `manual-<sha12>`, volontairement non hexadécimale : la garde de fraîcheur du
  chemin nocturne ne sait pas la lire, donc elle rebuildera la nuit suivante au
  lieu de conclure « rien n'a bougé ». Le coût est un build nocturne de plus,
  une fois ; l'inverse — une nightly qui saute parce qu'un run manuel a publié —
  serait un canal qui ignore silencieusement upstream.

`force` ne sert à rien avec `source_ref` : un dispatch explicite est déjà la
décision de builder.

## Ce que le workflow fait (`.github/workflows/fork-nightly.yml`)

1. **rebase** — `git cherry-pick` des commits de `$PATCH_BRANCH` (la plage
   `merge-base(upstream/main, patch)..patch`, rien de plus) sur
   `upstream/main`, avec `git rerere` amorcé depuis `rerere-cache/`. Résultat
   force-pushé sur `$PATCH_BRANCH`, puis taggé `fork-*`.
2. **test** — `pnpm typecheck` + vitest sur `src/main/runtime/orchestration` et
   `src/main/runtime/rpc`, les deux seuls répertoires que le patch touche ;
   puis le **gate renderer** : `gates/renderer-boot-crash-free.spec.ts` (sur
   cette branche, copié dans `tests/e2e/` au vol) boote l'app construite en
   mode e2e sous Xvfb, attend la session, et lit `crash-reports.json` — le
   même fichier qu'en prod. Un boundary qui a tiré = job rouge, pas de build,
   pas de release. Origine : build `6feef259b9f5`, React #185 dans la barre
   d'état au premier rendu, invisible pour les tests amont qui mockent le
   store.

   Puis le **gate perso**, quand le build est censé porter tes
   personnalisations : les specs listés dans `gates/custom-meter-specs.txt`
   doivent exister **dans la source** et passer. Booter ne suffit pas — une
   app privée de ses compteurs de quota boote très bien, et c'est comme ça
   qu'un build amputé est parti vert. Tu customises ailleurs que les
   compteurs : ajoute ton spec à cette liste.
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

Sans `FORK_PUSH_TOKEN`, le job de rebase s'arrête **avant** de publier : un
tag GitHub dont l'arbre contient les workflows d'upstream est rejeté avec
`GITHUB_TOKEN` (pas de scope `workflow`). On ne tague pas autre chose que
ce SHA — donc pas de release tant que le secret n'est pas là.

```bash
gh secret set FORK_PUSH_TOKEN --repo flosrn/orca
# PAT classic, scopes repo + workflow
gh secret set TELEGRAM_BOT_TOKEN --repo flosrn/orca
gh secret set TELEGRAM_CHAT_ID  --repo flosrn/orca
```

Sans les deux secrets Telegram le workflow **reste rouge** quand il échoue, il
perd seulement la notification — un canal d'alerte muet qui donne l'illusion
d'une surveillance serait pire que pas d'alerte.

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
