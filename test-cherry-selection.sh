#!/bin/bash
# Prouve que `--cherry-pick --right-only` sélectionne les bons commits même
# quand la branche perso est basée sur un patch PÉRIMÉ — le cas où merge-base
# rejouerait les commits du patch en double.
#
# Pas de `mapfile` : bash 3.2 (macOS) ne l'a pas. Le runner ubuntu l'a, et le
# workflow l'utilise ; ici on lit la sélection ligne par ligne.
set -uo pipefail

R=$(mktemp -d /tmp/cherry.XXXXXX)
trap 'rm -rf "$R"' EXIT
cd "$R"
git init -q -b main .
git config user.email t@t
git config user.name t
c() { echo "$2" >"$1"; git add "$1"; git commit -qm "$3"; }

# upstream d'hier
c up1.txt a "upstream 1"
c up2.txt a "upstream 2"
upstream_old="$(git rev-parse HEAD)"

# le patch, sur upstream d'hier
git checkout -q -b patch-old
c patch1.txt a "patch: argv A"
c patch2.txt a "patch: argv B"

# tes customs, empilées sur le patch d'HIER
git checkout -q -b custom
c mine1.txt a "perso: mon theme"
c mine2.txt a "perso: mon raccourci"

# upstream bouge
git checkout -q main
c up3.txt a "upstream 3"
upstream_new="$(git rev-parse HEAD)"

# le pipeline rebase le patch dessus : nouveaux SHA
git checkout -q -B patch-new "$upstream_new"
git cherry-pick "$upstream_old..patch-old" >/dev/null

echo "=== ta branche perso est basée sur un patch PÉRIMÉ"
printf '  patch-old %s   patch-new %s (rebasé)   custom %s\n\n' \
  "$(git rev-parse --short patch-old)" "$(git rev-parse --short patch-new)" \
  "$(git rev-parse --short custom)"

echo "=== merge-base — LA MAUVAISE FAÇON"
mb="$(git merge-base patch-new custom)"
git log --oneline --no-decorate "$mb..custom" | sed 's/^/    /'
echo "    -> $(git rev-list --count "$mb..custom") commits, dont 2 du patch EN DOUBLE"
echo

echo "=== --cherry-pick --right-only — LA BONNE"
sel=""
while read -r s; do sel="$sel $s"; done < <(
  git rev-list --reverse --no-merges --cherry-pick --right-only patch-new...custom
)
for s in $sel; do echo "    $(git log -1 --format='%h %s' "$s")"; done
echo "    -> $(echo $sel | wc -w | tr -d ' ') commits"
echo

echo "=== rejeu sur le patch rebasé"
git checkout -q -B build patch-new
if git cherry-pick $sel >/dev/null; then echo "  cherry-pick OK"; else echo "  cherry-pick ÉCHOUÉ"; fi
echo "  fichiers : $(ls *.txt | tr '\n' ' ')"
git log --oneline --no-decorate "$upstream_new..build" | sed 's/^/    /'
echo

n="$(ls *.txt | wc -l | tr -d ' ')"
dup="$(git log --format=%s "$upstream_new..build" | sort | uniq -d)"
if [ "$n" -eq 7 ] && [ -z "$dup" ]; then
  echo "  RÉSULTAT : 7 fichiers, 4 commits, aucun sujet dupliqué — correct"
else
  echo "  RÉSULTAT : $n fichiers, doublons « ${dup:-aucun} » — INCORRECT"
  exit 1
fi
