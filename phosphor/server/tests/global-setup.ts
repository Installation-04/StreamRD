import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Points the suite at a throwaway SQLite database and applies the schema. */
export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), "phosphor-test-"));
  const databasePath = join(dir, "test.db");
  writeFileSync(databasePath, "");
  process.env.DATABASE_URL = `file:${databasePath}`;
  process.env.JWT_SECRET = "test-secret";
  execSync("npx prisma db push --skip-generate", {
    cwd: join(__dirname, ".."),
    env: { ...process.env },
    stdio: "inherit",
  });
}
