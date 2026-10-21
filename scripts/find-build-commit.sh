#!/usr/bin/env bash
# Map a deployment's build source digest back to the commit it was built from
# (issue #827).
#
# GET /health reports build.sourceDigest. When build.commit is "unknown" —
# which happens when the image was built by a builder that had no git metadata
# to inject — this script recovers the commit by recomputing the digest for
# each candidate commit and comparing.
#
# Usage:
#   scripts/find-build-commit.sh <digest> [rev-range]
#
# Examples:
#   scripts/find-build-commit.sh 11cb8d5651d972cc
#   scripts/find-build-commit.sh 11cb8d5651d972cc v1.5.0..origin/main
#
# The default range is the last 300 commits of the current branch, which covers
# the realistic "which build is this stack on" question without walking the
# whole history. Widen it if the digest is older than that.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <digest> [rev-range]" >&2
  exit 2
fi

TARGET="$1"
RANGE="${2:-HEAD~300..HEAD}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# `git archive` materialises the tree of a commit without touching the working
# copy or HEAD — no checkout, so this is safe to run on a dirty tree.
while read -r commit; do
  rm -rf "$TMP/tree"
  mkdir -p "$TMP/tree"
  git archive "$commit" | tar -x -C "$TMP/tree"
  digest="$(node "$SCRIPT_DIR/source-digest.mjs" "$TMP/tree")"
  if [ "$digest" = "$TARGET" ]; then
    echo "$commit"
    git --no-pager log -1 --format='  %h %ad %an  %s' --date=short "$commit"
    exit 0
  fi
done < <(git rev-list "$RANGE")

echo "No commit in '$RANGE' produces digest $TARGET." >&2
echo "Try a wider range, e.g. $0 $TARGET \$(git rev-list --max-parents=0 HEAD)..HEAD" >&2
exit 1
