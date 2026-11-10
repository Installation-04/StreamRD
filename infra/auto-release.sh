#!/usr/bin/env bash
# Tags and publishes a release when the packages carry a version that has no tag yet and every check on the
# commit has passed. Run by .github/workflows/auto-release.yml; the logic lives here so it can be tested.
#
# Inputs (environment): RELEASE_SHA (commit to release), GITHUB_REPOSITORY, GH_TOKEN (for gh),
#   RELEASE_MODE=auto|manual (manual turns "not ready" outcomes into failures), DRY_RUN=true (report only),
#   SELF_CHECK_NAME (this job's own check run, ignored when looking at the commit's checks),
#   MIN_CHECKS (fewest check runs that must have reported, default 5), RELEASE_ROOT (repository root, for tests).
set -euo pipefail
root="${RELEASE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
sha="${RELEASE_SHA:?RELEASE_SHA is required}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
mode="${RELEASE_MODE:-auto}"
dry="${DRY_RUN:-false}"
self="${SELF_CHECK_NAME:-Tag and publish release}"
min_checks="${MIN_CHECKS:-5}"

say() { echo "$*"; if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$*" >> "$GITHUB_STEP_SUMMARY"; fi; }
fail() { echo "::error::$1"; if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "**Failed:** $1" >> "$GITHUB_STEP_SUMMARY"; fi; exit 1; }
# Not releasing right now: a normal outcome for an automatic run, an error for someone who asked for a release.
not_now() { if [ "$mode" = manual ]; then fail "$1"; fi; say "Not releasing: $1"; exit 0; }

version="$(node -p 'require(process.argv[1]).version' "$root/server/package.json")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "server/package.json has version '$version', which is not MAJOR.MINOR.PATCH."
for dir in web phosphor/server phosphor/web; do
  other="$(node -p 'require(process.argv[1]).version' "$root/$dir/package.json")"
  [ "$other" = "$version" ] || fail "$dir is at $other but server is at $version; the four packages share one version."
done
tag="v$version"

if gh api "repos/$repo/git/ref/tags/$tag" > /dev/null 2>&1; then
  say "$tag already exists, so there is nothing new to release."
  exit 0
fi
[ -f "$root/docs/releases/$tag.md" ] || fail "The packages are at $version but docs/releases/$tag.md does not exist. Write the release notes, then run this again."

checks="$(gh api --paginate "repos/$repo/commits/$sha/check-runs?per_page=100" --jq '.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv')"
total=0 pending=0 bad=0 badnames=""
while IFS=$'\t' read -r name status conclusion; do
  [ -n "$name" ] || continue
  [ "$name" != "$self" ] || continue
  total=$((total + 1))
  if [ "$status" != completed ]; then pending=$((pending + 1)); continue; fi
  case "$conclusion" in success | skipped | neutral) ;; *) bad=$((bad + 1)); badnames="$badnames$name ($conclusion); " ;; esac
done <<< "$checks"
[ "$bad" -eq 0 ] || not_now "checks failed on ${sha:0:7}: $badnames"
[ "$pending" -eq 0 ] || not_now "$pending of $total checks are still running on ${sha:0:7}; the last workflow to finish will try again."
[ "$total" -ge "$min_checks" ] || not_now "only $total checks have reported on ${sha:0:7} (expected at least $min_checks)."

if [ "$dry" = true ]; then
  say "Dry run: would tag $tag at ${sha:0:7}, then start the Release and Publish image workflows for it. All $total checks passed."
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git tag -a "$tag" -m "StreamRD and Phosphor $tag" "$sha"
git push origin "refs/tags/$tag"
# A tag pushed with the workflow token does not start other workflows, so start them for the tag explicitly.
if ! { gh workflow run release.yml --ref "$tag" && gh workflow run publish-image.yml --ref "$tag"; }; then
  fail "Tagged $tag, but starting its workflows failed. Run 'Release' and 'Publish image' from the Actions tab, choosing the tag $tag."
fi
say "Tagged **$tag** at ${sha:0:7} and started the Release and Publish image workflows: https://github.com/$repo/actions"
