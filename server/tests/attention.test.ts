import request from "supertest";
import { beforeEach, expect, it } from "vitest";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { accountProviderContext } from "../src/account-library";

let serial = 0;
async function user(role: "admin" | "user" = "user", maxAge: number | null = null) {
  const created = await db.user.create({ data: { email: `attention-${serial++}@example.invalid`, displayName: role === "admin" ? "Server owner" : "Family member", hashedPassword: "fixture-no-password-auth", role, maxAge } });
  return { ...created, token: signSession({ sub: created.id, email: created.email, role, version: created.sessionVersion }) };
}
type User = Awaited<ReturnType<typeof user>>;
async function item(owner: User, name: string, extra: Record<string, unknown> = {}) {
  await db.debridConfig.upsert({ where: { userId: owner.id }, create: { userId: owner.id, realDebridToken: "private-fixture-key" }, update: {} });
  const ctx = await accountProviderContext(owner.id, "realdebrid");
  return db.accountMedia.create({ data: { userId: owner.id, provider: "realdebrid", providerRef: `ref-${serial++}`, credentialFingerprint: ctx.fingerprint, name, year: 2020, type: "movie", phase: "finished", progress: 100, groupKey: `title:${name}`, minAge: 0, ratingLabel: "G", ...extra } });
}
async function library(owner: User, members: User[] = []) {
  const created = await request(app).post("/api/admin/shared-libraries").set(auth(owner.token)).send({ name: "Family movies", mediaType: "movie" });
  expect(created.status).toBe(201);
  for (const member of members) expect((await request(app).post(`/api/admin/shared-libraries/${created.body.library.id}/users`).set(auth(owner.token)).send({ userId: member.id })).status).toBe(200);
  return created.body.library.id as string;
}
const page = (libraryId: string, viewer: User, query = "") => request(app).get(`/api/shared-libraries/${libraryId}/items${query}`).set(auth(viewer.token));
const names = (res: { body: { items: Array<{ name: string }> } }) => res.body.items.map(row => row.name).sort();
const record = (owner: User, id: string, name: string, status: string) => db.metadataRecord.create({ data: { targetType: "account", targetId: id, ownerId: owner.id, name, mediaType: "movie", status } });

beforeEach(async () => { await resetDb(); });

it("counts the matches to fix and the broken links for the administrator, and filters to them", async () => {
  const owner = await user("admin"), fine = await item(owner, "Fine"), review = await item(owner, "Needs Review"), none = await item(owner, "No Match"), broken = await item(owner, "Broken Link"), queued = await item(owner, "Still Matching");
  await record(owner, fine.id, "Fine", "matched"); await record(owner, review.id, "Needs Review", "review"); await record(owner, none.id, "No Match", "unmatched"); await record(owner, queued.id, "Still Matching", "queued");
  await db.accountMedia.update({ where: { id: broken.id }, data: { health: "broken" } });
  const libraryId = await library(owner);
  const all = await page(libraryId, owner);
  expect(all.status).toBe(200); expect(all.body.attention).toEqual({ match: 2, links: 1 }); expect(names(all)).toHaveLength(5);
  const needs = await page(libraryId, owner, "?attention=1");
  expect(names(needs)).toEqual(["Broken Link", "Needs Review", "No Match"]); expect(needs.body.total).toBe(3);
});
it("shows members nothing about matches: no counts, and the filter changes nothing for them", async () => {
  const owner = await user("admin"), viewer = await user(), review = await item(owner, "Needs Review"), fine = await item(owner, "Fine");
  await record(owner, review.id, "Needs Review", "review"); await record(owner, fine.id, "Fine", "matched");
  const libraryId = await library(owner, [viewer]);
  const all = await page(libraryId, viewer); expect(all.body.attention).toBeUndefined(); expect(names(all)).toEqual(["Fine", "Needs Review"]);
  expect(names(await page(libraryId, viewer, "?attention=1"))).toEqual(["Fine", "Needs Review"]);
  expect(all.body.items.find((row: { name: string }) => row.name === "Needs Review").metadataStatus).toBe("review");
});
it("keeps another administrator's titles out of the counts", async () => {
  const owner = await user("admin"), other = await user("admin"), mine = await item(owner, "Mine"), theirs = await item(other, "Theirs");
  await record(other, theirs.id, "Theirs", "error"); await record(owner, mine.id, "Mine", "matched");
  const libraryId = await library(owner);
  expect((await page(libraryId, owner)).body.attention).toEqual({ match: 0, links: 0 });
});
