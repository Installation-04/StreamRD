#!/usr/bin/env bash
# Exercises only new disposable containers/volumes; never binds existing app data.
set -euo pipefail
product="${1:?Usage: smoke-images.sh streamrd|phosphor}"
case "$product" in streamrd) api_port=47821; web_port=3000; database=streamrd.db ;; phosphor) api_port=61337; web_port=3100; database=phosphor.db ;; *) exit 2 ;; esac
docker image inspect "$product-server" "$product-web" >/dev/null
suffix="$(openssl rand -hex 8)"
volume="${product}-smoke-${suffix}"
restored_volume="${product}-restore-${suffix}"
upgrade_volume="${product}-upgrade-${suffix}"
backend_id= web_id= restored_id= upgraded_id= volume_created=false restored_created=false upgrade_created=false
cleanup() {
  local status=$?
  set +e
  if [ "$status" -ne 0 ] && [ -n "$backend_id" ]; then docker logs "$backend_id"; fi
  for container in "$backend_id" "$web_id" "$restored_id" "$upgraded_id"; do [ -z "$container" ] || docker rm --force "$container" >/dev/null 2>&1; done
  [ "$volume_created" = false ] || docker volume rm "$volume" >/dev/null 2>&1
  [ "$restored_created" = false ] || docker volume rm "$restored_volume" >/dev/null 2>&1
  [ "$upgrade_created" = false ] || docker volume rm "$upgrade_volume" >/dev/null 2>&1
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
for name in "$volume" "$restored_volume" "$upgrade_volume"; do
  if docker volume inspect "$name" >/dev/null 2>&1; then echo "Refusing an existing smoke volume" >&2; exit 1; fi
done
docker volume create "$volume" >/dev/null; volume_created=true
docker volume create "$restored_volume" >/dev/null; restored_created=true
docker volume create "$upgrade_volume" >/dev/null; upgrade_created=true
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
# Construct a populated, exact v0.3-format database only in a NEW disposable volume.
# This db push is a historical test-fixture constructor, never production startup.
docker run --pull=never --rm --interactive --volume "$upgrade_volume:/app/data" --env "SMOKE_PRODUCT=$product" "$product-server" node <<'NODE'
(async()=>{
 const fs=require("node:fs"),{execFileSync}=require("node:child_process"),{PrismaClient}=require("@prisma/client");
 const file=process.env.DATABASE_URL.slice(5);fs.closeSync(fs.openSync(file,"wx",0o600));
 execFileSync(process.execPath,["/app/node_modules/prisma/build/index.js","db","push","--skip-generate","--schema","/app/prisma/community-v0.3.prisma"],{stdio:"pipe",env:process.env});
 const db=new PrismaClient();try{
 // Raw SQL: the generated client already knows columns that later migrations add to this older database.
 const user={id:"upgrade-fixture-user"},now=Date.now();
 await db.$executeRawUnsafe("INSERT INTO User (id,email,hashedPassword,displayName,role,active,createdAt,updatedAt) VALUES (?,?,?,?,?,1,?,?)",user.id,"container@example.invalid",require("bcryptjs").hashSync("container-password123",10),"Upgrade fixture","admin",now,now);
 await db.$executeRawUnsafe("INSERT INTO DebridConfig (userId,realDebridToken,updatedAt) VALUES (?,?,?)",user.id,"upgrade-fixture-only",Date.now());
 if(process.env.SMOKE_PRODUCT==="streamrd")await db.title.create({data:{name:"Container fixture"}});
 else await db.indexerConfig.create({data:{name:"Container fixture",baseUrl:"https://example.invalid/api",apiKey:"fixture-only"}});
 const history=await db.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE name='_prisma_migrations'");if(history.length)throw Error("Historical fixture already has migration history");
 }finally{await db.$disconnect()}
})().catch(error=>{console.error(error.message);process.exitCode=1});
NODE
upgraded_id="$(docker run --pull=never --detach --volume "$upgrade_volume:/app/data" --env "JWT_SECRET=$smoke_jwt" "$product-server")"
wait_backend "$upgraded_id"; fixture "$upgraded_id" restore
docker exec --interactive "$upgraded_id" node <<'NODE'
(async()=>{
 const fs=require("node:fs"),{PrismaClient}=require("@prisma/client");
 const state=await require("./scripts/database-state.cjs").inspectDatabase();if(state.state!=="current"||state.applied!==state.total)throw Error("Adopted upgrade is not current");
 const files=fs.readdirSync("/app/data/backups").filter(name=>name.startsWith("pre-upgrade-")&&name.endsWith(".db"));if(files.length!==1)throw Error("Expected one automatic upgrade snapshot");
 const snapshot="/app/data/backups/"+files[0];if((fs.statSync(snapshot).mode&0o777)!==0o600)throw Error("Upgrade snapshot is not private");
 const db=new PrismaClient({datasources:{db:{url:"file:"+snapshot}}});try{
 if((await db.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE name='_prisma_migrations'")).length)throw Error("Snapshot was not taken before baseline adoption");
 if(Number((await db.$queryRawUnsafe("SELECT COUNT(*) AS count FROM User"))[0].count)!==1)throw Error("Original account missing from snapshot");
 }finally{await db.$disconnect()}
})().catch(error=>{console.error(error.message);process.exitCode=1});
NODE
web_id="$(docker run --pull=never --detach "$product-web")"
for attempt in $(seq 1 30); do
  if docker exec "$web_id" node -e "fetch('http://127.0.0.1:$web_port/login').then(async r=>{const text=await r.text();process.exit(r.ok && text.includes('password')?0:1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 30 ]; then echo "Web failed readiness" >&2; exit 1; fi
  sleep 1
done
docker exec "$web_id" node -e 'if(process.getuid()===0)throw Error("Root web runtime")'
echo "$product: production startup, non-root/pruned runtime, restart persistence, verified backup/restore, v0.3 adoption with pre-change snapshot, mounted-library export, and web login passed."
