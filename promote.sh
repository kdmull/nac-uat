#!/usr/bin/env bash
#
# Promote UAT to production.
#
# Brings every change from the UAT repo across to production EXCEPT CNAME.
# The two repos must carry different CNAME files (nacpickleball.com vs
# uat.nacpickleball.com), because that file is how GitHub Pages decides
# which domain a repo answers on. A plain "git merge uat" rewrites
# production's CNAME to the UAT domain and takes nacpickleball.com down --
# and a .gitattributes merge driver does NOT prevent this, because the
# driver only runs when both sides changed the file. Here only UAT has,
# so git takes UAT's copy without ever consulting the driver.
#
# So CNAME is restored explicitly, after the merge and before the commit.
#
# Usage:  ./promote.sh ["commit message"]

set -euo pipefail

PROD_DOMAIN="nacpickleball.com"
MSG="${1:-Promote UAT to production}"

cd "$(dirname "$0")"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Working tree has uncommitted changes. Commit or stash first." >&2
  exit 1
fi

git fetch uat
git checkout main
git pull --ff-only origin main

# --no-ff --no-commit so we always get a merge commit we can amend CNAME into,
# even when the history would otherwise fast-forward (the case that bites).
set +e
git merge --no-ff --no-commit uat/main
merge_status=$?
set -e

# Restore production's domain from the pre-merge tip, whatever the merge did.
git checkout HEAD -- CNAME 2>/dev/null || printf '%s\n' "$PROD_DOMAIN" > CNAME
git add CNAME

# CNAME is handled; any other conflict needs a human.
remaining=$(git diff --name-only --diff-filter=U)
if [ -n "$remaining" ]; then
  echo "Merge conflicts need resolving before promoting:" >&2
  echo "$remaining" >&2
  echo "Fix them, 'git add' each, then: git commit && git push origin main" >&2
  exit 1
fi

if [ "$merge_status" -ne 0 ] && [ -z "$(git diff --cached --name-only)" ]; then
  echo "Merge failed and produced nothing to commit." >&2
  exit 1
fi

git commit -m "$MSG"

actual=$(cat CNAME)
if [ "$actual" != "$PROD_DOMAIN" ]; then
  echo "REFUSING TO PUSH: CNAME is '$actual', expected '$PROD_DOMAIN'." >&2
  echo "Run: git reset --hard origin/main" >&2
  exit 1
fi

echo
echo "Merged UAT into main. CNAME still $PROD_DOMAIN."
echo "Review with 'git show --stat HEAD', then: git push origin main"
