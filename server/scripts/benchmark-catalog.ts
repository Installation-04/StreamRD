/** Run from server/: npx tsx scripts/benchmark-catalog.ts [title-count] */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

async function main() {
  const count = Number(process.argv[2] ?? 1000);
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error("Choose 1–10000 titles");
  // Always use a fresh isolated DB; never benchmark against application data.
  const dir = mkdtempSync(join(tmpdir(), "streamrd-benchmark-"));
  const file = join(dir, "catalog.db");
  writeFileSync(file, "");
  process.env.DATABASE_URL = `file:${file}`;
  const { db } = await import("../src/db");
  try {
    execFileSync(process.execPath, [join(process.cwd(), "node_modules/prisma/build/index.js"), "db", "push", "--skip-generate"], { stdio: "pipe" });
    await db.setting.create({ data: { key: "server", value: JSON.stringify({ allowUnauthenticatedBrowse: true }) } });
    for (let offset = 0; offset < count; offset += 100) {
      await db.title.createMany({ data: Array.from({ length: Math.min(100, count - offset) }, (_, i) => ({
        name: `Synthetic title ${offset + i}`, type: i % 2 ? "movie" : "series",
        description: "Synthetic description. ".repeat(100),
        genres: JSON.stringify(["Drama", `Genre ${(offset + i) % 10}`]),
        sources: JSON.stringify([{ kind: "link", url: "https://example.invalid/source" }]),
      })) });
    }
    const user = await db.user.create({ data: { email: "benchmark@example.invalid", displayName: "Synthetic user", hashedPassword: "benchmark-not-for-login" } });
    const titleIds = (await db.title.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map(title => title.id);
    for (let offset = 0; offset < count; offset += 100) {
      const batch = titleIds.slice(offset, offset + 100);
      await db.favorite.createMany({ data: batch.map(titleId => ({ titleId, userId: user.id })) });
      await db.playbackLog.createMany({ data: batch.map(titleId => ({ titleId, userId: user.id, success: true, providerUsed: "realdebrid" })) });
    }
    await db.playbackLog.createMany({ data: Array.from({ length: 220 }, () => ({ titleId: titleIds[0], userId: user.id, success: true, providerUsed: "realdebrid", createdAt: new Date(Date.now() + 1000) })) });
    const { signSession } = await import("../src/auth/jwt");
    const token = signSession({ sub: user.id, email: user.email, role: "user" });
    const { createApp } = await import("../src/app");
    const app = createApp();
    let queries = 0;
    db.$use(async (params, next) => { queries++; return next(params); });
    const results = [];
    for (const endpoint of ["/api/catalog/rows", "/api/catalog/browse", "/api/account/favorites", "/api/account/favorites/page", "/api/account/continue-watching", "/api/account/continue-watching/page"]) {
      const headers = endpoint.startsWith("/api/account/") ? { Authorization: `Bearer ${token}` } : {};
      await request(app).get(endpoint).set(headers).expect(200);
      const samples: number[] = [];
      let bytes = 0, cards = 0;
      queries = 0;
      for (let i = 0; i < 10; i++) {
        const started = performance.now();
        const response = await request(app).get(endpoint).set(headers).expect(200);
        samples.push(performance.now() - started);
        bytes = Buffer.byteLength(response.text);
        cards = response.body.rows ? response.body.rows.reduce((n: number, row: { titles: unknown[] }) => n + row.titles.length, 0) : response.body.titles.length;
      }
      samples.sort((a, b) => a - b);
      results.push({ endpoint, bytes, cards, queriesPerRequest: queries / 10, p50Ms: +samples[4].toFixed(2), p95Ms: +samples[9].toFixed(2) });
    }
    console.log(JSON.stringify({ titles: count, samples: 10, node: process.version, results }, null, 2));
  } finally { await db.$disconnect(); rmSync(dir, { recursive: true, force: true }); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
