const fs = require("node:fs");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
async function main() {
  const target = process.argv[2];
  if (!target || !process.env.DATABASE_URL?.startsWith("file:")) throw new Error("Usage: DATABASE_URL=file:... node scripts/backup-db.cjs <new-snapshot-path>");
  const destination = path.resolve(target);
  process.umask(0o077);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  // Reserve a new empty file; never replace an existing backup or source database.
  fs.closeSync(fs.openSync(destination, "wx", 0o600));
  const source = new PrismaClient();
  const backup = new PrismaClient({ datasources: { db: { url: `file:${destination}` } } });
  try {
    await source.$executeRawUnsafe("VACUUM INTO ?", destination);
    const integrity = await backup.$queryRawUnsafe("PRAGMA integrity_check");
    const foreignKeys = await backup.$queryRawUnsafe("PRAGMA foreign_key_check");
    if (!integrity.every(row => Object.values(row).every(value => value === "ok")) || foreignKeys.length) throw new Error("Snapshot verification failed");
    console.log(`Verified SQLite snapshot: ${destination}`);
  } finally { await source.$disconnect(); await backup.$disconnect(); }
}
main().catch(() => { console.error("Backup failed; use a new destination and verify database access/integrity. Existing files were not replaced."); process.exitCode = 1; });
