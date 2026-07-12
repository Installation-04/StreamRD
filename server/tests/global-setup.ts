import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Points the suite at a throwaway SQLite database and applies the schema.
 * Runs in the vitest main process, so workers inherit the env vars.
 */
export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), "streamrd-test-"));
  process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
  process.env.JWT_SECRET = "test-secret";
  execSync("npx prisma db push --skip-generate", {
    cwd: join(__dirname, ".."),
    env: { ...process.env },
    stdio: "inherit",
  });
}
