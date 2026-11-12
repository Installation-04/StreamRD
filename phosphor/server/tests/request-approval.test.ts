import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { MetadataDetails } from "../src/metadata/types";
import { fetchMetadata, searchMetadata } from "../src/metadata/providers";
import { approveAutomatically, retryAutomaticApprovals } from "../src/requests/approval";
import { addIndexer } from "../src/requests/finder";
import { resetRuntimeSettings, saveRuntimeSettings } from "../src/runtime-settings";
vi.mock("../src/metadata/providers", async original => ({ ...await original<typeof import("../src/metadata/providers")>(), fetchMetadata: vi.fn(), searchMetadata: vi.fn() }));

// A request that arrives is approved by the server unless it is set to wait: the best release is found, and it goes to an administrator's
// cloud account and library. Where it cannot, the request waits for a person and says why.
let serial = 0;
const details = (id = "101"): MetadataDetails => ({ provider: "tmdb", id, type: "movie", name: "The Example", year: 2020, posterUrl: null, description: "Fixture story", genres: ["Drama"], backdropUrl: null, cast: [], runtimeMinutes: 100, rating: 7, ratingSource: "TMDB", contentRating: null, imdbId: `tt${id.padStart(7, "0")}`, tmdbId: id, providerUrl: "https://www.themoviedb.org/movie/101", fetchedAt: new Date().toISOString() } as MetadataDetails);
async function person(role: "admin" | "user", cloud = false) {
  const user = await db.user.create({ data: { email: `auto-${serial++}@example.invalid`, displayName: "Fixture", hashedPassword: "unused-fixture-hash", role, debridConfig: { create: cloud ? { realDebridToken: "server-private-cloud-key" } : {} } } });
  return { ...user, token: signSession({ sub: user.id, email: user.email, role, version: user.sessionVersion }) };
}
const feed = (...items: Array<[string, string, number]>) => `<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>${items.map(([title, hash, seeders]) => `<item><title>${title}</title><torznab:attr name="infohash" value="${hash}"/><torznab:attr name="seeders" value="${seeders}"/><torznab:attr name="size" value="4294967296"/></item>`).join("")}</channel></rss>`;
const GOOD = "1".repeat(40);
const found = () => feed(["The Example 2020 720p HDTV x264", "2".repeat(40), 3], ["The Example 2020 1080p WEB-DL H264 AAC", GOOD, 40]);
async function server(options: { indexer?: boolean; cloud?: boolean; library?: boolean; feed?: () => string } = {}) {
  const owner = await person("admin", options.cloud !== false), member = await person("user");
  if (options.indexer !== false) { vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response((options.feed ?? found)(), { status: 200 })); await addIndexer({ name: "Prowlarr", baseUrl: "http://prowlarr:9696/1/api", apiKey: "k" }); }
  const library = options.library === false ? null : await db.sharedLibrary.create({ data: { name: "Movies", sourceUserId: owner.id, mediaType: "movie" } });
  await saveRuntimeSettings({ requestsAutoApprove: true });
  return { owner, member, library };
}
const ask = (token: string) => request(app).post("/api/requests").set(auth(token)).send({ provider: "tmdb", id: "101", type: "movie" });
const settle = async (id: string) => { for (let i = 0; i < 100; i++) { const row = await db.mediaRequest.findUnique({ where: { id } }); if (row && row.status !== "requested") return row; await new Promise(done => setTimeout(done, 20)); } return db.mediaRequest.findUnique({ where: { id } }); };
beforeEach(async () => { await resetDb(); vi.clearAllMocks(); vi.mocked(fetchMetadata).mockImplementation(async input => details(input.id)); vi.mocked(searchMetadata).mockResolvedValue([details()]); });
afterEach(() => { vi.restoreAllMocks(); resetRuntimeSettings(); });

it("approves a new request by itself: the best release, the administrator's cloud account, a library to publish into", async () => {
  const { owner, member, library } = await server();
  const created = await ask(member.token); expect(created.status).toBe(201);
  const row = (await settle(created.body.request.id))!;
  expect(row.status).toBe("approved");
  expect(row).toMatchObject({ destination: "cloud", providerId: "realdebrid", sourceUserId: owner.id, sharedLibraryId: library!.id });
  expect(row.sourceUrl).toContain(`btih:${GOOD}`);
  const events = (await db.requestEvent.findMany({ where: { requestId: row.id }, orderBy: { createdAt: "asc" } })).map(event => event.message);
  expect(events.at(-1)).toMatch(/^Approved automatically; the best release was chosen automatically \(The Example 2020 1080p WEB-DL H264 AAC\) for cloud download\.$/);
  const seen = await request(app).get(`/api/requests/${row.id}`).set(auth(member.token)); expect(seen.body.request.status).toBe("approved");   // the member sees it move on
});

it("leaves a request for a person, with the reason, when it cannot approve: no indexer, no release, no cloud account, no library", async () => {
  const cases: Array<[string, Parameters<typeof server>[0], RegExp]> = [
    ["no indexer", { indexer: false }, /No indexer is set up/],
    ["no release", { feed: () => feed(["Another Film 1999 1080p", "4".repeat(40), 9]) }, /No release of .The Example/],
    ["no cloud account", { cloud: false }, /no administrator has a working cloud download account/],
    ["no library", { library: false }, /no enabled shared library/],
  ];
  for (const [name, options, reason] of cases) {
    await resetDb(); vi.restoreAllMocks(); vi.mocked(fetchMetadata).mockImplementation(async input => details(input.id)); vi.mocked(searchMetadata).mockResolvedValue([details()]);
    const { member } = await server(options);
    const created = await ask(member.token); expect(created.status, name).toBe(201);
    await new Promise(done => setTimeout(done, 300));
    const row = (await db.mediaRequest.findUnique({ where: { id: created.body.request.id } }))!; expect(row.status, name).toBe("requested");
    const events = (await db.requestEvent.findMany({ where: { requestId: row.id } })).map(event => event.message);
    expect(events.some(message => /^Waiting for an administrator: /.test(message) && reason.test(message)), `${name}: ${events.join(" | ")}`).toBe(true);
  }
});

it("waits for an administrator when the setting is off, and an administrator can still approve by hand", async () => {
  const { owner, member } = await server(); await saveRuntimeSettings({ requestsAutoApprove: false });
  const created = await ask(member.token); await new Promise(done => setTimeout(done, 300));
  expect((await db.mediaRequest.findUnique({ where: { id: created.body.request.id } }))!.status).toBe("requested");
  expect((await approveAutomatically(created.body.request.id)).approved).toBe(false);
  const by = await request(app).post(`/api/admin/requests/${created.body.request.id}/approve`).set(auth(owner.token)).send({ destination: "cloud", providerId: "realdebrid" });
  expect(by.status).toBe(200); expect(by.body.request.status).toBe("approved");
  expect((await db.requestEvent.findMany({ where: { requestId: created.body.request.id } })).some(event => /^Administrator approved; the best release was chosen automatically/.test(event.message))).toBe(true);   // a person's approval reads as before
});

it("tries a waiting request again later, once an indexer and a library exist, and does not repeat the same line in its history", async () => {
  const { member, library } = await server({ indexer: false });
  const created = await ask(member.token); await new Promise(done => setTimeout(done, 300));
  const id = created.body.request.id as string;
  await approveAutomatically(id); await approveAutomatically(id);
  expect((await db.requestEvent.findMany({ where: { requestId: id } })).filter(event => /^Waiting for an administrator/.test(event.message))).toHaveLength(1);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(found(), { status: 200 })); await addIndexer({ name: "Prowlarr", baseUrl: "http://prowlarr:9696/1/api", apiKey: "k" });
  await db.mediaRequest.update({ where: { id }, data: { updatedAt: new Date(Date.now() - 30 * 60_000) } });   // it has waited a while
  expect(await retryAutomaticApprovals()).toBe(1);
  expect((await db.mediaRequest.findUnique({ where: { id } }))).toMatchObject({ status: "approved", sharedLibraryId: library!.id });
});

it("does not approve what is not waiting, and never approves into another administrator's or a disabled library", async () => {
  const { owner, member, library } = await server();
  const created = await ask(member.token); const row = (await settle(created.body.request.id))!; expect(row.status).toBe("approved");
  expect((await approveAutomatically(row.id)).approved).toBe(false);                       // already approved
  await db.mediaRequest.update({ where: { id: row.id }, data: { status: "requested", sourceUserId: null, sourceUrl: null, providerId: null, destination: null, sharedLibraryId: null, providerRef: null, startedAt: null } });
  await db.sharedLibrary.update({ where: { id: library!.id }, data: { enabled: false } });
  const other = await person("admin", true); await db.sharedLibrary.create({ data: { name: "Someone else's", sourceUserId: other.id, mediaType: "movie" } });
  await db.user.update({ where: { id: other.id }, data: { active: false } });                // an inactive administrator's library is not used
  const again = await approveAutomatically(row.id); expect(again.approved).toBe(false); expect(again.reason).toMatch(/no enabled shared library/);
  expect(owner.id).toBeTruthy();
});
