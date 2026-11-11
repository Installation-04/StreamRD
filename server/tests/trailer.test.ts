import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetHomeCache } from "../src/home";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { accountProviderContext } from "../src/account-library";

let serial = 0;
async function user(role: "admin" | "user" = "user", maxAge: number | null = null) {
  const created = await db.user.create({ data: { email: `trailer-${serial++}@example.invalid`, displayName: role === "admin" ? "Server owner" : "Family member", hashedPassword: "fixture-no-password-auth", role, maxAge } });
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
vi.mock("../src/metadata/account", async importOriginal => ({ ...(await importOriginal<typeof import("../src/metadata/account")>()), decorateAccountMedia: vi.fn(async (items: Array<{ id: string }>) => items.map(item => ({ ...item, metadata: { imdbId: "tt0388482" }, metadataStatus: "matched" }))) }));
const url = (libraryId: string, itemId: string) => `/api/shared-libraries/${libraryId}/items/${itemId}/trailer`;
const meta = (trailers: unknown) => vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({ meta: { id: "tt0388482", trailers } }), { status: 200, headers: { "Content-Type": "application/json" } }));
beforeEach(async () => { await resetDb(); resetHomeCache(); });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.HOME_TRAILERS; });

it("finds a title's trailer for the viewer, asks only the public catalogue, and caches the answer", async () => {
  const owner = await user("admin"), viewer = await user(), outsider = await user(), film = await item(owner, "Crank");
  const libraryId = await library(owner, [viewer]);
  const fetcher = meta([{ source: "abcdefghijk", type: "Trailer" }]); vi.stubGlobal("fetch", fetcher);
  const found = await request(app).get(url(libraryId, film.id)).set(auth(viewer.token));
  expect(found.status).toBe(200); expect(found.body).toEqual({ trailer: "abcdefghijk" });
  expect(fetcher).toHaveBeenCalledTimes(1); expect(String(fetcher.mock.calls[0][0])).toBe("https://v3-cinemeta.strem.io/meta/movie/tt0388482.json");
  await request(app).get(url(libraryId, film.id)).set(auth(viewer.token)); expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await request(app).get(url(libraryId, film.id)).set(auth(outsider.token))).status).toBe(404);
  expect((await request(app).get(url(libraryId, film.id))).status).toBe(401);
});
it("answers null when there is no trailer, the catalogue fails, or an operator turned trailers off", async () => {
  const owner = await user("admin"), viewer = await user(), film = await item(owner, "Crank");
  const libraryId = await library(owner, [viewer]);
  vi.stubGlobal("fetch", meta([{ source: "not-a-youtube-id!", type: "Trailer" }, { source: "abcdefghijk", type: "Clip" }]));
  expect((await request(app).get(url(libraryId, film.id)).set(auth(viewer.token))).body).toEqual({ trailer: null });
  resetHomeCache(); vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
  expect((await request(app).get(url(libraryId, film.id)).set(auth(viewer.token))).body).toEqual({ trailer: null });
  resetHomeCache(); const fetcher = meta([{ source: "abcdefghijk", type: "Trailer" }]); vi.stubGlobal("fetch", fetcher); process.env.HOME_TRAILERS = "false";
  expect((await request(app).get(url(libraryId, film.id)).set(auth(viewer.token))).body).toEqual({ trailer: null }); expect(fetcher).not.toHaveBeenCalled();
});
