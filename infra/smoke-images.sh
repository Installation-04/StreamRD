#!/usr/bin/env bash
# Exercises only new disposable containers/volumes; never binds existing app data.
set -euo pipefail
product="${1:?Usage: smoke-images.sh streamrd|phosphor}"
case "$product" in streamrd) api_port=47821; web_port=3000; database=streamrd.db ;; phosphor) api_port=61337; web_port=3100; database=phosphor.db ;; *) exit 2 ;; esac
docker image inspect "$product-server" "$product-web" >/dev/null
suffix="$(openssl rand -hex 8)"
volume="${product}-smoke-${suffix}"
restored_volume="${product}-restore-${suffix}"
backend_id= web_id= restored_id= volume_created=false restored_created=false
cleanup() {
  local status=$?
  set +e
  if [ "$status" -ne 0 ] && [ -n "$backend_id" ]; then docker logs "$backend_id"; fi
  for container in "$backend_id" "$web_id" "$restored_id"; do [ -z "$container" ] || docker rm --force "$container" >/dev/null 2>&1; done
  [ "$volume_created" = false ] || docker volume rm "$volume" >/dev/null 2>&1
  [ "$restored_created" = false ] || docker volume rm "$restored_volume" >/dev/null 2>&1
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
for name in "$volume" "$restored_volume"; do
  if docker volume inspect "$name" >/dev/null 2>&1; then echo "Refusing an existing smoke volume" >&2; exit 1; fi
done
docker volume create "$volume" >/dev/null; volume_created=true
docker volume create "$restored_volume" >/dev/null; restored_created=true
smoke_jwt="$(openssl rand -hex 32)"
backend_id="$(docker run --pull=never --detach --volume "$volume:/app/data" --env "JWT_SECRET=$smoke_jwt" --env MEDIA_SOURCE_ROOT=/app/data/mounted --env MEDIA_LIBRARY_ROOT=/app/data/scanner-library "$product-server")"
wait_backend() {
  local container="$1"
  for attempt in $(seq 1 30); do
    if docker exec "$container" node -e "fetch('http://127.0.0.1:$api_port/api/health').then(async r => {const b=await r.json();process.exit(r.ok && b.db==='up'?0:1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo "Backend failed readiness" >&2; return 1
}
wait_backend "$backend_id"
docker exec "$backend_id" node -e 'const fs=require("node:fs"); if(process.getuid()===0)throw Error("Root runtime");for(const name of ["typescript","tsx","vitest"]){if(fs.existsSync(`/app/node_modules/${name}`))throw Error(`Development package shipped: ${name}`)}if(fs.existsSync("/app/dist/tests"))throw Error("Compiled tests shipped");if(fs.existsSync("/app/.env"))throw Error("Local environment file shipped");'
fixture() {
  docker exec --interactive --env "SMOKE_MODE=$2" --env "SMOKE_PRODUCT=$product" "$1" node <<'NODE'
(async()=>{
 const base=`http://127.0.0.1:${process.env.PORT}`;
 const call=async(path,data,token)=>{const res=await fetch(base+path,{method:data?"POST":"GET",headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},...(data?{body:JSON.stringify(data)}:{})});const body=await res.json();if(!res.ok)throw Error(`Fixture request failed: ${path} ${res.status}`);return body};
 const fs=require("node:fs");
 const credentials={email:"container@example.invalid",password:"container-password123"};
 const session=process.env.SMOKE_MODE==="create"?await call("/api/auth/signup",{...credentials,displayName:"Container fixture"}):await call("/api/auth/login",credentials);
 if(session.user.role!=="admin")throw Error("Admin role was not preserved");
 const streamrd=process.env.SMOKE_PRODUCT==="streamrd";
 if(process.env.SMOKE_MODE==="create")await call(streamrd?"/api/admin/catalog/create":"/api/admin/indexers",streamrd?{name:"Container fixture"}:{name:"Container fixture",baseUrl:"https://example.invalid/api",apiKey:"fixture-key"},session.token);
 if(process.env.SMOKE_MODE==="create"){
   fs.mkdirSync("/app/data/mounted",{recursive:true});fs.writeFileSync("/app/data/mounted/movie.mkv","container-media-fixture");
   await call("/api/admin/library/entries",{name:"Container media fixture",year:2024,type:"movie",sourcePath:"movie.mkv"},session.token);
 }
 const library=await call("/api/admin/library",undefined,session.token);
 if(process.env.SMOKE_MODE==="restore"){if(library.enabled)throw Error("Mount should remain optional after SQLite-only restore");}
 else {
   if(!library.entries.some(e=>e.sourceAvailable&&e.linked))throw Error("Exported library did not persist");
   if(fs.readFileSync("/app/data/scanner-library/Movies/Container media fixture (2024)/Container media fixture (2024).mkv","utf8")!=="container-media-fixture")throw Error("Exported symlink target cannot be read");
 }
 const users=await call("/api/admin/users",undefined,session.token);if(users.users.length!==1)throw Error("User count changed");
 const catalog=await call(streamrd?"/api/admin/catalog":"/api/admin/indexers",undefined,session.token);if(!(catalog.titles??catalog.indexers).some(item=>item.name==="Container fixture"))throw Error("Application data missing");
})().catch(error=>{console.error(error.message);process.exitCode=1});
NODE
}
fixture "$backend_id" create
docker restart "$backend_id" >/dev/null; wait_backend "$backend_id"; fixture "$backend_id" login
if [ "$product" = streamrd ]; then docker exec "$backend_id" node dist/prisma/seed.js >/dev/null; fi
docker exec "$backend_id" node scripts/backup-db.cjs /app/data/smoke-backup.db
docker exec "$backend_id" node -e 'if((require("node:fs").statSync("/app/data/smoke-backup.db").mode & 0o777)!==0o600)throw Error("Backup permissions too broad")'
if docker exec "$backend_id" node scripts/backup-db.cjs /app/data/smoke-backup.db >/dev/null 2>&1; then echo "Backup overwrote an existing file" >&2; exit 1; fi
docker run --pull=never --rm --user root --volume "$volume:/source:ro" --volume "$restored_volume:/target" "$product-server" node -e "const fs=require('node:fs');fs.copyFileSync('/source/smoke-backup.db','/target/$database',fs.constants.COPYFILE_EXCL);fs.chownSync('/target',1000,1000);fs.chownSync('/target/$database',1000,1000)"
restored_id="$(docker run --pull=never --detach --volume "$restored_volume:/app/data" --env "JWT_SECRET=$smoke_jwt" --env APPLY_SCHEMA_ON_START=false "$product-server")"
wait_backend "$restored_id"; fixture "$restored_id" restore
web_id="$(docker run --pull=never --detach "$product-web")"
for attempt in $(seq 1 30); do
  if docker exec "$web_id" node -e "fetch('http://127.0.0.1:$web_port/login').then(async r=>{const text=await r.text();process.exit(r.ok && text.includes('password')?0:1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 30 ]; then echo "Web failed readiness" >&2; exit 1; fi
  sleep 1
done
docker exec "$web_id" node -e 'if(process.getuid()===0)throw Error("Root web runtime")'
echo "$product: production startup, non-root/pruned runtime, restart persistence, verified backup/restore, mounted-library export, and web login passed."
