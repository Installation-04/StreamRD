#!/usr/bin/env bash
# Production browser tests only against new containers and volumes owned by this run.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
product="${1:-both}"
case "$product" in both) products=(streamrd phosphor);; streamrd|phosphor) products=("$product");; *) echo 'Choose streamrd, phosphor, or both' >&2;exit 2;; esac
for item in "${products[@]}"; do docker image inspect "$item-server" "$item-web" >/dev/null;done
QA_PRODUCT="$product" node <<'JS'
const net=require('node:net');const ports=process.env.QA_PRODUCT==='both'?[47821,3000,61337,3100]:process.env.QA_PRODUCT==='streamrd'?[47821,3000]:[61337,3100];
(async()=>{for(const port of ports)await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',()=>reject(Error(`Port ${port} is occupied; no service was changed`)));server.listen(port,'127.0.0.1',()=>server.close(resolve));});})().catch(e=>{console.error(e.message);process.exitCode=1;});
JS
suffix="$(openssl rand -hex 8)"
containers=();volumes=()
cleanup(){ local code=$?;set +e;for id in "${containers[@]}";do docker rm -f "$id" >/dev/null 2>&1;done;for name in "${volumes[@]}";do docker volume rm "$name" >/dev/null 2>&1;done;return "$code"; }
trap cleanup EXIT
trap 'exit 130' INT TERM
for item in "${products[@]}";do
  api_port=47821;web_port=3000;[ "$item" = streamrd ] || { api_port=61337;web_port=3100; }
  volume="$item-browser-$suffix"
  if docker volume inspect "$volume" >/dev/null 2>&1;then echo 'Refusing an existing test volume' >&2;exit 1;fi
  docker volume create "$volume" >/dev/null;volumes+=("$volume")
  backend_name="$item-browser-api-$suffix";web_name="$item-browser-web-$suffix"
  for name in "$backend_name" "$web_name";do if docker container inspect "$name" >/dev/null 2>&1;then echo 'Refusing an existing test container' >&2;exit 1;fi;done
  containers+=("$backend_name" "$web_name")
  # Provider protocol fixtures are test-only preloads, outside the production image.
  docker run --pull=never --rm --interactive --mount "type=volume,src=$volume,dst=/app/data" "$item-server" node -e 'require("node:fs").writeFileSync("/app/data/metadata-fixture.cjs",require("node:fs").readFileSync(0),{mode:0o600})' < qa/metadata-fixture.cjs
  if [ "$item" = streamrd ]; then export QA_STREAMRD_BACKEND="$backend_name"; else export QA_PHOSPHOR_BACKEND="$backend_name"; fi
  backend="$(docker run --pull=never --name "$backend_name" -d -p "127.0.0.1:$api_port:$api_port" --mount "type=volume,src=$volume,dst=/app/data" -e "JWT_SECRET=$(openssl rand -hex 32)" -e MEDIA_SOURCE_ROOT=/app/data/mounted -e MEDIA_LIBRARY_ROOT=/app/data/library -e QA_METADATA_FIXTURES=1 -e LINK_HEALTH=false -e NODE_OPTIONS=--require=/app/data/metadata-fixture.cjs "$item-server")"
  docker exec "$backend" node -e 'const fs=require("node:fs");fs.mkdirSync("/app/data/mounted/Extras",{recursive:true});for(const name of ["Big.Buck.Bunny.2008.mp4","Example.Show.S01E02.mkv"])fs.writeFileSync(`/app/data/mounted/${name}`,"filesystem-only fixture; not playable media");'
  if [ "$item" = phosphor ];then docker exec -i "$backend" node -e 'require("node:fs").writeFileSync("/app/data/indexer-fixture.cjs",require("node:fs").readFileSync(0),{mode:0o600})' < qa/indexer-fixture.cjs;docker exec -d "$backend" node /app/data/indexer-fixture.cjs;fi
  web="$(docker run --pull=never --name "$web_name" -d -p "127.0.0.1:$web_port:$web_port" "$item-web")"
  QA_API_PORT="$api_port" QA_WEB_PORT="$web_port" node <<'JS'
(async()=>{for(const url of [`http://127.0.0.1:${process.env.QA_API_PORT}/api/health`,`http://127.0.0.1:${process.env.QA_WEB_PORT}/login`]){for(let n=0;n<60;n++){try{const r=await fetch(url);if(r.ok)break;throw Error(String(r.status));}catch(e){if(n===59)throw e;await new Promise(r=>setTimeout(r,1000));}}}})().catch(e=>{console.error('Disposable test service did not become ready:',e.message);process.exitCode=1;});
JS
done
export QA_PRODUCT="$product" QA_DISPOSABLE_FIXTURES=1
export QA_ARTIFACT_DIR="${QA_ARTIFACT_DIR:-/tmp/streamrd-browser-$suffix}"
node qa/product.cjs
printf 'Browser artifacts: %s\n' "$QA_ARTIFACT_DIR"
