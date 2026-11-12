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
cleanup(){ local code=$?; set +e; docker rm -f "$container" "$container-fresh" >/dev/null 2>&1; docker volume rm "$volume-fresh" "$config_volume-fresh" >/dev/null 2>&1; if [ "$created" = true ]; then docker volume rm "$volume" >/dev/null 2>&1; fi; if [ "$config_created" = true ]; then docker volume rm "$config_volume" >/dev/null 2>&1; fi; return "$code"; }
trap cleanup EXIT
trap 'exit 130' INT TERM
docker volume inspect "$volume" >/dev/null 2>&1 && { echo 'Refusing an existing smoke volume'; exit 1; }
docker volume create "$volume" >/dev/null; created=true
mounts=(--mount "type=volume,src=$volume,dst=/data")
if [ "$layout" = split ]; then
  docker volume create "$config_volume" >/dev/null; config_created=true
  mounts+=(--mount "type=volume,src=$config_volume,dst=/config" -e CONFIG_DIR=/config)
fi
docker run --pull=never -d -p 127.0.0.1::8080 -p 127.0.0.1::8081 --name "$container" "${mounts[@]}" -e ENABLE_PHOSPHOR=true "$image" >/dev/null
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

# Phosphor is off unless it is asked for, but a folder that already holds its data keeps it running.
phosphor_answers(){ docker exec "$1" node -e "fetch('http://127.0.0.1:8081/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; }
wait_ready(){ for attempt in $(seq 1 120); do if docker exec "$1" node /opt/single-container/health.cjs >/dev/null 2>&1; then return 0; fi; sleep 1; done; echo "$1 did not become ready"; docker logs "$1" 2>&1 | tail -30; return 1; }
docker rm "$container" >/dev/null
docker run --pull=never -d --name "$container" "${mounts[@]}" "$image" >/dev/null
wait_ready "$container"
phosphor_answers "$container" || { echo 'Phosphor stopped running on a folder that already had its data'; docker logs "$container" 2>&1 | tail -30; exit 1; }
docker rm -f "$container" >/dev/null
echo 'An installation that was already running Phosphor keeps it when nothing is set.'
docker volume create "$volume-fresh" >/dev/null; docker volume create "$config_volume-fresh" >/dev/null
fresh=(--mount "type=volume,src=$volume-fresh,dst=/data")
[ "$layout" != split ] || fresh+=(--mount "type=volume,src=$config_volume-fresh,dst=/config" -e CONFIG_DIR=/config)
docker run --pull=never -d --name "$container-fresh" "${fresh[@]}" "$image" >/dev/null
wait_ready "$container-fresh"
if phosphor_answers "$container-fresh"; then echo 'Phosphor started on a new installation although nothing asked for it'; exit 1; fi
docker exec "$container-fresh" node -e "const fs=require('node:fs');const root=process.env.CONFIG_DIR||'/data';process.exit(fs.existsSync(root+'/streamrd/streamrd.db')&&!fs.existsSync(root+'/phosphor')?0:1)" \
  || { echo 'A new installation must have StreamRD data and no Phosphor data'; exit 1; }
echo 'A new installation runs StreamRD alone: Phosphor is off until it is asked for.'
