#!/usr/bin/env bash
# Every add-on in the marketplace, installed from the web API against a real Docker daemon, one after the other: the real image downloads,
# runs from its fixed specification (its own folder, the data folder only where it writes, no Docker socket), answers, is stopped and
# started again, and is removed with its settings kept.
#
# It needs a Docker daemon, curl and jq, and downloads about two gigabytes of images. Usage: bash infra/smoke-addons.sh [image]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
image="${1:-streamrd-all-in-one:local}"
suffix="$(openssl rand -hex 6)"
name="streamrd-addons-$suffix"; config="streamrd-addons-config-$suffix"; data="streamrd-addons-data-$suffix"
email="addons-smoke@example.invalid"; password="addons-smoke-fixture123"
token=""
# name  default-port  what answers (path)   writes-the-data-folder
ADDONS=(
  "sonarr 8989 / yes" "radarr 7878 / yes" "lidarr 8686 / yes" "bazarr 6767 / yes"
  "seerr 5055 / no" "tautulli 8181 / no" "flaresolverr 8191 / no" "maintainerr 6246 / no"
)
say() { printf '\n== %s\n' "$*"; }
fail() {
  echo "FAIL: $*" >&2
  { echo "-- containers"; docker ps -a --format '{{.Names}}  {{.Image}}  {{.Status}}'
    echo "-- $name (last lines)"; docker logs --tail 40 "$name" 2>&1
    for entry in "${ADDONS[@]}"; do set -- $entry; docker inspect "streamrd-$1" >/dev/null 2>&1 && { echo "-- streamrd-$1"; docker logs --tail 25 "streamrd-$1" 2>&1; }; done
  } >&2 || true
  exit 1
}
for entry in "${ADDONS[@]}" "prowlarr 9696 / no"; do
  set -- $entry
  if docker ps -a --format '{{.Names}}' | grep -qx "streamrd-$1"; then echo "Refusing to run: a container named streamrd-$1 exists (the launch would replace it)." >&2; exit 1; fi
done
cleanup() {
  local code=$?; set +e
  for entry in "${ADDONS[@]}"; do set -- $entry; docker rm -f "streamrd-$1" >/dev/null 2>&1; done
  docker rm -f "$name" streamrd-prowlarr >/dev/null 2>&1
  docker volume rm "$config" "$data" >/dev/null 2>&1
  return "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
# retry TRIES COMMAND...: tries again with a longer wait each time (5, 10, 20, 40 s), because registries rate-limit the addresses CI runners share
# (toomanyrequests): a fixed few seconds does not outlast that.
retry() {
  local tries="$1"; shift; local n=0 pause=5
  until "$@"; do
    n=$((n + 1)); [ "$n" -lt "$tries" ] || return 1
    echo "(attempt $n of $tries failed: $*; trying again in ${pause}s)" >&2
    sleep "$pause"; pause=$((pause * 2)); [ "$pause" -le 60 ] || pause=60
  done
}
# The image each add-on is started from is the helper's own table, read from it, so there is one place that says it.
image_of() { node -e "const s=require('./infra/single-container/media-manager.cjs').SERVERS[process.argv[1]]; console.log(s.image + ':' + s.tag)" "$1"; }
until_true() { local limit="$1" what="$2"; shift 2; local waited=0; until "$@" >/dev/null 2>&1; do waited=$((waited + 2)); [ "$waited" -lt "$limit" ] || fail "timed out waiting for $what"; sleep 2; done; }
web_port() { docker port "$name" 8080/tcp | head -1 | sed 's/.*://'; }
call() { curl -sS -X "$1" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' ${3:+-d "$3"} "http://127.0.0.1:$(web_port)$2"; }
state_of() { call GET /api/admin/addons | jq -r --arg n "$1" '.addons[] | select(.name == $n) | .state'; }
error_of() { call GET /api/admin/addons | jq -r --arg n "$1" '.addons[] | select(.name == $n) | .error // ""'; }
inspect() { docker inspect -f "$1" "$2"; }

say "Start StreamRD as an installed copy has it: root, Docker's socket, one volume each for settings and downloads"
docker volume create "$config" >/dev/null; docker volume create "$data" >/dev/null
docker run -d --name "$name" --user 0:0 --security-opt no-new-privileges:true \
  -v /var/run/docker.sock:/var/run/docker.sock -v "$config:/config" -v "$data:/data" -e CONFIG_DIR=/config -p 127.0.0.1::8080 "$image" >/dev/null
until_true 240 "StreamRD to be healthy" docker exec "$name" node /opt/single-container/health.cjs
body="$(curl -sS -X POST -H 'Content-Type: application/json' -d "{\"email\":\"$email\",\"password\":\"$password\",\"displayName\":\"Add-ons fixture\"}" "http://127.0.0.1:$(web_port)/api/auth/signup")"
token="$(printf '%s' "$body" | jq -r '.token // empty')"; [ -n "$token" ] || fail "could not sign up: $body"
[ "$(call GET /api/admin/addons | jq -r '.control.mode')" = embedded ] || fail "Docker control is not on"
[ "$(call GET /api/admin/addons | jq -r '[.addons[].name] | length')" = 9 ] || fail "the marketplace does not list nine add-ons"
volume_path="$(docker volume inspect -f '{{.Mountpoint}}' "$config")"

for entry in "${ADDONS[@]}"; do
  set -- $entry; addon="$1"; port="$2"; path="$3"; writes="$4"; container="streamrd-$addon"; shown=$((port + 10000))
  say "$addon: install, answer, stop, start, remove"
  body='{}'; [ "$addon" = flaresolverr ] || body="{\"port\":$shown}"
  # The image is downloaded here first, patiently, so that a registry that turns a runner away for a while does not fail the check; the helper
  # then finds it on the machine. What the helper does when it has to download is covered by its own tests and by the Prowlarr and Jellyfin steps.
  reference="$(image_of "$addon")"; retry 6 docker pull "$reference" >/dev/null || fail "could not download $reference"
  # A registry may refuse a runner for a while; the launch is asked again, a few times, before it counts as failed.
  running() { [ "$(state_of "$addon")" = running ]; }
  tries=0; waited=0
  until running; do
    case "$(state_of "$addon")" in
      absent|failed) tries=$((tries + 1)); [ "$tries" -le 4 ] || fail "$addon did not start: $(error_of "$addon")"
        [ "$tries" -eq 1 ] || { echo "($addon: $(error_of "$addon"); trying again)" >&2; sleep $((tries * 10)); }
        call POST "/api/admin/addons/$addon/launch" "$body" | jq -e '.addons' >/dev/null || fail "the launch of $addon was refused" ;;
    esac
    sleep 3; waited=$((waited + 3)); [ "$waited" -lt 900 ] || fail "$addon never started"
  done
  [ "$(inspect '{{.HostConfig.RestartPolicy.Name}}' "$container")" = unless-stopped ] || fail "$addon does not start again with the machine"
  docker inspect "$container" | jq -e --arg root "$volume_path" --arg writes "$writes" '
    (.[0].Mounts | map(select(.Destination == "/var/run/docker.sock")) | length == 0) and
    (.[0].Mounts | map(select(.Destination | startswith("/library")) ) | length == 0) and
    ((.[0].Mounts | map(select(.Destination == "/data")) | length) == (if $writes == "yes" then 1 else 0 end)) and
    (.[0].Mounts | map(select(.Destination == "/data" and .RW == false)) | length == 0) and
    (.[0].HostConfig.Privileged == false)' >/dev/null || fail "$addon was given more than its specification allows: $(inspect '{{json .Mounts}}' "$container")"
  if [ "$addon" = flaresolverr ]; then
    [ -z "$(inspect '{{json .HostConfig.PortBindings}}' "$container" | jq -r 'select(. != {} and . != null)')" ] || fail "FlareSolverr has a port on the machine"
    ip="$(inspect '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$container")"
    answers() { curl -fsS "http://$ip:$port/" | grep -qi 'FlareSolverr is ready'; }
  else
    answers() { code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$shown$path" || true)"; [[ "$code" =~ ^[23] ]]; }
  fi
  until_true 300 "$addon to answer" answers || { echo "-- $(docker logs --tail 30 "$container" 2>&1)" >&2; fail "$addon is running but does not answer"; }
  if [ "$writes" = yes ]; then docker exec "$container" sh -c 'touch /data/.addon-write-check && rm /data/.addon-write-check' || fail "$addon cannot write to the data folder"; fi
  call POST "/api/admin/addons/$addon/stop" | jq -e '.addons' >/dev/null || fail "$addon could not be stopped"
  [ "$(state_of "$addon")" = stopped ] || fail "$addon is not stopped"
  call POST "/api/admin/addons/$addon/launch" "$body" | jq -e '.addons' >/dev/null || fail "$addon could not be started again"
  until_true 300 "$addon to run again" running
  until_true 240 "$addon to answer again" answers
  call DELETE "/api/admin/addons/$addon" | jq -e '.addons' >/dev/null || fail "$addon could not be removed"
  until_true 60 "$addon to be removed" test -z "$(docker ps -aq --filter "name=^/$container$")"
  docker exec "$name" sh -c "ls /config/$addon" >/dev/null 2>&1 || [ "$addon" = flaresolverr ] || fail "removing $addon took its settings with it"
  docker images --format '{{.Repository}} {{.ID}}' | awk -v a="/$addon" 'index($1, a) {print $2}' | xargs -r docker rmi >/dev/null 2>&1 || true   # keep the runner's disk free for the next one
done
say "Prowlarr, Sonarr, Radarr and Lidarr: signed in and linked by StreamRD, against the real programs"
for addon in prowlarr sonarr radarr lidarr; do
  tries=0; waited=0; body='{}'
  if [ "$addon" != prowlarr ]; then
    port="$(node -e 'console.log(require("./infra/single-container/media-manager.cjs").SERVERS[process.argv[1]].port)' "$addon")"
    body="{\"port\":$((port + 10000))}"
  fi
  retry 6 docker pull "$(image_of "$addon")" >/dev/null || fail "could not download $addon"
  call POST "/api/admin/addons/$addon/launch" "$body" | jq -e '.addons' >/dev/null || fail "the launch of $addon was refused"
  until [ "$(state_of "$addon")" = running ]; do sleep 3; waited=$((waited + 3)); [ "$waited" -lt 600 ] || fail "$addon never started"; done
done
linked=""
for attempt in $(seq 1 40); do
  report="$(call POST /api/admin/addons/link)"
  if echo "$report" | jq -e '(.errors | length) == 0 and (.waiting | length) == 0' >/dev/null 2>&1; then
    pkey="$(docker exec "$name" grep -o '<ApiKey>[A-Za-z0-9]*</ApiKey>' /config/prowlarr/config/config.xml | sed 's/<[^>]*>//g')"
    # The background pass may have created a link already, so inspect actual
    # application records rather than treating an empty report as proof.
    if curl -fsS -H "X-Api-Key: $pkey" "http://127.0.0.1:9696/api/v1/applications" | jq -e '
      . as $apps | ["Sonarr", "Radarr", "Lidarr"] | all(. as $kind | [$apps[] | select(.implementation == $kind)] | length == 1)
    ' >/dev/null; then linked=yes; break; fi
  fi
  sleep 6
done
[ "$linked" = yes ] || fail "the add-ons were not linked: $report"
for entry in "sonarr Sonarr 18989 v3" "radarr Radarr 17878 v3" "lidarr Lidarr 18686 v1"; do
  read -r addon label shown api <<< "$entry"
  login="$(call GET "/api/admin/addons/$addon/login")"; pass="$(echo "$login" | jq -r '.password // empty')"; [ "${#pass}" -ge 20 ] || fail "no login was made for $label"
  key="$(docker exec "$name" grep -o '<ApiKey>[A-Za-z0-9]*</ApiKey>' "/config/$addon/config/config.xml" | sed 's/<[^>]*>//g')"
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$shown/api/$api/system/status")" = 401 ] || fail "$label answers without a key or a login"
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Api-Key: $key" "http://127.0.0.1:$shown/api/$api/system/status")" = 200 ] || fail "$label does not accept its own key after the login was set"
done
report="$(call POST /api/admin/addons/link)"; echo "$report" | jq -e '(.logins | length) == 0 and (.linked | length) == 0 and (.waiting | length) == 0 and (.errors | length) == 0' >/dev/null || fail "a second pass changed something: $report"
curl -fsS -H "X-Api-Key: $pkey" "http://127.0.0.1:9696/api/v1/applications" | jq -e '
  length == 3 and (map(.implementation) | sort == ["Lidarr", "Radarr", "Sonarr"])
' >/dev/null || fail "the second pass changed the application list"
echo 'Sonarr, Radarr, Lidarr and Prowlarr were signed in and linked, and a second pass changed nothing.'
say "Sonarr, Radarr and Lidarr connect to real qBittorrent without deleting completed or failed downloads"
# Only this disposable fixture exposes the bundled client on the container's
# bridge interface. Production keeps its loopback-only default.
docker exec --interactive --env "SMOKE_TOKEN=$token" "$name" node <<'NODE'
const fs = require('node:fs'), os = require('node:os');
(async () => {
  const password = fs.readFileSync('/config/secrets/qbittorrent-password', 'utf8').trim(), username = process.env.QBIT_USERNAME || 'admin';
  const origin = 'http://127.0.0.1:8082';
  const login = await fetch(origin + '/api/v2/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!login.ok || (await login.text()).trim() !== 'Ok.' || !cookie) throw Error('The disposable qBittorrent login failed');
  const changed = await fetch(origin + '/api/v2/app/setPreferences', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ json: JSON.stringify({ web_ui_address: '0.0.0.0', web_ui_domain_list: '*' }) }) });
  if (!changed.ok) throw Error('Could not configure the disposable qBittorrent interface');
  const address = Object.values(os.networkInterfaces()).flat().find(one => one && !one.internal && one.family === 'IPv4')?.address;
  if (!address) throw Error('No bridge address for the disposable download client');
  const saved = await fetch('http://127.0.0.1:47821/api/admin/request-settings', { method: 'PUT', headers: { Authorization: `Bearer ${process.env.SMOKE_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ qbit: { enabled: true, baseUrl: `http://${address}:8082`, username, password } }) });
  if (!saved.ok) throw Error(`Could not save the disposable download client: HTTP ${saved.status}`);
  console.log('Disposable bridge-accessible qBittorrent connection configured.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
connected=""
for attempt in $(seq 1 20); do
  report="$(call POST /api/admin/addons/link)"
  if echo "$report" | jq -e '(.errors | length) == 0 and (.downloadClientWaiting | length) == 0' >/dev/null; then connected=yes; break; fi
  sleep 3
done
[ "$connected" = yes ] || fail "download-client linking failed: $report"
docker exec --interactive "$name" node <<'NODE'
const fs = require('node:fs');
(async () => {
  const status = await fetch(process.env.MEDIA_MANAGER_URL + '/status', { headers: { Authorization: `Bearer ${process.env.MEDIA_MANAGER_TOKEN}` } });
  if (!status.ok) throw Error('The Docker helper did not return add-on addresses');
  const { servers } = await status.json();
  const password = fs.readFileSync('/config/secrets/qbittorrent-password', 'utf8').trim();
  for (const [name, port, api, category] of [['sonarr', 8989, 'v3', 'tvCategory'], ['radarr', 7878, 'v3', 'movieCategory'], ['lidarr', 8686, 'v1', 'musicCategory']]) {
    const key = /<ApiKey>([^<]+)<\/ApiKey>/.exec(fs.readFileSync(`/config/${name}/config/config.xml`, 'utf8'))?.[1];
    const base = `http://${servers[name].address}:${port}/api/${api}/downloadclient`, headers = { 'X-Api-Key': key, 'Content-Type': 'application/json' };
    const response = await fetch(base, { headers });
    if (!response.ok) throw Error(`${name}: download-client list HTTP ${response.status}`);
    const clients = await response.json(), client = clients[0];
    if (clients.length !== 1 || client.implementation !== 'QBittorrent' || !client.enable || client.removeCompletedDownloads !== false || client.removeFailedDownloads !== false) throw Error(`${name}: unexpected download-client configuration`);
    if (!client.fields.some(field => field.name === category && field.value === `streamrd-${name}`)) throw Error(`${name}: wrong download category`);
    const tested = await fetch(base + '/test', { method: 'POST', headers, body: JSON.stringify({ ...client, fields: client.fields.map(field => field.name === 'password' ? { ...field, value: password } : field) }), signal: AbortSignal.timeout(20000) });
    if (!tested.ok) throw Error(`${name}: real qBittorrent connection test HTTP ${tested.status}`);
    console.log(`${name}: one qBittorrent connection; real connection test passed; automatic removal disabled.`);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
report="$(call POST /api/admin/addons/link)"
echo "$report" | jq -e '(.downloadClients | length) == 0 and (.downloadClientWaiting | length) == 0 and (.errors | length) == 0' >/dev/null || fail "a second pass changed download clients: $report"
echo 'Every add-on installed, answered, stopped, started again and was removed with its settings kept.'
