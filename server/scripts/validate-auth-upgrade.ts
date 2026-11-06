/** From server/: npx tsx scripts/validate-auth-upgrade.ts [../phosphor/server] */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import assert from "node:assert/strict";
async function main() {
  const repo = resolve(process.argv[2] ?? process.cwd());
  const current = readFileSync(join(repo, "prisma/schema.prisma"), "utf8");
  const old = current.replace("  sessionVersion Int @default(0)\n  revokedSessions RevokedSession[]\n", "").replace(/\nmodel RevokedSession \{[\s\S]*?\n\}\n?/, "\n");
  assert(!old.includes("sessionVersion") && !old.includes("RevokedSession"));
  const dir = mkdtempSync(join(tmpdir(), "auth-upgrade-")), file = join(dir, "fixture.db"), prior = join(dir, "before.prisma");
  writeFileSync(file, ""); writeFileSync(prior, old);
  const push = (schema: string) => execFileSync(process.execPath, [join(repo, "node_modules/prisma/build/index.js"), "db", "push", "--skip-generate", "--schema", schema], { cwd: repo, env: { ...process.env, DATABASE_URL: `file:${file}` }, stdio: "pipe" });
  const db = new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
  try {
    push(prior); const at = Date.now();
    await db.$executeRaw`INSERT INTO User (id,email,hashedPassword,displayName,role,active,createdAt,updatedAt) VALUES ('user','fixture@example.invalid','preserved-hash','Fixture','admin',1,${at},${at})`;
    await db.$executeRaw`INSERT INTO DebridConfig (userId,realDebridToken,updatedAt) VALUES ('user','fixture-provider-key',${at})`;
    await db.$executeRaw`INSERT INTO Setting (key,value) VALUES ('server','{}')`;
    await db.$executeRaw`INSERT INTO LogEvent (id,type,message,userId) VALUES ('event','system','Fixture event','user')`;
    if (old.includes("model Title {")) {
      await db.$executeRaw`INSERT INTO Title (id,name,updatedAt) VALUES ('title','Fixture movie',${at})`;
      await db.$executeRaw`INSERT INTO Profile (id,userId,name) VALUES ('profile','user','Kids')`;
      await db.$executeRaw`INSERT INTO Favorite (id,userId,titleId) VALUES ('favorite','user','title')`;
      await db.$executeRaw`INSERT INTO PlaybackLog (id,userId,titleId,providerUsed,success) VALUES ('log','user','title','realdebrid',1)`;
      await db.$executeRaw`INSERT INTO PlaybackSourceJob (key,userId,provider,providerRef,expiresAt) VALUES ('source','user','realdebrid','provider-reference',${at + 60000})`;
      await db.$executeRaw`INSERT INTO PlaybackSession (id,userId,profileId,scope,titleId,mediaKey,expiresAt) VALUES ('session','user','profile','profile','title','file',${at + 60000})`;
      await db.$executeRaw`INSERT INTO PlaybackProgress (id,userId,profileId,scope,titleId,mediaKey,positionSeconds,durationSeconds,activeSessionId) VALUES ('progress','user','profile','profile','title','file',30,120,'session')`;
    } else {
      await db.$executeRaw`INSERT INTO IndexerConfig (id,name,baseUrl,apiKey,updatedAt) VALUES ('indexer','Fixture','https://example.invalid/api','fixture-indexer-key',${at})`;
      await db.$executeRaw`INSERT INTO DownloadJob (id,userId,title,sourceUrl,provider,providerRef,progress,updatedAt) VALUES ('job','user','Fixture','magnet:fixture','realdebrid','reference',42,${at})`;
      await db.$executeRaw`INSERT INTO SavedSearch (id,userId,name,query) VALUES ('search','user','Saved','fixture')`;
    }
    const models = [...old.matchAll(/model (\w+) \{/g)].map(match => match[1]);
    const before = new Map<string, Record<string, unknown>[]>();
    for (const model of models) before.set(model, await db.$queryRawUnsafe(`SELECT * FROM "${model}" ORDER BY rowid`));
    await db.$disconnect(); push(join(repo, "prisma/schema.prisma"));
    const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
    for (const model of models) {
      const expected = before.get(model)!;
      const actual = await db.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "${model}" ORDER BY rowid`);
      assert.equal(actual.length, expected.length, `${model} row count changed`);
      for (let index = 0; index < expected.length; index++) {
        assert.equal(json(Object.fromEntries(Object.keys(expected[index]).map(key => [key, actual[index][key]]))), json(expected[index]), `${model} data changed`);
      }
    }
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: "user" }, select: { sessionVersion: true } })).sessionVersion, 0);
    assert.equal((await db.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check")).length, 0);
    assert.equal(await db.revokedSession.count(), 0);
    console.log(JSON.stringify({ repository: repo.endsWith("phosphor/server") ? "Phosphor" : "StreamRD", tablesPreserved: models.length, sessionVersionDefault: 0, foreignKeyViolations: 0 }));
  } finally { await db.$disconnect(); rmSync(dir, { recursive: true, force: true }); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
