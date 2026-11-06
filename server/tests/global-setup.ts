import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Points the suite at a throwaway SQLite database and applies the schema.
 * Runs in the vitest main process, so workers inherit the env vars.
 */
export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), "streamrd-test-"));
  const databasePath = join(dir, "test.db");
  // Prisma 5 may fail to initialize a missing SQLite file on newer runtimes.
  writeFileSync(databasePath, "");
  process.env.DATABASE_URL = `file:${databasePath}`;
  process.env.JWT_SECRET = "test-secret";
  execSync("npx prisma db push --skip-generate", {
    cwd: join(__dirname, ".."),
    env: { ...process.env },
    stdio: "inherit",
  });
}
