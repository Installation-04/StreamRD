import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { queueAccountScans, runAccountLibraryJob, setAccountImportHook } from "../src/account-library";
import { scanAccountPage } from "../src/providers/account-library";
import { backfillGroups, idKey, qualityLabel, regroupSeries, titleKey } from "../src/versions";

vi.mock("../src/providers/account-library", () => ({ scanAccountPage: vi.fn(), playAccountItem: vi.fn() }));
const scan = vi.mocked(scanAccountPage);
let serial = 0;
async function user(role: "admin" | "user" = "user") {
  const row = await db.user.create({ data: { email: `versions-${serial++}@example.invalid`, displayName: role === "admin" ? "Owner" : "Member", hashedPassword: "fixture-no-password-auth", role } });
  return { ...row, token: signSession({ sub: row.id, email: row.email, role, version: row.sessionVersion }) };
}
type User = Awaited<ReturnType<typeof user>>;
type Entry = { providerRef: string; name: string; phase?: "finished" | "queued" | "downloading" | "error" };
async function imports(owner: User, entries: Entry[]) {
  if (!await db.debridConfig.findUnique({ where: { userId: owner.id } })) await db.debridConfig.create({ data: { userId: owner.id, realDebridToken: "server-only-private-key" } });
  scan.mockResolvedValue({ items: entries.map(entry => ({ phase: "finished" as const, progress: 100, ...entry })), nextCursor: null });
  await queueAccountScans(owner.id, { force: true }); while (await runAccountLibraryJob()) { /* drain */ }
}
const byRef = async (ref: string) => (await db.accountMedia.findFirstOrThrow({ where: { providerRef: ref } }));
const library = async (owner: User) => (await request(app).post("/api/admin/shared-libraries").set(auth(owner.token)).send({ name: "All", mediaType: "all", everyone: true })).body.library.id as string;
beforeEach(async () => { await resetDb(); vi.clearAllMocks(); setAccountImportHook(null); });
afterEach(() => vi.restoreAllMocks());

it("names titles and release qualities", () => {
  expect(titleKey("The Matrix", 1999, "movie")).toBe(titleKey("the  matrix", 1999, "movie"));
  expect(titleKey("Amélie", 2001, "movie")).toBe(titleKey("Amelie", 2001, "movie"));
  expect(titleKey("Up", 2009, "movie")).not.toBe(titleKey("Up", 2009, "series"));
  expect(titleKey("Up", 2009, "movie")).not.toBe(titleKey("Up", 2010, "movie"));
  expect(titleKey("!!!", null, "movie")).toBeNull();
  expect(titleKey("The Terminal List", 2022, "series")).toBe(titleKey("the terminal list", null, "series"));   // a show is named without its year
  expect(idKey({ imdbId: "tt0133093" })).toBe("imdb:tt0133093"); expect(idKey({ tmdbId: "603" })).toBe("tmdb:603"); expect(idKey({ imdbId: "nope" })).toBeNull();
  expect(qualityLabel("Movie.2020.2160p.UHD.BluRay.REMUX.HDR.HEVC-GRP")).toBe("4K · Remux · HEVC · HDR");
  expect(qualityLabel("Movie.2020.1080p.WEB-DL.DDP5.1.x264-GRP")).toBe("1080p · WEB · H.264");
  expect(qualityLabel("Some.Movie.2020")).toBeNull(); expect(qualityLabel(null)).toBeNull();
});
it("shows one card for a title imported several times, with the other versions on its page", async () => {
  const owner = await user("admin"), viewer = await user();
  await imports(owner, [
    { providerRef: "a", name: "Big.Movie.2020.1080p.WEB-DL.x264-GRP.mkv" }, { providerRef: "b", name: "Big.Movie.2020.2160p.BluRay.HDR.HEVC-GRP.mkv" },
    { providerRef: "c", name: "Other.Film.2019.720p.BluRay.x264.mkv" },
    { providerRef: "d", name: "Some.Show.S01.1080p.WEB-DL.mkv" }, { providerRef: "e", name: "Some.Show.S02.720p.HDTV.mkv" },
  ]);
  const lib = await library(owner);
  const listed = await request(app).get(`/api/shared-libraries/${lib}/items`).set(auth(viewer.token));
  expect(listed.body.total).toBe(3);                                                    // Big Movie, Other Film, Some Show
  expect(listed.body.items.map((item: { name: string }) => item.name).sort()).toEqual(["Big Movie", "Other Film", "Some Show"]);
  expect((await request(app).get("/api/shared-libraries").set(auth(viewer.token))).body.libraries[0].itemCount).toBe(3);
  const big = listed.body.items.find((item: { name: string }) => item.name === "Big Movie");
  const detail = await request(app).get(`/api/shared-libraries/${lib}/items/${big.id}`).set(auth(viewer.token));
  expect(detail.body.versions).toHaveLength(2);
  expect(detail.body.versions.map((version: { quality: string }) => version.quality).sort()).toEqual(["1080p · WEB · H.264", "4K · BluRay · HEVC · HDR"]);
  expect(detail.body.versions.filter((version: { current: boolean }) => version.current)).toHaveLength(1);
  // A version that is not the card in the list still opens, and shows the same set.
  const other = detail.body.versions.find((version: { current: boolean }) => !version.current);
  const sibling = await request(app).get(`/api/shared-libraries/${lib}/items/${other.id}`).set(auth(viewer.token));
  expect(sibling.status).toBe(200); expect(sibling.body.versions.map((version: { id: string }) => version.id).sort()).toEqual(detail.body.versions.map((version: { id: string }) => version.id).sort());
  expect((await request(app).get(`/api/shared-libraries/${lib}/items/${(await byRef("c")).id}`).set(auth(viewer.token))).body.versions).toEqual([]);   // one version: nothing to choose
  expect(await db.accountMedia.count()).toBe(5);                                          // nothing was merged or removed
});
it("prefers a finished version, then the newest, and promotes another when the shown one is removed", async () => {
  const owner = await user("admin"), viewer = await user();
  await imports(owner, [{ providerRef: "old", name: "Film.2018.1080p.mkv" }]);
  await new Promise(done => setTimeout(done, 15));
  await imports(owner, [{ providerRef: "old", name: "Film.2018.1080p.mkv" }, { providerRef: "new-unfinished", name: "Film.2018.2160p.mkv", phase: "downloading" }]);
  expect((await byRef("old")).isPrimary).toBe(true); expect((await byRef("new-unfinished")).isPrimary).toBe(false);   // finished beats newer
  await new Promise(done => setTimeout(done, 15));
  await imports(owner, [{ providerRef: "old", name: "Film.2018.1080p.mkv" }, { providerRef: "new-unfinished", name: "Film.2018.2160p.mkv" }]);
  expect((await byRef("new-unfinished")).isPrimary).toBe(true); expect((await byRef("old")).isPrimary).toBe(false);   // both finished: newest
  await library(owner);
  const removed = await request(app).delete(`/api/account/library/${(await byRef("new-unfinished")).id}`).set(auth(owner.token));
  expect(removed.status).toBe(200);
  expect((await byRef("old")).isPrimary).toBe(true);
  void viewer;
});
it("joins different names of one matched title and names titles that existed before grouping", async () => {
  const owner = await user("admin"), viewer = await user();
  await imports(owner, [{ providerRef: "x", name: "Alien.1979.1080p.mkv" }, { providerRef: "y", name: "Alien.Directors.Cut.1979.720p.mkv" }, { providerRef: "z", name: "Aliens.1986.1080p.mkv" }]);
  const lib = await library(owner);
  expect((await request(app).get(`/api/shared-libraries/${lib}/items`).set(auth(viewer.token))).body.total).toBe(3);   // three different names
  for (const ref of ["x", "y"]) { const item = await byRef(ref); await db.metadataRecord.create({ data: { targetType: "account", targetId: item.id, ownerId: owner.id, name: item.name, mediaType: "movie", status: "matched", data: JSON.stringify({ provider: "tmdb", id: "348", name: "Alien", type: "movie", year: 1979, genres: [], cast: [], fetchedAt: new Date().toISOString(), imdbId: "tt0078748" }) } }); }
  await db.accountMedia.updateMany({ data: { groupKey: null, isPrimary: true } });        // as if these rows predate grouping
  expect(await backfillGroups()).toBe(3);
  expect((await byRef("x")).groupKey).toBe("imdb:tt0078748"); expect((await byRef("y")).groupKey).toBe("imdb:tt0078748"); expect((await byRef("z")).groupKey).toMatch(/^movie\|aliens\|1986$/);
  expect((await request(app).get(`/api/shared-libraries/${lib}/items`).set(auth(viewer.token))).body.total).toBe(2);    // Alien (two versions) and Aliens
  expect(await backfillGroups()).toBe(0);                                                  // idempotent
});
it("puts the seasons of a show together when one is named with a year and another is not, also for seasons imported before shows were named without one", async () => {
  const owner = await user("admin"), viewer = await user();
  await imports(owner, [{ providerRef: "s1", name: "The.Terminal.List.S01.2022.1080p.WEB.x264.mkv" }, { providerRef: "s2", name: "The.Terminal.List.S02.1080p.WEB.x264.mkv" }, { providerRef: "other", name: "Another.Show.S01.1080p.WEB.x264.mkv" }]);
  const lib = await library(owner);
  expect((await byRef("s1")).groupKey).toBe((await byRef("s2")).groupKey);                  // one show, whatever year a release name carries
  expect((await request(app).get(`/api/shared-libraries/${lib}/items`).set(auth(viewer.token))).body.total).toBe(2);   // the show once, and the other show
  // Seasons that were saved under the old name, with the year: they are put together at the next start, and nothing else changes.
  await db.accountMedia.update({ where: { id: (await byRef("s1")).id }, data: { groupKey: "series|the terminal list|2022", isPrimary: true } });
  expect((await request(app).get(`/api/shared-libraries/${lib}/items`).set(auth(viewer.token))).body.total).toBe(3);   // as it was: two shows of that name
  expect(await regroupSeries()).toBe(1);
  expect((await byRef("s1")).groupKey).toBe("series|the terminal list|");
  expect((await request(app).get(`/api/shared-libraries/${lib}/items`).set(auth(viewer.token))).body.total).toBe(2);
  expect((await byRef("s1")).name).toBe((await db.accountMedia.findFirstOrThrow({ where: { providerRef: "s1" } })).name);   // untouched but for the group
  expect(await regroupSeries()).toBe(0);                                                    // idempotent
});
it("keeps each account's titles apart and respects a viewing limit when listing versions", async () => {
  const owner = await user("admin"), other = await user("admin");
  await imports(owner, [{ providerRef: "mine", name: "Shared.Name.2020.1080p.mkv" }]);
  await imports(other, [{ providerRef: "theirs", name: "Shared.Name.2020.1080p.mkv" }]);
  expect((await byRef("mine")).isPrimary).toBe(true); expect((await byRef("theirs")).isPrimary).toBe(true);   // never grouped across accounts
});
