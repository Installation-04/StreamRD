// Reproducible checkpoint verification. Only temporary SQLite databases are used;
// the configured application DATABASE_URL is never opened or changed.
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const crypto=require("node:crypto");
const {execFileSync}=require("node:child_process");
const {PrismaClient}=require("@prisma/client");
const {schemaSignature}=require("./database-state.cjs");
const root=path.resolve(__dirname,"..");
const baselineNames={legacy:"00000000000000_legacy_baseline",current:"20261106000000_community_upgrade"};
async function main(){
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"migration-checkpoints-"));
 const file=path.join(temporary,"checkpoints.db");fs.writeFileSync(file,"",{mode:0o600});
 const env={...process.env,DATABASE_URL:`file:${file}`,CHECKPOINT_DISABLE:"1",PRISMA_HIDE_UPDATE_MESSAGE:"1"};
 const cli=path.join(root,"node_modules/prisma/build/index.js");
 const command=args=>execFileSync(process.execPath,[cli,...args],{cwd:root,env,stdio:"pipe"});
 const digest=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
 const names=fs.readdirSync(path.join(root,"prisma/migrations"),{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();
 const snapshots={format:1,datamodelChecksum:digest(path.join(root,"prisma/schema.prisma")),fixtures:{},migrations:[]};
 const db=new PrismaClient({datasources:{db:{url:`file:${file}`}}});
 try{
  for(const name of names){
   const sql=path.join(root,"prisma/migrations",name,"migration.sql");
   command(["db","execute","--url",`file:${file}`,"--file",sql]);
   // DDL runs in a different process. Reopen the inspection connection so
   // SQLite PRAGMA metadata cannot retain a previous schema cache.
   await db.$disconnect();
   snapshots.migrations.push({name,checksum:digest(sql),schema:await schemaSignature(db)});
   for(const [key,baseline] of Object.entries(baselineNames))if(name===baseline){
    const fixture=key==="legacy"?"legacy-v0.1.prisma":"community-v0.3.prisma";
    command(["migrate","diff","--from-url",`file:${file}`,"--to-schema-datamodel",path.join(root,"prisma",fixture),"--exit-code"]);
    snapshots.fixtures[key]={file:fixture,checksum:digest(path.join(root,"prisma",fixture)),applied:snapshots.migrations.length};
   }
  }
  if(!snapshots.fixtures.legacy || !snapshots.fixtures.current)throw Error("Required historical migration checkpoints are missing");
  command(["migrate","diff","--from-url",`file:${file}`,"--to-schema-datamodel",path.join(root,"prisma/schema.prisma"),"--exit-code"]);
  const output=JSON.stringify(snapshots,null,2)+"\n",destination=path.join(root,"prisma/schema-snapshots.json");
  if(process.argv.includes("--check")){
   if(!fs.existsSync(destination)||fs.readFileSync(destination,"utf8")!==output)throw Error("Migration snapshots are stale; review SQL and regenerate them");
   console.log("Migration SQL, historical checkpoints, current datamodel, and committed snapshots verified.");
  }else{fs.writeFileSync(destination,output);console.log("Generated reviewed schema checkpoints from the migration SQL chain.");}
 }finally{await db.$disconnect();fs.rmSync(temporary,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
