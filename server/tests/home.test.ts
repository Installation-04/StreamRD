import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { queueAccountScans, runAccountLibraryJob, setAccountImportHook } from "../src/account-library";
import { scanAccountPage } from "../src/providers/account-library";
import { resetHomeCache } from "../src/home";

vi.mock("../src/providers/account-library", () => ({ scanAccountPage: vi.fn(), playAccountItem: vi.fn() }));
const scan = vi.mocked(scanAccountPage);
let serial = 0;
async function user(role: "admin" | "user" = "user") {
  const row = await db.user.create({ data: { email: `home-${serial++}@example.invalid`, displayName: role === "admin" ? "Owner" : "Member", hashedPassword: "fixture-no-password-auth", role } });
  return { ...row, token: signSession({ sub: row.id, email: row.email, role, version: row.sessionVersion }) };
}
type User = Awaited<ReturnType<typeof user>>;
async function imports(owner: User) {
  await db.debridConfig.create({ data: { userId: owner.id, realDebridToken: "server-only-private-key" } });
  scan.mockResolvedValue({ items: [
    { providerRef: "film-ref", name: "Server.Movie.2020.mkv", phase: "finished", progress: 100 },
    { providerRef: "show-ref", name: "Server.Show.S01E02.mkv", phase: "finished", progress: 100 },
  ], nextCursor: null });
  await queueAccountScans(owner.id); await runAccountLibraryJob();
  return db.accountMedia.findMany({ where: { userId: owner.id }, orderBy: { name: "asc" } });
}
const poster = (id: string) => `https://images.metahub.space/poster/small/${id}/img`;
const meta = (n: number, name: string, extra: Record<string, unknown> = {}) => ({ imdb_id: `tt${String(1000000 + n)}`, name, year: "2024", poster: poster(`tt${1000000 + n}`), imdbRating: "7.5", popularities: { trakt: 10 * n }, type: "movie", ...extra });
let calls: URL[];
function catalogues(handler?: (url: URL) => Response | undefined) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = new URL(String(input)); calls.push(url);
    const custom = handler?.(url); if (custom) return custom;
    // The real service redirects catalogue requests to a second host.
    if (url.hostname === "v3-cinemeta.strem.io") return new Response(null, { status: 307, headers: { Location: `https://cinemeta-catalogs.strem.io/top/catalog${url.pathname}` } });
    if (url.hostname === "cinemeta-catalogs.strem.io" && url.pathname.includes("/movie/")) return Response.json({ metas: [meta(1, "Movie One"), meta(5, "Movie Five"), meta(1, "Movie One again"), { id: "kitsu:1", name: "Not IMDb" }, meta(2, "Bad Poster", { poster: "https://evil.example/p.jpg" })] });
    if (url.hostname === "cinemeta-catalogs.strem.io") return Response.json({ metas: [meta(9, "Show Nine", { type: "series", year: "2019–2022" }), meta(3, "Show Three", { type: "series" })] });
    throw new Error(`Unexpected host ${url.hostname}`);
  }));
}
beforeEach(async () => { await resetDb(); vi.clearAllMocks(); setAccountImportHook(null); resetHomeCache(); delete process.env.HOME_EXTERNAL_LISTS; catalogues(); });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.HOME_EXTERNAL_LISTS; });

it("requires authentication", async () => { expect((await request(app).get("/api/home")).status).toBe(401); });

it("builds trending and popular rows from the public catalogues, with sanitized cards, following only allow-listed redirects", async () => {
  const member = await user(), res = await request(app).get("/api/home").set(auth(member.token));
  expect(res.status).toBe(200); expect(res.body.externalEnabled).toBe(true);
  expect(res.body.popularMovies.map((c: { name: string }) => c.name)).toEqual(["Movie One", "Movie Five", "Bad Poster"]);
  expect(res.body.popularMovies[2].posterUrl).toBeNull();
  expect(res.body.popularMovies[0]).toEqual({ provider: "free", id: "tt1000001", type: "movie", name: "Movie One", year: 2024, posterUrl: poster("tt1000001"), rating: 7.5 });
  expect(res.body.popularSeries[0]).toMatchObject({ id: "tt1000009", type: "series", year: 2019 });
  expect(res.body.trending.map((c: { name: string }) => c.name)).toEqual(["Show Nine", "Movie Five", "Show Three", "Bad Poster", "Movie One"]);
  expect(JSON.stringify(res.body)).not.toContain("trakt");
  expect(calls.every(url => ["v3-cinemeta.strem.io", "cinemeta-catalogs.strem.io"].includes(url.hostname) && url.search === "")).toBe(true);
});
it("caches the lists, serves the last good copy when a refresh fails, and shows nothing when it never worked", async () => {
  const member = await user();
  await request(app).get("/api/home").set(auth(member.token)); const first = calls.length;
  await request(app).get("/api/home").set(auth(member.token)); expect(calls.length).toBe(first);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 7 * 3600_000);
  try {
    catalogues(() => new Response("no", { status: 500 }));
    const stale = await request(app).get("/api/home").set(auth(member.token));
    expect(stale.body.popularMovies.length).toBe(3);
    resetHomeCache(); catalogues(() => new Response("no", { status: 500 }));
    const none = await request(app).get("/api/home").set(auth(member.token));
    expect(none.status).toBe(200); expect(none.body.trending).toEqual([]);
  } finally { vi.useRealTimers(); }
});
it("refuses a redirect to any other host and can be switched off", async () => {
  const member = await user();
  catalogues(url => url.hostname === "v3-cinemeta.strem.io" ? new Response(null, { status: 307, headers: { Location: "https://evil.example/steal.json" } }) : undefined);
  const blocked = await request(app).get("/api/home").set(auth(member.token));
  expect(blocked.body.trending).toEqual([]); expect(calls.some(url => url.hostname === "evil.example")).toBe(false);
  resetHomeCache(); process.env.HOME_EXTERNAL_LISTS = "false"; catalogues();
  const off = await request(app).get("/api/home").set(auth(member.token));
  expect(off.body).toMatchObject({ externalEnabled: false, trending: [], popularMovies: [], popularSeries: [] }); expect(calls).toHaveLength(0);
});
it("shows recently added and popular-on-this-server titles only from libraries the viewer can see", async () => {
  const owner = await user("admin"), member = await user(), other = await user(), items = await imports(owner);
  // An administrator sees their own imports before any library exists; nobody else does.
  const own = await request(app).get("/api/home").set(auth(owner.token));
  expect(own.body.recentlyAdded.map((entry: { libraryId: string | null }) => entry.libraryId)).toEqual([null, null]);
  const made = await request(app).post("/api/admin/shared-libraries").set(auth(owner.token)).send({ name: "Everything", mediaType: "all" });
  const libraryId = made.body.library.id as string;
  const empty = await request(app).get("/api/home").set(auth(member.token));
  expect(empty.body.recentlyAdded).toEqual([]); expect(empty.body.popularHere).toEqual([]);
  await request(app).patch(`/api/admin/shared-libraries/${libraryId}`).set(auth(owner.token)).send({ everyone: true });
  for (const viewer of [member, other]) {
    const home = await request(app).get("/api/home").set(auth(viewer.token));
    expect(home.body.recentlyAdded.map((entry: { item: { id: string } }) => entry.item.id).sort()).toEqual(items.map(item => item.id).sort());
    expect(home.body.recentlyAdded.every((entry: { libraryId: string }) => entry.libraryId === libraryId)).toBe(true);
  }
  const [film, show] = items;
  await db.sharedLibraryProgress.create({ data: { userId: member.id, itemId: show.id, mediaKey: "k1", positionSeconds: 30, durationSeconds: 100, activeSessionId: "s1" } });
  await db.sharedLibraryProgress.create({ data: { userId: other.id, itemId: show.id, mediaKey: "k1", positionSeconds: 10, durationSeconds: 100, activeSessionId: "s2" } });
  await db.sharedLibraryProgress.create({ data: { userId: other.id, itemId: film.id, mediaKey: "k1", positionSeconds: 10, durationSeconds: 100, activeSessionId: "s3" } });
  const ranked = await request(app).get("/api/home").set(auth(member.token));
  expect(ranked.body.popularHere.map((entry: { item: { id: string } }) => entry.item.id)).toEqual([show.id, film.id]);
  expect(JSON.stringify(ranked.body)).not.toContain(other.id);
  await request(app).patch(`/api/admin/shared-libraries/${libraryId}`).set(auth(owner.token)).send({ enabled: false });
  const hidden = await request(app).get("/api/home").set(auth(member.token));
  expect(hidden.body.recentlyAdded).toEqual([]); expect(hidden.body.popularHere).toEqual([]);
});
