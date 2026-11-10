#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
image="${1:-streamrd-all-in-one:local}"
suffix="$(openssl rand -hex 8)"
volume="streamrd-single-smoke-$suffix"
config_volume="streamrd-single-config-$suffix"
layout="${2:-split}" # split = /config + /data (default); legacy = the original single /data volume
container="streamrd-single-smoke-$suffix"
created=false config_created=false
cleanup(){ local code=$?; set +e; docker rm -f "$container" >/dev/null 2>&1; if [ "$created" = true ]; then docker volume rm "$volume" >/dev/null 2>&1; fi; if [ "$config_created" = true ]; then docker volume rm "$config_volume" >/dev/null 2>&1; fi; return "$code"; }
trap cleanup EXIT
trap 'exit 130' INT TERM
docker volume inspect "$volume" >/dev/null 2>&1 && { echo 'Refusing an existing smoke volume'; exit 1; }
docker volume create "$volume" >/dev/null; created=true
mounts=(--mount "type=volume,src=$volume,dst=/data")
if [ "$layout" = split ]; then
  docker volume create "$config_volume" >/dev/null; config_created=true
  mounts+=(--mount "type=volume,src=$config_volume,dst=/config" -e CONFIG_DIR=/config)
fi
docker run --pull=never -d -p 127.0.0.1::8080 -p 127.0.0.1::8081 --name "$container" "${mounts[@]}" "$image" >/dev/null
ready(){ for attempt in $(seq 1 120); do if docker exec "$container" node /opt/single-container/health.cjs >/dev/null 2>&1; then return; fi; if [ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]; then break; fi; sleep 1; done; echo 'Single-container readiness failed'; docker logs "$container"; return 1; }
ready
docker exec -i "$container" node < infra/single-container/smoke.cjs
if [ "${QA_SINGLE_BROWSER:-0}" = 1 ]; then
  mapping="$(docker port "$container" 8080/tcp)"; export QA_SINGLE_STREAMRD_PORT="${mapping##*:}"
  mapping="$(docker port "$container" 8081/tcp)"; export QA_SINGLE_PHOSPHOR_PORT="${mapping##*:}"
  node qa/single-container.cjs
fi
docker restart --time 20 "$container" >/dev/null
ready
docker exec -i -e SMOKE_RESTART=1 "$container" node < infra/single-container/smoke.cjs
docker exec -i "$container" node <<'NODE'
const fs=require('node:fs');let found=false;
for(const name of fs.readdirSync('/proc').filter(name=>/^\d+$/.test(name))){try{if(fs.readlinkSync(`/proc/${name}/cwd`)==='/opt/streamrd/web'){process.kill(Number(name),'SIGTERM');found=true;break;}}catch{}}
if(!found)process.exitCode=1;
NODE
[ "$(docker wait "$container")" = 1 ]
docker start "$container" >/dev/null
ready
docker exec -i -e SMOKE_RESTART=1 "$container" node < infra/single-container/smoke.cjs
echo 'An essential service failure stopped the container; recovery preserved data.'
docker stop --time 20 "$container" >/dev/null
[ "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = 0 ]
echo 'Graceful single-container shutdown passed.'
