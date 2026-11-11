#!/usr/bin/env bash
# Merge upstream (marcellourbani/vscode_abap_remote_fs) into the current branch and verify the
# headless MCP server still builds, passes its tests and serves the upstream tools.
#
# Exit codes: 0 merged and verified (or already up to date), 2 merge conflict outside the files
# this fork owns, 3 verification failed. On failure the working tree holds the failed state.
#
# Writes key=value lines to $GITHUB_OUTPUT when set (changed, upstream_sha, tools).
set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/marcellourbani/vscode_abap_remote_fs.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-master}"
OUT="${GITHUB_OUTPUT:-/dev/null}"
root="$(git rev-parse --show-toplevel)"
cd "$root"

say() { printf '\n== %s\n' "$*"; }

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"
git fetch --quiet upstream "$UPSTREAM_BRANCH"
upstream_sha="$(git rev-parse "upstream/$UPSTREAM_BRANCH")"
echo "upstream_sha=$upstream_sha" >>"$OUT"

if git merge-base --is-ancestor "$upstream_sha" HEAD && [ "${FORCE_VERIFY:-}" != "1" ]; then
  say "Already contains upstream $upstream_sha"
  echo "changed=false" >>"$OUT"
  exit 0
fi

if ! git merge-base --is-ancestor "$upstream_sha" HEAD; then
  say "Merging upstream/$UPSTREAM_BRANCH ($upstream_sha)"
  if ! git merge --no-edit --no-ff "upstream/$UPSTREAM_BRANCH" -m "Merge upstream $UPSTREAM_BRANCH ${upstream_sha:0:9}"; then
    conflicts="$(git diff --name-only --diff-filter=U)"
    echo "Conflicts: $conflicts"
    for f in $conflicts; do
      case "$f" in
        pnpm-lock.yaml)
          # regenerated below from upstream's lock plus our package
          git checkout --theirs pnpm-lock.yaml ;;
        pnpm-workspace.yaml)
          git checkout --theirs pnpm-workspace.yaml ;;
        *)
          echo "Unresolvable conflict in $f"
          git merge --abort
          exit 2 ;;
      esac
    done
  fi
fi

# the fork's only change to upstream files: register the headless package in the workspace
if ! grep -qE '^\s*-\s*headless\s*$' pnpm-workspace.yaml; then
  node -e '
    const fs = require("fs"); const p = "pnpm-workspace.yaml"; let s = fs.readFileSync(p, "utf8");
    s = s.replace(/^packages:\n/m, "packages:\n  - headless\n"); fs.writeFileSync(p, s)'
fi

say "Installing dependencies"
pnpm install --ignore-scripts --no-frozen-lockfile

if [ -n "$(git diff --name-only --diff-filter=U)" ] || ! git diff --quiet || ! git diff --cached --quiet; then
  git add pnpm-lock.yaml pnpm-workspace.yaml
  if [ -f .git/MERGE_HEAD ]; then
    git commit --no-edit -m "Merge upstream $UPSTREAM_BRANCH ${upstream_sha:0:9} (lockfile regenerated)"
  elif ! git diff --cached --quiet; then
    git commit -m "Refresh lockfile after upstream ${upstream_sha:0:9}"
  fi
fi

# each step must succeed; `&&` because `set -e` does not apply inside a function used in `if`
verify() {
  say "Typecheck" && pnpm --filter abapfs-headless typecheck &&
    say "Unit tests" && pnpm --filter abapfs-headless test &&
    say "Build" && pnpm --filter abapfs-headless build &&
    say "MCP smoke test" &&
    (cd headless && node scripts/smoke.mjs --min-tools "${MIN_TOOLS:-40}" >/tmp/abapfs-smoke.json; rc=$?; cat /tmp/abapfs-smoke.json; exit $rc)
}
if ! verify; then
  say "Verification FAILED"
  echo "changed=true" >>"$OUT"
  exit 3
fi

tools="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/abapfs-smoke.json","utf8")).tools)')"
echo "tools=$tools" >>"$OUT"
echo "changed=true" >>"$OUT"
say "OK: upstream ${upstream_sha:0:9} merged, $tools MCP tools"
