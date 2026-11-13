#!/usr/bin/env bash
# Disposable named-bridge installation: owner opt-in, actual restarts, a real
# Sonarr connection test, and closure after opt-out. No torrents are added.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
image="${1:-streamrd-all-in-one:local}"
suffix="$(openssl rand -hex 6)"
name="streamrd-bundled-$suffix"; network="$name-network"; config="$name-config"; data="$name-data"; token=""
# The helper owns fixed add-on names. Refuse to touch another installation.
for addon in sonarr radarr lidarr prowlarr bazarr seerr tautulli flaresolverr maintainerr; do
  if docker container inspect "streamrd-$addon" >/dev/null 2>&1; then echo "Refusing to replace existing streamrd-$addon" >&2; exit 1; fi
done
cleanup() {
  local result=$?; set +e
  docker rm -f "$name" streamrd-sonarr streamrd-prowlarr >/dev/null 2>&1
  docker network rm "$network" >/dev/null 2>&1
  docker volume rm "$config" "$data" >/dev/null 2>&1
  return "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
fail() { echo "FAIL: $*" >&2; docker logs --tail 40 "$name" >&2 || true; exit 1; }
wait_for() { local tries="$1"; shift; for ((i=0; i<tries; i++)); do if "$@" >/dev/null 2>&1; then return; fi; sleep 2; done; fail "timed out: $*"; }
port() { docker port "$name" 8080/tcp | head -1 | sed 's/.*://'; }
call() { curl --fail-with-body -sS -X "$1" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' ${3:+-d "$3"} "http://127.0.0.1:$(port)$2"; }
settings() { call GET /api/admin/request-settings; }
healthy() { docker exec "$name" node /opt/single-container/health.cjs; }
restart() {
  local started; started="$(docker inspect -f '{{.State.StartedAt}}' "$name")"
  call POST /api/admin/system/restart '{}' | jq -e '.restarting' >/dev/null || fail 'restart refused'
  changed() { [ "$(docker inspect -f '{{.State.StartedAt}}' "$name")" != "$started" ]; }
  wait_for 60 changed; wait_for 120 healthy
}
peer_status() { docker exec streamrd-sonarr curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --connect-timeout 3 "http://$name:8082/api/v2/app/version" || true; }
closed() { [ "$(peer_status)" = 000 ]; }
protected() { [ "$(peer_status)" = 403 ] || [ "$(peer_status)" = 401 ]; }

docker network create --driver bridge "$network" >/dev/null
docker volume create "$config" >/dev/null; docker volume create "$data" >/dev/null
docker run -d --name "$name" --network "$network" --user 0:0 --security-opt no-new-privileges:true \
  -v /var/run/docker.sock:/var/run/docker.sock -v "$config:/config" -v "$data:/data" -e CONFIG_DIR=/config -p 127.0.0.1::8080 "$image" >/dev/null
wait_for 120 healthy
body="$(curl --fail-with-body -sS -X POST -H 'Content-Type: application/json' -d '{"email":"bundled-smoke@fixture.invalid","password":"bundled-fixture-password123","displayName":"Bundled fixture"}' "http://127.0.0.1:$(port)/api/auth/signup")"
token="$(printf '%s' "$body" | jq -r '.token // empty')"; [ -n "$token" ] || fail 'signup failed'
settings | jq -e '.settings.qbit | .bundledAvailable and (.bundledAccessActive == false) and (.allowBundledAccess == false)' >/dev/null || fail 'incorrect initial policy'
# Credentials stay inside the disposable container and never enter shell output.
docker exec -i --env "SMOKE_TOKEN=$token" "$name" node <<'NODE'
(async () => {
  const password = require('node:fs').readFileSync('/config/secrets/qbittorrent-password', 'utf8').trim();
  const response = await fetch('http://127.0.0.1:47821/api/admin/request-settings', { method: 'PUT', headers: { Authorization: `Bearer ${process.env.SMOKE_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ qbit: { enabled: true, baseUrl: 'http://127.0.0.1:8082', username: 'admin', password, shareWithAddons: true } }) });
  if (!response.ok) throw Error(`Fixture settings HTTP ${response.status}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
call POST /api/admin/addons/sonarr/launch '{"port":18989}' | jq -e '.addons' >/dev/null
running() { call GET /api/admin/addons | jq -e '.addons[] | select(.name == "sonarr" and .state == "running")'; }
wait_for 240 running
wait_for 30 closed
call PUT /api/admin/request-settings '{"qbit":{"allowBundledAccess":true}}' | jq -e '.settings.qbit | .allowBundledAccess and (.bundledAccessActive == false) and .bundledRestartRequired' >/dev/null || fail 'approval did not request restart'
closed || fail 'listener opened before restart'
restart
settings | jq -e '.settings.qbit | .bundledAccessActive and (.bundledRestartRequired == false)' >/dev/null || fail 'restart did not apply approval'
wait_for 30 protected
# Wait for Sonarr's first-run API and StreamRD's generated authentication.
linked() { call POST /api/admin/addons/link | jq -e '(.errors | length) == 0 and (.downloadClientWaiting | length) == 0 and (.waiting | index("sonarr") == null)'; }
wait_for 90 linked
verify_client() {
  docker exec -i --env "SMOKE_HOST=$name" "$name" node <<'NODE'
const fs = require('node:fs');
(async () => {
  const key = /<ApiKey>([^<]+)<\/ApiKey>/.exec(fs.readFileSync('/config/sonarr/config/config.xml', 'utf8'))?.[1];
  const password = fs.readFileSync('/config/secrets/qbittorrent-password', 'utf8').trim();
  const base = 'http://streamrd-sonarr:8989/api/v3/downloadclient', headers = { 'X-Api-Key': key, 'Content-Type': 'application/json' };
  const response = await fetch(base, { headers });
  if (!response.ok) throw Error(`Sonarr clients HTTP ${response.status}`);
  const clients = await response.json(), client = clients[0];
  if (clients.length !== 1 || !client.enable || client.implementation !== 'QBittorrent' || client.removeCompletedDownloads !== false || client.removeFailedDownloads !== false) throw Error('Unexpected client configuration');
  const fields = Object.fromEntries(client.fields.map(field => [field.name, field.value]));
  if (fields.host !== process.env.SMOKE_HOST || fields.port !== 8082 || fields.tvCategory !== 'streamrd-sonarr') throw Error('Client did not use stable bundled DNS and category');
  const tested = await fetch(base + '/test', { method: 'POST', headers, body: JSON.stringify({ ...client, fields: client.fields.map(field => field.name === 'password' ? { ...field, value: password } : field) }), signal: AbortSignal.timeout(20000) });
  if (!tested.ok) throw Error(`Real Sonarr connection test HTTP ${tested.status}`);
  console.log('Real Sonarr test passed using stable container DNS; automatic removal disabled.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
}
verify_client
# A further restart must keep the same connection usable.
restart; wait_for 30 protected; verify_client
call PUT /api/admin/request-settings '{"qbit":{"allowBundledAccess":false}}' | jq -e '.settings.qbit | (.allowBundledAccess == false) and .bundledAccessActive and .bundledRestartRequired' >/dev/null || fail 'withdrawal did not request restart'
protected || fail 'listener closed before requested restart'
restart; wait_for 30 closed
settings | jq -e '.settings.qbit | (.bundledAccessActive == false) and (.bundledRestartRequired == false)' >/dev/null || fail 'listener remained active after withdrawal'
call POST /api/admin/request-settings/test '{}' | jq -e '.ok' >/dev/null || fail 'local owner connection stopped working'
docker inspect "$name" | jq -e '.[0].HostConfig.PortBindings | has("8082/tcp") | not' >/dev/null || fail 'Web UI port was published'
echo 'Bundled access stayed local by default, opened only after owner approval and restart, survived restart, and closed after withdrawal and restart. Local authenticated requests still work.'
