const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { databaseFile, inspectDatabase } = require("./database-state.cjs");
class UpgradeError extends Error { constructor(code) { super(code); this.code=code; } }
async function migrateDatabase({root=path.resolve(__dirname,".."),url=process.env.DATABASE_URL,apply=true}={}) {
  const before = await inspectDatabase({root,url});
  if (!apply) {
    if (before.state==="current" || (before.state==="unmanaged" && before.baseline==="current" && before.baselineApplied===before.total)) return {mode:"skipped",backup:null,state:before};
    throw new UpgradeError("disabled-schema-not-ready");
  }
  if (["failed","drifted"].includes(before.state) || (before.state==="unavailable" && before.reason!=="database-missing")) throw new UpgradeError(before.reason ?? "database-not-ready");
  if (before.state==="current") return {mode:"current",backup:null,state:before};
  let file;
  try { file=databaseFile(root,url); }
  catch { throw new UpgradeError("database-unavailable"); }
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  file=fs.existsSync(file)?fs.realpathSync(file):path.join(fs.realpathSync(path.dirname(file)),path.basename(file));
  const lock=file+".upgrade.lock";
  let descriptor;
  try { descriptor=fs.openSync(lock,"wx",0o600); }
  catch (error) { if(error.code==="EEXIST")throw new UpgradeError("upgrade-locked");throw new UpgradeError("upgrade-lock-unavailable"); }
  const owned=fs.fstatSync(descriptor);
  let backup=null;
  const env={...process.env,DATABASE_URL:`file:${file}`,CHECKPOINT_DISABLE:"1",PRISMA_HIDE_UPDATE_MESSAGE:"1"};
  const prisma=(args)=>execFileSync(process.execPath,[path.join(root,"node_modules/prisma/build/index.js"),...args],{cwd:root,env,stdio:"pipe",timeout:120000});
  const previousUmask=process.umask(0o077);
  try {
    fs.writeFileSync(descriptor,JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()})+"\n");
    // A competing process may have completed an upgrade since our first read.
    const state=await inspectDatabase({root,url:`file:${file}`});
    if (state.state==="current")return {mode:"current",backup:null,state};
    if (["failed","drifted"].includes(state.state) || (state.state==="unavailable" && state.reason!=="database-missing")) throw new UpgradeError(state.reason ?? "database-not-ready");
    if (fs.existsSync(file) && fs.statSync(file).size>0) {
      const directory=path.join(path.dirname(file),"backups");
      fs.mkdirSync(directory,{recursive:true,mode:0o700});
      backup=`pre-upgrade-${new Date().toISOString().replace(/[:.]/g,"-")}-${crypto.randomBytes(8).toString("hex")}.db`;
      execFileSync(process.execPath,[path.join(root,"scripts/backup-db.cjs"),path.join(directory,backup)],{cwd:root,env,stdio:"pipe",timeout:120000});
      const afterBackup=await inspectDatabase({root,url:`file:${file}`});
      if (JSON.stringify(afterBackup)!==JSON.stringify(state))throw new UpgradeError("database-changed-during-backup");
    }
    try { fs.closeSync(fs.openSync(file,"ax",0o600)); } catch (error) { if(error.code!=="EEXIST")throw error; }
    const names=state.pending;
    if (state.state==="unmanaged" && state.baseline!=="empty") {
      const count=state.baselineApplied;
      for(const name of names.slice(0,count))prisma(["migrate","resolve","--applied",name]);
    }
    prisma(["migrate","deploy"]);
    const after=await inspectDatabase({root,url:`file:${file}`});
    if(after.state!=="current")throw new UpgradeError(after.reason ?? "upgrade-verification-failed");
    return {mode:state.state==="unmanaged"&&state.baseline==="current"&&state.baselineApplied===state.total?"baselined":"migrated",backup,state:after};
  } catch(error) {
    if(error instanceof UpgradeError)throw error;
    throw new UpgradeError("upgrade-failed-review-snapshot");
  } finally {
    fs.closeSync(descriptor);
    // Release only the inode we created. Never remove a replacement/other lock.
    try { const current=fs.lstatSync(lock);if(current.ino===owned.ino&&current.dev===owned.dev)fs.unlinkSync(lock); } catch {}
    process.umask(previousUmask);
  }
}
function describeError(error) {
  const code=error?.code ?? "database-not-ready";
  const guidance=code==="upgrade-locked"?"Another upgrade owns the database lock. Do not delete it while its process is running; review a stale lock only after stopping all writers.":code==="baseline-history-incomplete"?"Baseline history is incomplete. Restore the verified pre-upgrade snapshot or review migration history with an administrator before resolving it.":code==="disabled-schema-not-ready"?"Schema application is disabled and this database is not ready. Prepare a backed-up upgrade explicitly before starting the app.":"The database was not prepared. Stop writers and review schema/history, permissions, and the verified pre-upgrade snapshot before retrying.";
  return `Database upgrade refused (${code}). ${guidance}`;
}
module.exports={migrateDatabase,describeError,UpgradeError};
if(require.main===module)migrateDatabase().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(describeError(error));process.exitCode=1;});
