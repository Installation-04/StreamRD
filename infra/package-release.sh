#!/usr/bin/env bash
# Build documentation assets locally; this script never pushes or publishes.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
output="${1:?Usage: package-release.sh /absolute/output-directory [vMAJOR.MINOR.PATCH]}"
tag="${2:-v$(node -p 'require("./server/package.json").version')}"
[[ "$output" = /* ]] || { echo 'Output directory must be absolute' >&2; exit 1; }
RELEASE_TAG="$tag" node <<'JS'
const fs = require('node:fs');
const tag = process.env.RELEASE_TAG;
if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw Error('Use a stable vMAJOR.MINOR.PATCH tag');
for (const directory of ['server','web','phosphor/server','phosphor/web']) {
  const pkg = JSON.parse(fs.readFileSync(`${directory}/package.json`));
  const lock = JSON.parse(fs.readFileSync(`${directory}/package-lock.json`));
  if (`v${pkg.version}` !== tag || lock.version !== pkg.version || lock.packages[''].version !== pkg.version) throw Error(`Version mismatch: ${directory}`);
}
if (!fs.statSync(`docs/releases/${tag}.md`).isFile()) throw Error('Missing reviewed release notes');
JS
mkdir -p "$output"
for file in "$output/streamrd-${tag}-screenshots.zip" "$output/streamrd-${tag}-wiki.zip" "$output/SHA256SUMS"; do
  [[ ! -e "$file" ]] || { echo 'Use a new output directory; existing assets are never replaced' >&2; exit 1; }
done
zip -q -r "$output/streamrd-${tag}-screenshots.zip" docs/screenshots
zip -q -r "$output/streamrd-${tag}-wiki.zip" docs/wiki
(cd "$output" && sha256sum "streamrd-${tag}-screenshots.zip" "streamrd-${tag}-wiki.zip" > SHA256SUMS)
echo "Version-checked release assets: $output"
