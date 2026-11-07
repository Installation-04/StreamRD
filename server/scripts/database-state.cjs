const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { PrismaClient } = require("@prisma/client");
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const json = value => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? Number(item) : item);
function databaseFile(root, url) {
  if (typeof url !== "string" || !url.startsWith("file:")) throw new Error("sqlite-url-required");
  const filename = decodeURIComponent(url.slice(5).split("?")[0]);
  if (!filename || filename.includes("\0")) throw new Error("sqlite-filename-required");
  return path.isAbsolute(filename) ? filename : path.resolve(root, "prisma", filename);
}
function migrationFiles(root) {
  const snapshots = JSON.parse(fs.readFileSync(path.join(root, "prisma/schema-snapshots.json"), "utf8"));
  if(snapshots.format!==1 || !Array.isArray(snapshots.migrations) || !snapshots.migrations.length)throw new Error("migration-files-invalid");
  const digest=file=>crypto.createHash("sha256").update(fs.readFileSync(path.join(root,"prisma",file))).digest("hex");
  if(digest("schema.prisma")!==snapshots.datamodelChecksum)throw new Error("migration-files-invalid");
  for(const [key,file] of [["legacy","legacy-v0.1.prisma"],["current","community-v0.3.prisma"]]){
    const fixture=snapshots.fixtures?.[key];
    if(!fixture || fixture.file!==file || fixture.checksum!==digest(file) || !snapshots.migrations[fixture.applied-1])throw new Error("migration-files-invalid");
  }
  const folder = path.join(root, "prisma/migrations");
  const names = fs.readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  if (json(names) !== json(snapshots.migrations.map(item => item.name))) throw new Error("migration-files-invalid");
  for (const migration of snapshots.migrations) {
    const checksum = crypto.createHash("sha256").update(fs.readFileSync(path.join(folder, migration.name, "migration.sql"))).digest("hex");
    if (checksum !== migration.checksum) throw new Error("migration-files-invalid");
  }
  return {...snapshots,legacy:snapshots.migrations[snapshots.fixtures.legacy.applied-1].schema,current:snapshots.migrations[snapshots.fixtures.current.applied-1].schema};
}
async function schemaSignature(db) {
  const objects = await db.$queryRawUnsafe("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name <> '_prisma_migrations' ORDER BY type,name");
  if (objects.some(item => !["table", "index"].includes(item.type) || item.tbl_name === "_prisma_migrations")) throw new Error("unsupported-schema-object");
  const tables = [];
  for (const object of objects.filter(item => item.type === "table")) {
    // Prisma's model comparison ignores several SQLite-only constructs. Never
    // silently adopt a customized database containing these unsupported objects.
    if (/\b(CHECK\s*\(|AUTOINCREMENT\b|WITHOUT\s+ROWID\b|STRICT\s*;?\s*$|COLLATE\b|DEFERRABLE\b|ON\s+CONFLICT\b|CREATE\s+VIRTUAL\b)/i.test(object.sql ?? "")) throw new Error("unsupported-schema-object");
    const columns = await db.$queryRawUnsafe(`PRAGMA table_xinfo(${quote(object.name)})`);
    if (columns.some(column => Number(column.hidden) !== 0)) throw new Error("unsupported-schema-object");
    const fields = columns.map(({name,type,notnull,dflt_value,pk}) => ({name,type,notnull:Number(notnull),dflt_value,pk:Number(pk)})).sort((a,b)=>compare(a.name,b.name));
    const relations = (await db.$queryRawUnsafe(`PRAGMA foreign_key_list(${quote(object.name)})`)).map(({seq,table,from,to,on_update,on_delete,match})=>({seq:Number(seq),table,from,to,on_update,on_delete,match})).sort((a,b)=>compare(json(a),json(b)));
    const indices = [];
    for (const index of await db.$queryRawUnsafe(`PRAGMA index_list(${quote(object.name)})`)) {
      const parts = await db.$queryRawUnsafe(`PRAGMA index_xinfo(${quote(index.name)})`);
      if (Number(index.partial) || parts.some(part => Number(part.cid) === -2 || (part.coll && part.coll !== "BINARY"))) throw new Error("unsupported-schema-object");
      indices.push({name:index.name,unique:Number(index.unique),origin:index.origin,partial:Number(index.partial),columns:parts.map(({seqno,name,desc,coll,key})=>({seqno:Number(seqno),name,desc:Number(desc),coll,key:Number(key)}))});
    }
    indices.sort((a,b)=>compare(a.name,b.name));
    tables.push({name:object.name,columns:fields,foreignKeys:relations,indices});
  }
  return tables.sort((a,b)=>compare(a.name,b.name));
}
async function inspectDatabase({root=path.resolve(__dirname,".."),url=process.env.DATABASE_URL,db:provided}={}) {
  let snapshots;
  const result = {state:"unavailable",applied:0,total:0,pending:[],failed:[],reason:null,lastAppliedAt:null,baseline:null,baselineApplied:0,databaseExists:false};
  try { snapshots=migrationFiles(root); result.total=snapshots.migrations.length; result.pending=snapshots.migrations.map(m=>m.name); }
  catch { return {...result,reason:"migration-files-invalid"}; }
  let file;
  try { file=databaseFile(root,url); if (!fs.existsSync(file)) return {...result,reason:"database-missing"}; if (!fs.statSync(file).isFile()) return {...result,reason:"database-unavailable"}; }
  catch { return {...result,reason:"database-unavailable"}; }
  result.databaseExists=true;
  if (fs.statSync(file).size===0) return {...result,state:"unmanaged",reason:"migration-history-missing",baseline:"empty"};
  const db=provided ?? new PrismaClient({datasources:{db:{url:`file:${file}`}}});
  try {
    const integrity=await db.$queryRawUnsafe("PRAGMA integrity_check"), foreignKeys=await db.$queryRawUnsafe("PRAGMA foreign_key_check");
    if (!integrity.every(row=>Object.values(row).every(value=>value==="ok")) || foreignKeys.length) return {...result,state:"drifted",reason:"database-integrity-failed"};
    let signature;
    try { signature=await schemaSignature(db); }
    catch { return {...result,state:"drifted",reason:"unsupported-schema-object"}; }
    const same = expected => json(signature) === json(expected);
    const hasHistory=(await db.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'")).length>0;
    if (!hasHistory) {
      // Prefer frozen historical fixtures when signatures coincide. A future
      // schema-identical data migration must still run after that known baseline.
      const legacy=same(snapshots.legacy), community=same(snapshots.current);
      const latest=same(snapshots.migrations.at(-1).schema)
        && !snapshots.migrations.slice(0,-1).some(checkpoint=>same(checkpoint.schema));
      const baseline=signature.length===0?"empty":legacy?"legacy":community||latest?"current":null;
      const baselineApplied=legacy?snapshots.fixtures.legacy.applied:community?snapshots.fixtures.current.applied:latest?snapshots.migrations.length:0;
      return {...result,state:baseline?"unmanaged":"drifted",reason:baseline?"migration-history-missing":"unrecognized-schema",baseline,baselineApplied};
    }
    const columns=await db.$queryRawUnsafe('PRAGMA table_info("_prisma_migrations")');
    if (json(columns.map(column=>column.name).sort())!==json(["id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count"].sort())) return {...result,state:"drifted",reason:"migration-history-invalid"};
    const rows=await db.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at,started_at FROM "_prisma_migrations" ORDER BY started_at,migration_name');
    const failed=rows.filter(row=>!row.finished_at || row.rolled_back_at).map(row=>row.migration_name);
    if(failed.length)return {...result,state:"failed",failed,reason:"migration-history-failed"};
    const names=rows.map(row=>row.migration_name);
    if (new Set(names).size!==names.length || rows.some((row,index)=>row.migration_name!==snapshots.migrations[index]?.name))return {...result,state:"drifted",reason:"migration-history-unknown"};
    if(rows.some((row,index)=>row.checksum!==snapshots.migrations[index].checksum))return {...result,state:"drifted",reason:"migration-checksum-mismatch"};
    result.applied=rows.length;result.pending=snapshots.migrations.slice(rows.length).map(row=>row.name);
    const last=rows.at(-1)?.finished_at;result.lastAppliedAt=last?new Date(last).toISOString():null;
    const expected=rows.length===0?[]:snapshots.migrations[rows.length-1].schema;
    if(!same(expected))return {...result,state:"drifted",reason:snapshots.migrations.slice(rows.length).some(checkpoint=>same(checkpoint.schema))?"baseline-history-incomplete":"schema-drift"};
    return {...result,state:result.pending.length?"pending":"current",reason:null,baseline:rows.length===0?"empty":rows.length===1?"legacy":"current"};
  } catch { return {...result,state:"unavailable",reason:"database-unavailable"}; }
  finally { if (!provided)await db.$disconnect(); }
}
module.exports={databaseFile,migrationFiles,schemaSignature,inspectDatabase};
