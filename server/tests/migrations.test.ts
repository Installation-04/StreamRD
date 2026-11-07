import { afterEach, beforeEach, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root=process.cwd(), cli=path.join(root,"node_modules/prisma/build/index.js");
const {migrateDatabase}=require("../scripts/migrate-db.cjs");
const {inspectDatabase}=require("../scripts/database-state.cjs");
const checkpoints=JSON.parse(fs.readFileSync(path.join(root,"prisma/schema-snapshots.json"),"utf8"));
const names:string[]=checkpoints.migrations.map((step:{name:string})=>step.name);
const communityApplied:number=checkpoints.fixtures.current.applied;
let temporary:string,file:string,url:string;
const clients:PrismaClient[]=[];
beforeEach(()=>{temporary=fs.mkdtempSync(path.join(os.tmpdir(),"versioned-upgrade-"));file=path.join(temporary,"app.db");url=`file:${file}`;});
afterEach(async()=>{for(const client of clients.splice(0))await client.$disconnect();fs.rmSync(temporary,{recursive:true,force:true});});
function client(){const db=new PrismaClient({datasources:{db:{url}}});clients.push(db);return db;}
function command(args:string[]){return execFileSync(process.execPath,[cli,...args],{cwd:root,env:{...process.env,DATABASE_URL:url},stdio:"pipe"});}
function initialize(schema:"legacy"|"community"|"current"){
 fs.writeFileSync(file,"");
 const fixture=schema==="legacy"?"legacy-v0.1.prisma":schema==="community"?"community-v0.3.prisma":"schema.prisma";
 command(["db","push","--skip-generate","--schema",path.join(root,"prisma",fixture)]);
}
const stringify=(value:unknown)=>JSON.stringify(value,(_key,item)=>typeof item==="bigint"?item.toString():item);
async function seed(db:PrismaClient,current=false){
 const at=Date.now();
 await db.$executeRawUnsafe("INSERT INTO User (id,email,hashedPassword,displayName,role,active,createdAt,updatedAt) VALUES ('user','fixture@example.invalid','preserved-hash','Fixture','admin',1,?,?)",at,at);
 await db.$executeRawUnsafe("INSERT INTO DebridConfig (userId,realDebridToken,updatedAt) VALUES ('user','preserved-key',?)",at);
 await db.$executeRawUnsafe("INSERT INTO Setting (key,value) VALUES ('server','{}')");
 await db.$executeRawUnsafe("INSERT INTO LogEvent (id,type,message,userId) VALUES ('event','system','Fixture event','user')");
 const streamrd=fs.readFileSync(path.join(root,"prisma/schema.prisma"),"utf8").includes("model Title {");
 if(streamrd){
  await db.$executeRawUnsafe("INSERT INTO Title (id,name,updatedAt) VALUES ('title','Fixture movie',?)",at);
  await db.$executeRawUnsafe("INSERT INTO Profile (id,userId,name) VALUES ('profile','user','Kids')");
  await db.$executeRawUnsafe("INSERT INTO Favorite (id,userId,titleId) VALUES ('favorite','user','title')");
  await db.$executeRawUnsafe("INSERT INTO PlaybackLog (id,userId,titleId,providerUsed,success) VALUES ('log','user','title','realdebrid',1)");
  if(current){
   await db.$executeRawUnsafe("INSERT INTO PlaybackSourceJob (key,userId,provider,providerRef,expiresAt) VALUES ('source','user','realdebrid','reference',?)",at+60000);
   await db.$executeRawUnsafe("INSERT INTO PlaybackSession (id,userId,profileId,scope,titleId,mediaKey,expiresAt) VALUES ('session','user','profile','profile','title','file',?)",at+60000);
   await db.$executeRawUnsafe("INSERT INTO PlaybackProgress (id,userId,profileId,scope,titleId,mediaKey,positionSeconds,durationSeconds,activeSessionId) VALUES ('progress','user','profile','profile','title','file',30,120,'session')");
  }
 }else{
  await db.$executeRawUnsafe("INSERT INTO IndexerConfig (id,name,baseUrl,apiKey,updatedAt) VALUES ('indexer','Fixture','https://example.invalid/api','preserved-indexer-key',?)",at);
  await db.$executeRawUnsafe("INSERT INTO DownloadJob (id,userId,title,sourceUrl,provider,providerRef,progress,updatedAt) VALUES ('job','user','Fixture','magnet:fixture','realdebrid','reference',42,?)",at);
  await db.$executeRawUnsafe("INSERT INTO SavedSearch (id,userId,name,query) VALUES ('search','user','Saved','fixture')");
 }
 if(current)await db.$executeRawUnsafe("INSERT INTO RevokedSession (id,userId,expiresAt) VALUES ('revoked','user',?)",at+60000);
}
async function snapshot(db:PrismaClient){
 const models=await db.$queryRawUnsafe<{name:string}[]>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name <> '_prisma_migrations' ORDER BY name");
 const data:Record<string,Record<string,unknown>[]>={};
 for(const {name} of models)data[name]=await db.$queryRawUnsafe(`SELECT * FROM "${name}" ORDER BY rowid`);
 return data;
}
async function preserved(db:PrismaClient,before:Record<string,Record<string,unknown>[]>) {
 for(const [name,rows] of Object.entries(before)){
  const after=await db.$queryRawUnsafe<Record<string,unknown>[]>(`SELECT * FROM "${name}" ORDER BY rowid`);
  expect(after).toHaveLength(rows.length);
  for(let i=0;i<rows.length;i++)expect(stringify(Object.fromEntries(Object.keys(rows[i]).map(key=>[key,after[i][key]])))).toBe(stringify(rows[i]));
 }
 expect(await db.$queryRawUnsafe("PRAGMA foreign_key_check")).toEqual([]);
}
it("deploys new databases transactionally and becomes a read-only no-op on restart",async()=>{
 const result=await migrateDatabase({root,url});expect(result.mode).toBe("migrated");expect(result.backup).toBeNull();expect(result.state).toMatchObject({state:"current",applied:names.length,pending:[]});
 const before=fs.readFileSync(file);expect((await migrateDatabase({root,url})).mode).toBe("current");expect(fs.readFileSync(file)).toEqual(before);expect(fs.existsSync(file+".upgrade.lock")).toBe(false);
});
it("adopts exact legacy history, backs up, and upgrades without dropping parent/child data",async()=>{
 initialize("legacy");const db=client();await seed(db);const before=await snapshot(db);
 expect((await inspectDatabase({root,url})).baseline).toBe("legacy");
 const result=await migrateDatabase({root,url});expect(result.state.state).toBe("current");expect(result.backup).toMatch(/^pre-upgrade-/);await preserved(db,before);
 expect((await db.user.findUniqueOrThrow({where:{id:"user"}})).sessionVersion).toBe(0);
 const backup=path.join(temporary,"backups",result.backup);expect(fs.statSync(backup).mode&0o777).toBe(0o600);
 const restored=new PrismaClient({datasources:{db:{url:`file:${backup}`}}});clients.push(restored);expect((await restored.$queryRawUnsafe<{n:bigint}[]>("SELECT COUNT(*) AS n FROM User"))[0].n).toBe(1n);
 expect((await restored.$queryRawUnsafe<{name:string}[]>("PRAGMA table_info(User)")).some(row=>row.name==="sessionVersion")).toBe(false);
});
it("baselines current unmanaged databases and preserves all populated application tables",async()=>{
 initialize("current");const db=client();await seed(db,true);
 await db.metadataRecord.create({data:{targetType:"library",targetId:"preserved-library-id",name:"Preserved metadata",mediaType:"movie",status:"matched",requestedBy:"manual",data:'{"provider":"tmdb","id":"1"}',lockedFields:'["name"]',revision:2,attempts:1}});
 const before=await snapshot(db);const result=await migrateDatabase({root,url});
 expect(result.mode).toBe("baselined");expect(result.state.applied).toBe(names.length);expect(result.backup).toBeTruthy();await preserved(db,before);
});
it("adopts the frozen community schema then deploys metadata storage without changing existing data",async()=>{
 initialize("community");const db=client();await seed(db,true);const before=await snapshot(db);
 expect(await inspectDatabase({root,url})).toMatchObject({state:"unmanaged",baselineApplied:communityApplied,total:names.length});
 const result=await migrateDatabase({root,url});expect(result.mode).toBe("migrated");expect(result.backup).toBeTruthy();
 expect(result.state).toMatchObject({state:"current",applied:names.length,pending:[]});await preserved(db,before);
 expect(await db.metadataRecord.count()).toBe(0);
});
it("upgrades a managed v0.4 checkpoint with a pre-change snapshot and preserved application rows",async()=>{
 initialize("community");const db=client();await seed(db,true);
 for(const name of names.slice(0,communityApplied))command(["migrate","resolve","--applied",name]);
 const before=await snapshot(db);
 expect(await inspectDatabase({root,url})).toMatchObject({state:"pending",applied:communityApplied,pending:names.slice(communityApplied)});
 await expect(migrateDatabase({root,url,apply:false})).rejects.toMatchObject({code:"disabled-schema-not-ready"});
 const result=await migrateDatabase({root,url});expect(result.mode).toBe("migrated");expect(result.backup).toBeTruthy();
 expect(result.state).toMatchObject({state:"current",applied:names.length,pending:[]});await preserved(db,before);
 const backup=new PrismaClient({datasources:{db:{url:`file:${path.join(temporary,"backups",result.backup)}`}}});clients.push(backup);
 expect((await backup.$queryRawUnsafe<{count:bigint}[]>("SELECT COUNT(*) AS count FROM _prisma_migrations"))[0].count).toBe(BigInt(communityApplied));
 expect(await backup.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE name='MetadataRecord'")).toEqual([]);
});
it("refuses unknown schema and ignored-by-Prisma triggers without backups or history writes",async()=>{
 initialize("legacy");const db=client();await seed(db);await db.$executeRawUnsafe("CREATE TRIGGER unexpected AFTER UPDATE ON User BEGIN SELECT 1; END");
 const before=fs.readFileSync(file);expect((await inspectDatabase({root,url})).reason).toBe("unsupported-schema-object");await expect(migrateDatabase({root,url})).rejects.toMatchObject({code:"unsupported-schema-object"});expect(fs.readFileSync(file)).toEqual(before);expect(fs.existsSync(path.join(temporary,"backups"))).toBe(false);
 await db.$executeRawUnsafe("DROP TRIGGER unexpected");await db.$executeRawUnsafe("ALTER TABLE User ADD COLUMN unexpected TEXT");await expect(migrateDatabase({root,url})).rejects.toMatchObject({code:"unrecognized-schema"});
});
it("detects checksum tampering, unknown migrations, and failed history before deployment",async()=>{
 await migrateDatabase({root,url});const db=client();
 await db.$executeRawUnsafe("UPDATE _prisma_migrations SET checksum=? WHERE migration_name=?","0".repeat(64),names[0]);
 await expect(migrateDatabase({root,url})).rejects.toMatchObject({code:"migration-checksum-mismatch"});
 const checksum=JSON.parse(fs.readFileSync(path.join(root,"prisma/schema-snapshots.json"),"utf8")).migrations[0].checksum;
 await db.$executeRawUnsafe("UPDATE _prisma_migrations SET checksum=? WHERE migration_name=?",checksum,names[0]);
 await db.$executeRawUnsafe("UPDATE _prisma_migrations SET migration_name='untrusted' WHERE migration_name=?",names[0]);await expect(migrateDatabase({root,url})).rejects.toMatchObject({code:"migration-history-unknown"});
 await db.$executeRawUnsafe("UPDATE _prisma_migrations SET migration_name=? WHERE migration_name='untrusted'",names[0]);
 await db.$executeRawUnsafe("UPDATE _prisma_migrations SET finished_at=NULL WHERE migration_name=?",names[1]);
 expect((await inspectDatabase({root,url})).state).toBe("failed");await expect(migrateDatabase({root,url})).rejects.toMatchObject({code:"migration-history-failed"});
 await db.$executeRawUnsafe("UPDATE _prisma_migrations SET finished_at=?,rolled_back_at=? WHERE migration_name=?",Date.now(),Date.now(),names[1]);
 expect((await inspectDatabase({root,url})).state).toBe("failed");await expect(migrateDatabase({root,url})).rejects.toMatchObject({code:"migration-history-failed"});
});
it("refuses drift after managed deployment rather than trusting migrate deploy",async()=>{
 await migrateDatabase({root,url});const db=client();await db.$executeRawUnsafe("CREATE TABLE extra (id TEXT PRIMARY KEY)");
 await expect(migrateDatabase({root,url})).rejects.toMatchObject({code:"schema-drift"});expect(fs.existsSync(path.join(temporary,"backups"))).toBe(false);
});
it("detects incomplete adoption instead of applying duplicate schema upgrade SQL",async()=>{
 initialize("current");
 for(const name of names.slice(0,-1)){
  command(["migrate","resolve","--applied",name]);
  expect((await inspectDatabase({root,url})).reason).toBe("baseline-history-incomplete");
  await expect(migrateDatabase({root,url})).rejects.toMatchObject({code:"baseline-history-incomplete"});
 }
});
it("disabled mode never initializes a DB, lock, backup or history and permits exact current backups",async()=>{
 await expect(migrateDatabase({root,url,apply:false})).rejects.toMatchObject({code:"disabled-schema-not-ready"});expect(fs.existsSync(file)).toBe(false);
 initialize("legacy");const legacy=fs.readFileSync(file);await expect(migrateDatabase({root,url,apply:false})).rejects.toThrow();expect(fs.readFileSync(file)).toEqual(legacy);
 fs.unlinkSync(file);initialize("current");const current=fs.readFileSync(file);expect((await migrateDatabase({root,url,apply:false})).mode).toBe("skipped");expect(fs.readFileSync(file)).toEqual(current);expect(fs.readdirSync(temporary)).toEqual(["app.db"]);
});
it("respects an existing upgrade lock and never deletes another process's lock",async()=>{
 initialize("current");const lock=file+".upgrade.lock";fs.writeFileSync(lock,'{"pid":12345}');const before=fs.readFileSync(file);
 await expect(migrateDatabase({root,url})).rejects.toMatchObject({code:"upgrade-locked"});expect(fs.readFileSync(lock,"utf8")).toBe('{"pid":12345}');expect(fs.readFileSync(file)).toEqual(before);
});
it("validates production configuration before creating any database directories",()=>{
 const nested=path.join(temporary,"not-created","app.db");const result=spawnSync(process.execPath,[path.join(root,"scripts/prepare-db.cjs")],{cwd:root,env:{...process.env,NODE_ENV:"production",JWT_SECRET:"short",DATABASE_URL:`file:${nested}`},encoding:"utf8"});
 expect(result.status).not.toBe(0);expect(fs.existsSync(path.dirname(nested))).toBe(false);
});
it("refuses a changed datamodel until the SQL chain and checkpoints are reviewed",async()=>{
 await migrateDatabase({root,url});
 const copy=path.join(temporary,"repository");fs.mkdirSync(copy);fs.cpSync(path.join(root,"prisma"),path.join(copy,"prisma"),{recursive:true});
 fs.appendFileSync(path.join(copy,"prisma/schema.prisma"),'\nmodel Unmigrated {\n id String @id\n}\n');
 const before=fs.readFileSync(file);expect((await inspectDatabase({root:copy,url})).reason).toBe("migration-files-invalid");await expect(migrateDatabase({root:copy,url})).rejects.toMatchObject({code:"migration-files-invalid"});expect(fs.readFileSync(file)).toEqual(before);
 fs.copyFileSync(path.join(root,"prisma/schema.prisma"),path.join(copy,"prisma/schema.prisma"));
 fs.appendFileSync(path.join(copy,"prisma/migrations",names[0],"migration.sql"),"\n-- altered released SQL\n");
 expect((await inspectDatabase({root:copy,url})).reason).toBe("migration-files-invalid");await expect(migrateDatabase({root:copy,url})).rejects.toMatchObject({code:"migration-files-invalid"});expect(fs.readFileSync(file)).toEqual(before);
});
it("checks committed checkpoints using only temporary databases even when DATABASE_URL is configured",()=>{
 const untouched=path.join(temporary,"not-created","production.db");
 const result=spawnSync(process.execPath,[path.join(root,"scripts/generate-migration-snapshots.cjs"),"--check"],{cwd:root,env:{...process.env,DATABASE_URL:`file:${untouched}`},encoding:"utf8"});
 expect(result.status,result.stderr).toBe(0);expect(fs.existsSync(path.dirname(untouched))).toBe(false);
});
it("bootstrap disabled mode is nonmutating for current data and refuses absent databases",()=>{
 const missing=spawnSync(process.execPath,[path.join(root,"scripts/prepare-db.cjs")],{cwd:root,env:{...process.env,NODE_ENV:"test",APPLY_SCHEMA_ON_START:"false",DATABASE_URL:url},encoding:"utf8"});
 expect(missing.status).not.toBe(0);expect(fs.existsSync(file)).toBe(false);
 initialize("current");const before=fs.readFileSync(file);
 const current=spawnSync(process.execPath,[path.join(root,"scripts/prepare-db.cjs")],{cwd:root,env:{...process.env,NODE_ENV:"test",APPLY_SCHEMA_ON_START:"false",DATABASE_URL:url},encoding:"utf8"});
 expect(current.status,current.stderr).toBe(0);expect(fs.readFileSync(file)).toEqual(before);expect(fs.readdirSync(temporary)).toEqual(["app.db"]);
});

it.each([
 ["table", "CREATE TABLE sqliteX_custom (id TEXT PRIMARY KEY)"],
 ["trigger", "CREATE TRIGGER sqliteX_guard AFTER UPDATE ON User BEGIN SELECT 1; END"],
])("refuses custom sqliteX %s objects rather than hiding them behind SQL LIKE wildcards",async(_kind,sql)=>{
 initialize("current");const db=client();await db.$executeRawUnsafe(sql);
 const before=fs.readFileSync(file);
 expect((await inspectDatabase({root,url})).state).toBe("drifted");
 await expect(migrateDatabase({root,url})).rejects.toThrow();
 expect(fs.readFileSync(file)).toEqual(before);expect(fs.existsSync(path.join(temporary,"backups"))).toBe(false);
});

it("does not treat a known unmanaged checkpoint as ready when a later release adds a migration",async()=>{
 initialize("community");const copy=path.join(temporary,"future-repository");fs.mkdirSync(copy);
 fs.cpSync(path.join(root,"prisma"),path.join(copy,"prisma"),{recursive:true});
 fs.cpSync(path.join(root,"scripts"),path.join(copy,"scripts"),{recursive:true});
 fs.symlinkSync(path.join(root,"node_modules"),path.join(copy,"node_modules"),"dir");
 const next=path.join(copy,"prisma/migrations/20261107000000_future_marker");fs.mkdirSync(next);
 fs.writeFileSync(path.join(next,"migration.sql"),'BEGIN IMMEDIATE;\nCREATE TABLE "FutureMarker" ("id" TEXT NOT NULL PRIMARY KEY);\nCOMMIT;\n');
 fs.appendFileSync(path.join(copy,"prisma/schema.prisma"),'\nmodel FutureMarker {\n id String @id\n}\n');
 const generated=spawnSync(process.execPath,[path.join(copy,"scripts/generate-migration-snapshots.cjs")],{cwd:copy,env:process.env,encoding:"utf8"});
 expect(generated.status,generated.stderr).toBe(0);
 const checkpoint=await inspectDatabase({root:copy,url});expect(checkpoint).toMatchObject({state:"unmanaged",baselineApplied:communityApplied,total:names.length+1});
 const before=fs.readFileSync(file);await expect(migrateDatabase({root:copy,url,apply:false})).rejects.toMatchObject({code:"disabled-schema-not-ready"});expect(fs.readFileSync(file)).toEqual(before);
 const prepared=await migrateDatabase({root:copy,url});expect(prepared.mode).toBe("migrated");expect(prepared.state).toMatchObject({state:"current",applied:names.length+1,pending:[]});
},60000);

it("does not skip a schema-identical data-only migration when latest unmanaged adoption would be ambiguous",async()=>{
 initialize("current");const db=client();
 await db.metadataRecord.create({data:{targetType:"library",targetId:"unmanaged",name:"Original",mediaType:"movie",revision:7}});
 const copy=path.join(temporary,"data-migration-repository");fs.mkdirSync(copy);
 fs.cpSync(path.join(root,"prisma"),path.join(copy,"prisma"),{recursive:true});
 fs.cpSync(path.join(root,"scripts"),path.join(copy,"scripts"),{recursive:true});
 fs.symlinkSync(path.join(root,"node_modules"),path.join(copy,"node_modules"),"dir");
 const next=path.join(copy,"prisma/migrations/20261107000000_data_only");fs.mkdirSync(next);
 fs.writeFileSync(path.join(next,"migration.sql"),'BEGIN IMMEDIATE;\nUPDATE "MetadataRecord" SET "revision" = "revision" + 1;\nCOMMIT;\n');
 const generated=spawnSync(process.execPath,[path.join(copy,"scripts/generate-migration-snapshots.cjs")],{cwd:copy,env:process.env,encoding:"utf8"});
 expect(generated.status,generated.stderr).toBe(0);
 const before=fs.readFileSync(file);expect(await inspectDatabase({root:copy,url})).toMatchObject({state:"drifted",reason:"unrecognized-schema"});
 await expect(migrateDatabase({root:copy,url})).rejects.toMatchObject({code:"unrecognized-schema"});
 expect(fs.readFileSync(file)).toEqual(before);expect((await db.metadataRecord.findFirstOrThrow()).revision).toBe(7);
 expect(fs.existsSync(path.join(temporary,"backups"))).toBe(false);
},60000);
