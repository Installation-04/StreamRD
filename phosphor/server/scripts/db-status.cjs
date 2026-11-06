// Read-only inspection. Never initializes a database, records a baseline, or deploys.
const path = require("node:path");
const { inspectDatabase } = require("./database-state.cjs");
inspectDatabase({ root: path.resolve(__dirname, ".."), url: process.env.DATABASE_URL })
  .then(result => { console.log(JSON.stringify(result, null, 2)); process.exitCode = result.state === "current" ? 0 : result.state === "unavailable" ? 2 : 1; })
  .catch(() => { console.error("Database status is unavailable; check the configured SQLite database and bundled migrations."); process.exitCode = 2; });
