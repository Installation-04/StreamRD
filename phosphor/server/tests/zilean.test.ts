import { beforeEach, expect, it } from "vitest";
import { resetDb } from "./helpers";
import { db } from "../src/db";
import { ensureZileanIndexer } from "../src/indexers/zilean";

beforeEach(async () => { await resetDb(); await db.indexerConfig.deleteMany(); });

it("does nothing unless ZILEAN_URL is a plain http(s) address", async () => {
  for (const value of [undefined, "", "not a url", "ftp://zilean:8181", "http://user:pass@zilean:8181"]) expect(await ensureZileanIndexer({ ZILEAN_URL: value })).toBe("skipped");
  expect(await db.indexerConfig.count()).toBe(0);
});
it("registers Zilean's unauthenticated Torznab endpoint once and never overwrites an edited entry", async () => {
  expect(await ensureZileanIndexer({ ZILEAN_URL: "http://zilean:8181" })).toBe("created");
  const row = await db.indexerConfig.findFirstOrThrow();
  expect(row).toMatchObject({ name: "Zilean", baseUrl: "http://zilean:8181/torznab/api", enabled: true });
  await db.indexerConfig.update({ where: { id: row.id }, data: { name: "My DMM", enabled: false } });
  expect(await ensureZileanIndexer({ ZILEAN_URL: "http://zilean:8181/" })).toBe("exists");
  expect(await db.indexerConfig.findFirstOrThrow()).toMatchObject({ name: "My DMM", enabled: false });
  expect(await db.indexerConfig.count()).toBe(1);
});
