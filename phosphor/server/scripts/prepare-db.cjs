const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
try {
  // Validate production signing configuration before touching the database.
  require(path.join(root, "dist/src/config.js"));
  if (process.env.APPLY_SCHEMA_ON_START !== "false") {
    const url = process.env.DATABASE_URL;
    if (!url || !url.startsWith("file:")) throw new Error("A SQLite DATABASE_URL is required");
    const raw = decodeURIComponent(url.slice(5).split("?")[0]);
    if (!raw) throw new Error("A database filename is required");
    const file = path.isAbsolute(raw) ? raw : path.resolve(root, "prisma", raw);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.closeSync(fs.openSync(file, "ax", 0o600)); } catch (err) { if (err.code !== "EEXIST") throw err; }
    execFileSync(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "db", "push", "--skip-generate"], {
      cwd: root, stdio: "inherit", env: { ...process.env, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    });
  }
} catch (err) {
  console.error(err.message.startsWith("JWT_SECRET") ? err.message : "Database initialization failed; check schema compatibility and volume permissions.");
  process.exitCode = 1;
}
