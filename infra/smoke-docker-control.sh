#!/usr/bin/env bash
# Docker control against a real Docker daemon: the helper inside the StreamRD container, as an installed copy has it.
#
#   - the container starts as root with Docker's socket; the helper is the only root process that matters and StreamRD runs as user 1000,
#     who cannot open the socket;
#   - Jellyfin is launched from the web API: the real image, mounted from where the volumes really are, reachable, restarting with the
#     machine unless told otherwise, with a deploy log;
#   - the server is restarted from the web API and comes back with its data, the media server untouched;
#   - an update that does not become healthy is rolled back (the old container is running again, nothing lost), and one that does is
#     applied: a new container from the new image, with the same settings, the helper in it, the updater removed, the outcome in the log.
#
# It needs a Docker daemon, curl and jq. It starts a local registry (registry:2) so an update has a newer image to pull, and it
# removes everything it made. Usage: bash infra/smoke-docker-control.sh [image]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
image="${1:-streamrd-all-in-one:local}"
suffix="$(openssl rand -hex 6)"
name="streamrd-control-$suffix"; registry="streamrd-registry-$suffix"
config="streamrd-control-config-$suffix"; data="streamrd-control-data-$suffix"
email="control-smoke@example.invalid"; password="control-smoke-fixture123"
media_port="${SMOKE_MEDIA_PORT:-18096}"
token=""
say() { printf '\n== %s\n' "$*"; }
fail() {
  echo "FAIL: $*" >&2
  { echo "-- containers"; docker ps -a --format '{{.Names}}  {{.Image}}  {{.Status}}'
    echo "-- $name (last lines)"; docker logs --tail 60 "$name" 2>&1
    for extra in "$name-updater" "$name-previous"; do docker inspect "$extra" >/dev/null 2>&1 && { echo "-- $extra"; docker logs --tail 40 "$extra" 2>&1; }; done
  } >&2 || true
  exit 1
}

for existing in streamrd-jellyfin streamrd-plex; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$existing"; then echo "Refusing to run: a container named $existing exists (the launch would replace it)." >&2; exit 1; fi
done
cleanup() {
  local code=$?; set +e
  docker rm -f "$name" "$name-previous" "$name-updater" streamrd-jellyfin "$registry" >/dev/null 2>&1
  docker volume rm "$config" "$data" >/dev/null 2>&1
  [ -z "${ref:-}" ] || docker rmi "$ref" >/dev/null 2>&1
  return "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

retry() { local tries="$1"; shift; local n=0; until "$@"; do n=$((n + 1)); [ "$n" -lt "$tries" ] || return 1; sleep 5; done; }
until_true() {   # until_true SECONDS DESCRIPTION COMMAND...
  local limit="$1" what="$2"; shift 2; local waited=0
  until "$@" >/dev/null 2>&1; do waited=$((waited + 2)); [ "$waited" -lt "$limit" ] || fail "timed out waiting for $what"; sleep 2; done
}
web_port() { docker port "$name" 8080/tcp | head -1 | sed 's/.*://'; }
call() {   # call METHOD PATH [JSON]
  curl -sS -X "$1" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' ${3:+-d "$3"} "http://127.0.0.1:$(web_port)$2"
}
signin() {
  local route="$1" body
  body="$(curl -sS -X POST -H 'Content-Type: application/json' -d "{\"email\":\"$email\",\"password\":\"$password\",\"displayName\":\"Control fixture\"}" "http://127.0.0.1:$(web_port)/api/auth/$route")"
  token="$(printf '%s' "$body" | jq -r '.token // empty')"; [ -n "$token" ] || fail "could not $route: $body"
}
healthy() { docker exec "$name" node /opt/single-container/health.cjs; }
helper() {   # helper METHOD PATH: asks the helper from inside the container, with the secret only StreamRD's API processes hold
  docker exec -i "$name" node - "$@" <<'NODE'
const fs = require('node:fs');
let token = '';
for (const pid of fs.readdirSync('/proc').filter(entry => /^\d+$/.test(entry))) {
  try {
    if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('dist/src/index.js')) continue;
    const found = /MEDIA_MANAGER_TOKEN=([0-9a-f]+)/.exec(fs.readFileSync(`/proc/${pid}/environ`, 'utf8')); if (found) { token = found[1]; break; }
  } catch { /* the process ended */ }
}
const [method, route] = process.argv.slice(2);
fetch(`http://127.0.0.1:8099${route}`, { method, headers: { Authorization: `Bearer ${token}` } }).then(async response => { console.log(await response.text()); process.exit(response.ok ? 0 : 1); }, error => { console.error(error.message); process.exit(1); });
NODE
}
processes() {
  docker exec -i "$name" node - <<'NODE'
const fs = require('node:fs'), out = [];
for (const pid of fs.readdirSync('/proc').filter(entry => /^\d+$/.test(entry))) {
  try { const uid = Number(/^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]); out.push({ pid: Number(pid), uid, cmd: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim() }); } catch { /* the process ended */ }
}
console.log(JSON.stringify(out.filter(entry => entry.pid !== process.pid)));
NODE
}
inspect() { docker inspect -f "$1" "$2"; }

say "A local registry, so an update has a newer image to pull"
retry 3 docker pull registry:2 >/dev/null || fail "could not pull registry:2"
docker run -d --name "$registry" -p 127.0.0.1::5000 registry:2 >/dev/null
registry_port="$(docker port "$registry" 5000/tcp | head -1 | sed 's/.*://')"
until_true 30 "the registry" curl -fsS "http://127.0.0.1:$registry_port/v2/"
ref="localhost:$registry_port/streamrd-control:latest"
docker tag "$image" "$ref"; docker push "$ref" >/dev/null
retry 3 docker pull jellyfin/jellyfin:latest >/dev/null || fail "could not pull jellyfin/jellyfin (the launch itself is tested below, with the image already here)"

say "Start the container as an installed copy has it: root, Docker's socket, one volume each for settings and downloads"
docker volume create "$config" >/dev/null; docker volume create "$data" >/dev/null
docker run -d --name "$name" --user 0:0 --security-opt no-new-privileges:true --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock -v "$config:/config" -v "$data:/data" -e CONFIG_DIR=/config -p 127.0.0.1::8080 "$ref" >/dev/null
until_true 240 "StreamRD to be healthy" healthy

say "Only the helper is root; StreamRD and everything it runs is user 1000, who cannot open Docker's socket"
list="$(processes)"
echo "$list" | jq -e '[.[] | select(.uid == 0) | .cmd] | all(test("tini|init.cjs|media-manager.cjs --embedded"))' >/dev/null || fail "an unexpected process runs as root: $(echo "$list" | jq -c '[.[] | select(.uid == 0)]')"
echo "$list" | jq -e '[.[] | select(.uid == 0) | .cmd] | any(test("media-manager.cjs --embedded"))' >/dev/null || fail "the helper is not running"
echo "$list" | jq -e '[.[] | select(.uid == 1000) | .cmd] | (any(test("dist/src/index.js")) and any(test("qbittorrent-nox")) and any(test("server.js|next-server")))' >/dev/null || fail "StreamRD's processes do not run as user 1000: $(echo "$list" | jq -c '[.[] | {uid, cmd}]')"
mode="$(docker exec "$name" stat -c %a /var/run/docker.sock)"
if [ "${mode: -1}" = 0 ]; then
  docker exec -u 1000 "$name" node -e "require('net').connect('/var/run/docker.sock').once('connect',()=>process.exit(1)).once('error',e=>process.exit(e.code==='EACCES'?0:2))" || fail "user 1000 can open Docker's socket"
else
  echo "Docker's socket is open to everyone on this machine ($mode); the separation cannot be checked here."
fi

say "StreamRD sees Docker control, and the page for it works"
signin signup
[ "$(call GET /api/admin/system/maintenance | jq -r '.control.mode + " " + (.restartSupported | tostring)')" = "embedded true" ] || fail "Docker control is not on"
[ "$(call GET /api/admin/media-servers | jq -r '.manager.available')" = true ] || fail "the helper does not answer"

say "Launch Jellyfin from the web API"
call POST /api/admin/media-servers/jellyfin/launch "{\"port\":$media_port}" | jq -e '.state' >/dev/null || fail "the launch was refused"
state() { call GET /api/admin/media-servers | jq -r '.servers.jellyfin.state'; }
waited=0; until [ "$(state)" = running ]; do
  [ "$(state)" != failed ] || fail "the launch failed: $(call GET /api/admin/media-servers | jq -c '.servers.jellyfin')"
  waited=$((waited + 2)); [ "$waited" -lt 240 ] || fail "Jellyfin never started"; sleep 2
done
volume_path="$(docker volume inspect -f '{{.Mountpoint}}' "$config")"
docker inspect "streamrd-jellyfin" | jq -e --arg root "$volume_path" '.[0].Mounts | (map(select(.Destination == "/config")) | .[0].Source == ($root + "/jellyfin/config")) and (map(select(.Destination == "/library/streamrd")) | .[0].Source == ($root + "/streamrd/library") and .[0].RW == false)' >/dev/null || fail "Jellyfin's folders are not where StreamRD's are: $(inspect '{{json .Mounts}}' streamrd-jellyfin)"
[ "$(inspect '{{.HostConfig.RestartPolicy.Name}}' streamrd-jellyfin)" = unless-stopped ] || fail "Jellyfin does not start again with the machine"
[ "$(docker exec "$name" stat -c %u /config/jellyfin/config)" = 1000 ] || fail "Jellyfin's folder is not owned by the server's user"
until_true 180 "Jellyfin to answer" curl -fsS "http://127.0.0.1:$media_port/health"
call GET /api/admin/media-servers/jellyfin/logs | jq -e --arg line "Started. It listens on port $media_port" '[.deploy[].message] | index($line) != null' >/dev/null || fail "the deploy log does not say it started"
call PUT /api/admin/media-servers/jellyfin/autostart '{"enabled":false}' >/dev/null
[ "$(inspect '{{.HostConfig.RestartPolicy.Name}}' streamrd-jellyfin)" = no ] || fail "switching auto-start off changed nothing"
call PUT /api/admin/media-servers/jellyfin/autostart '{"enabled":true}' >/dev/null
[ "$(inspect '{{.HostConfig.RestartPolicy.Name}}' streamrd-jellyfin)" = unless-stopped ] || fail "switching auto-start on changed nothing"

say "Restart from the web API: the server comes back with its data, the media server is untouched"
before="$(inspect '{{.State.StartedAt}}' "$name")"
[ "$(call POST /api/admin/system/restart | jq -r '.restarting')" = true ] || fail "the restart was refused"
restarted() { [ "$(inspect '{{.State.StartedAt}}' "$name")" != "$before" ]; }
until_true 120 "the container to restart" restarted
until_true 240 "StreamRD to be healthy again" healthy
signin login
[ "$(call GET /api/admin/system/maintenance | jq -r '.control.mode')" = embedded ] || fail "the helper is not back after a restart"
[ "$(inspect '{{.State.Running}}' streamrd-jellyfin)" = true ] || fail "the restart stopped Jellyfin"

say "An update that does not become healthy is rolled back"
original_image="$(inspect '{{.Image}}' "$name")"
printf 'FROM %s\nHEALTHCHECK --interval=2s --timeout=2s --start-period=1s --retries=1 CMD false\n' "$image" | docker build -q -t "$ref" - >/dev/null
docker push "$ref" >/dev/null
helper POST /update | jq -e '.state == "running"' >/dev/null || fail "the update was not accepted"
# While the container is being replaced nothing answers; only a finished state counts.
finished() { local now; now="$(helper GET /update 2>/dev/null | jq -r '.state' 2>/dev/null || true)"; [ "$now" = failed ] || [ "$now" = done ] || [ "$now" = current ]; }
until_true 360 "the update to finish" finished
view="$(helper GET /update)"
[ "$(echo "$view" | jq -r '.state')" = failed ] || fail "the broken update was not reported as failed: $view"
echo "$view" | jq -e '.error | test("previous version was restored")' >/dev/null || fail "the rollback was not explained: $view"
[ "$(inspect '{{.Image}}' "$name")" = "$original_image" ] || fail "the previous version is not the one running"
[ "$(inspect '{{.State.Running}}' "$name")" = true ] || fail "nothing runs after the rollback"
until_true 240 "StreamRD to be healthy after the rollback" healthy
signin login   # nothing was lost
no_updater() { [ -z "$(docker ps -aq --filter "name=$name-updater")" ]; }
until_true 60 "the failed updater to be removed" no_updater
[ -z "$(docker ps -aq --filter "name=$name-previous")" ] || fail "the old container was left behind"

say "An update that works is applied"
printf 'FROM %s\nLABEL streamrd.smoke.update=applied\n' "$image" | docker build -q -t "$ref" - >/dev/null
docker push "$ref" >/dev/null
new_image="$(docker image inspect -f '{{.Id}}' "$ref")"
helper POST /update | jq -e '.state == "running"' >/dev/null || fail "the update was not accepted"
has_new_image() { [ "$(inspect '{{.Image}}' "$name")" = "$new_image" ]; }
until_true 420 "the new container" has_new_image
until_true 300 "the new version to be healthy" healthy
[ "$(inspect '{{.Config.User}}' "$name")" = "0:0" ] || fail "the new container lost its user setting"
[ "$(inspect '{{.HostConfig.RestartPolicy.Name}}' "$name")" = unless-stopped ] || fail "the new container lost its restart policy"
inspect '{{json .Mounts}}' "$name" | jq -e 'map(.Destination) | (index("/config") != null and index("/data") != null and index("/var/run/docker.sock") != null)' >/dev/null || fail "the new container lost a mount"
signin login   # the data came with it
[ "$(call GET /api/admin/system/maintenance | jq -r '.control.mode')" = embedded ] || fail "the helper is not in the new container"
settled_view() { helper GET /update | jq -e '.state == "done"'; }
until_true 120 "the new helper to say the update is done" settled_view
until_true 120 "the updater to be removed" no_updater
[ -z "$(docker ps -aq --filter "name=$name-previous")" ] || fail "the old container was left behind"
logged() { call GET '/api/admin/logs?q=Update%20finished&limit=5' | jq -e '.logs | length > 0'; }
until_true 120 "the update to be in the log" logged
[ "$(inspect '{{.State.Running}}' streamrd-jellyfin)" = true ] || fail "the updates stopped Jellyfin"

say "Docker control passed against a real Docker daemon."
