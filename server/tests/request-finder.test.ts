import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { MetadataDetails } from "../src/metadata/types";
import { fetchMetadata, searchMetadata } from "../src/metadata/providers";
vi.mock("../src/metadata/providers", async original => ({ ...await original<typeof import("../src/metadata/providers")>(), fetchMetadata: vi.fn(), searchMetadata: vi.fn() }));
let serial = 0;
function details(id = "101", type: "movie" | "series" = "movie"): MetadataDetails {
 return { provider: "tmdb", id, type, name: "The Example", year: 2020, posterUrl: null, description: "Fixture story", genres: ["Drama"], backdropUrl: null, cast: [], runtimeMinutes: 100, rating: 7, ratingSource: "TMDB", contentRating: null, imdbId: `tt${id.padStart(7, "0")}`, tmdbId: id, providerUrl: "https://www.themoviedb.org/movie/101", fetchedAt: new Date().toISOString() } as MetadataDetails;
}
async function actor(role: "admin" | "user" = "user") {
 const user = await db.user.create({ data: { email: `finder-${serial++}@example.invalid`, displayName: "Request fixture", hashedPassword: "unused-fixture-hash", role, debridConfig: { create: {} } } });
 return { ...user, token: signSession({ sub: user.id, email: user.email, role, version: user.sessionVersion }) };
}
async function requested(userId: string, id = "101", status = "requested") {
 const media = details(id);
 return db.mediaRequest.create({ data: { canonicalKey: `imdb:movie:${media.imdbId}`, provider: media.provider, externalId: id, mediaType: media.type, name: media.name, year: media.year, metadata: JSON.stringify(media), status,
 followers: { create: { userId } }, events: { create: { status, message: "Fixture request" } } } });
}
const magnet = "magnet:?xt=urn:btih:0123456789012345678901234567890123456789";
async function cloudOwner() { const owner = await actor("admin"); await db.debridConfig.update({ where: { userId: owner.id }, data: { realDebridToken: "server-private-cloud-key" } }); return owner; }
beforeEach(async () => { await resetDb(); vi.clearAllMocks(); vi.mocked(fetchMetadata).mockImplementation(async input => details(input.id, input.type)); vi.mocked(searchMetadata).mockResolvedValue([details()]); });
afterEach(() => vi.restoreAllMocks());

const feed = (...items: Array<[string, string, number]>) => `<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>${items.map(([title, hash, seeders]) => `<item><title>${title}</title><torznab:attr name="infohash" value="${hash}"/><torznab:attr name="seeders" value="${seeders}"/><torznab:attr name="size" value="4294967296"/></item>`).join("")}</channel></rss>`;
const GOOD = "1".repeat(40), OTHER = "2".repeat(40), SEQUEL = "3".repeat(40);
const indexerFeed = () => feed(["The Example 2020 720p HDTV x264", OTHER, 3], ["The Example 2020 1080p WEB-DL H264 AAC", GOOD, 40], ["The Example 2 2022 1080p WEB-DL", SEQUEL, 90]);
it("keeps the indexers an administrator adds private to administrators and never returns their keys", async () => {
 const owner = await actor("admin"), member = await actor();
 vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(indexerFeed(), { status: 200 }));
 expect((await request(app).get("/api/admin/request-indexers").set(auth(member.token))).status).toBe(403);
 expect((await request(app).post("/api/admin/request-indexers").set(auth(owner.token)).send({ name: "Bad", baseUrl: "ftp://x/y", apiKey: "k" })).status).toBe(400);
 expect((await request(app).post("/api/admin/request-indexers").set(auth(owner.token)).send({ name: "Bad", baseUrl: "http://user:pw@prowlarr:9696/1/api", apiKey: "k" })).status).toBe(400);
 const added = await request(app).post("/api/admin/request-indexers").set(auth(owner.token)).send({ name: "Prowlarr", baseUrl: "http://prowlarr:9696/1/api", apiKey: "secret-indexer-key" });
 expect(added.status).toBe(201); expect(added.body.test).toMatchObject({ ok: true, results: 3 });
 const list = await request(app).get("/api/admin/request-indexers").set(auth(owner.token));
 expect(list.body.indexers).toHaveLength(1); expect(list.body.indexers[0]).toMatchObject({ name: "Prowlarr", hasKey: true, builtin: false }); expect(JSON.stringify(list.body)).not.toContain("secret-indexer-key");
 const stored = await db.setting.findUnique({ where: { key: "requests.indexers" } }); expect(stored!.value).not.toContain("secret-indexer-key");
 expect((await request(app).post(`/api/admin/request-indexers/${added.body.indexer.id}/test`).set(auth(owner.token))).body.ok).toBe(true);
 expect((await request(app).delete(`/api/admin/request-indexers/${added.body.indexer.id}`).set(auth(owner.token))).status).toBe(200);
 expect((await request(app).get("/api/admin/request-indexers").set(auth(owner.token))).body.indexers).toEqual([]);
});
it("finds a release by itself: lists candidates best first, and approves with no magnet by choosing the best one", async () => {
 const owner = await cloudOwner(), member = await actor(), row = await requested(member.id);
 const approve = () => request(app).post(`/api/admin/requests/${row.id}/approve`).set(auth(owner.token)).send({ destination: "cloud", providerId: "realdebrid" });
 const none = await approve(); expect(none.status).toBe(409); expect(none.body.error).toMatch(/No indexer is set up/);
 await request(app).post("/api/admin/request-indexers").set(auth(owner.token)).send({ name: "Prowlarr", baseUrl: "http://prowlarr:9696/1/api", apiKey: "k" }).catch(() => undefined);
 const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(indexerFeed(), { status: 200 }));
 await request(app).post("/api/admin/request-indexers").set(auth(owner.token)).send({ name: "Prowlarr", baseUrl: "http://prowlarr:9696/1/api", apiKey: "k" });
 const found = await request(app).get(`/api/admin/requests/${row.id}/releases`).set(auth(owner.token));
 expect(found.status).toBe(200); expect(found.body.candidates.map((c: { title: string }) => c.title)).toEqual(["The Example 2020 1080p WEB-DL H264 AAC", "The Example 2020 720p HDTV x264"]);
 expect(found.body.candidates[0].tags.map((t: { label: string }) => t.label)).toEqual(expect.arrayContaining(["1080p", "WEB", "H.264", "AAC"]));
 expect((await request(app).get(`/api/admin/requests/${row.id}/releases`).set(auth(member.token))).status).toBe(403);
 const approved = await approve();
 expect(approved.status).toBe(200); expect(approved.body.request.status).toBe("approved");
 const saved = await db.mediaRequest.findUnique({ where: { id: row.id } }); expect(saved!.sourceUrl).toContain(`btih:${GOOD}`);
 expect((await db.requestEvent.findMany({ where: { requestId: row.id } })).some(event => /chosen automatically/.test(event.message))).toBe(true);
 expect(fetcher).toHaveBeenCalled();
});
it("still accepts a magnet pasted by hand, and says plainly when nothing is found", async () => {
 const owner = await cloudOwner(), member = await actor(), row = await requested(member.id), other = await requested(member.id, "102");
 const hand = await request(app).post(`/api/admin/requests/${row.id}/approve`).set(auth(owner.token)).send({ destination: "cloud", sourceUrl: magnet, providerId: "realdebrid" });
 expect(hand.status).toBe(200);
 await request(app).post("/api/admin/request-indexers").set(auth(owner.token)).send({ name: "Empty", baseUrl: "http://prowlarr:9696/1/api", apiKey: "k" }).catch(() => undefined);
 vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(feed(), { status: 200 }));
 await request(app).post("/api/admin/request-indexers").set(auth(owner.token)).send({ name: "Empty", baseUrl: "http://prowlarr:9696/1/api", apiKey: "k" });
 const empty = await request(app).post(`/api/admin/requests/${other.id}/approve`).set(auth(owner.token)).send({ destination: "cloud", providerId: "realdebrid" });
 expect(empty.status).toBe(409); expect(empty.body.error).toMatch(/No release of/);
});
