const fs = require("node:fs");
const path = require("node:path");
const { migrateDatabase, describeError } = require("./migrate-db.cjs");
const root=path.resolve(__dirname,"..");
(async()=>{
  // Production must have a compiled, valid signing configuration before any DB
  // initialization, baseline adoption, snapshot, lock, or migration is attempted.
  const compiled=path.join(root,"dist/src/config.js");
  if(fs.existsSync(compiled))require(compiled);
  else if(process.env.NODE_ENV==="production")throw new Error("production-build-missing");
  const result=await migrateDatabase({root,apply:process.env.APPLY_SCHEMA_ON_START!=="false"});
  console.log(JSON.stringify({databasePreparation:result.mode,backup:result.backup,migrations:result.state.applied}));
})().catch(error=>{console.error(error.message?.startsWith("JWT_SECRET")?error.message:describeError(error));process.exitCode=1;});
