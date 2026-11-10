import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { queueAccountScans, runAccountLibraryJob, setAccountImportHook } from "../src/account-library";
import { scanAccountPage } from "../src/providers/account-library";
import { backfillRatings } from "../src/ratings";

vi.mock("../src/providers/account-library", () => ({ scanAccountPage: vi.fn(), playAccountItem: vi.fn() }));
const scan = vi.mocked(scanAccountPage);
let serial = 0;
async function user(role: "admin" | "user" = "user", maxAge: number | null = null) {
  const row = await db.user.create({ data: { email: `limits-${serial++}@example.invalid`, displayName: role === "admin" ? "Owner" : "Member", hashedPassword: "fixture-no-password-auth", role, maxAge } });
  return { ...row, token: signSession({ sub: row.id, email: row.email, role, version: row.sessionVersion }) };
}
type User = Awaited<ReturnType<typeof user>>;
const names = ["Kid.Cartoon.2019.mkv", "Family.Film.2018.mkv", "Teen.Drama.2020.mkv", "Adult.Thriller.2021.mkv", "Mystery.Unrated.2022.mkv"];
async function imports(owner: User) {
  await db.debridConfig.create({ data: { userId: owner.id, realDebridToken: "server-only-private-key" } });
  scan.mockResolvedValue({ items: names.map((name, index) => ({ providerRef: `ref-${index}`, name, phase: "finished" as const, progress: 100 })), nextCursor: null });
  await queueAccountScans(owner.id); await runAccountLibraryJob();
  return Object.fromEntries((await db.accountMedia.findMany({ where: { userId: owner.id } })).map(item => [item.name.split(" ")[0].toLowerCase().replace(/\..*/, ""), item])) as Record<string, { id: string; name: string }>;
}
async function matched(item: { id: string; name: string }, owner: User, contentRating: string | null) {
  await db.metadataRecord.create({ data: { targetType: "account", targetId: item.id, ownerId: owner.id, name: item.name, mediaType: "movie", status: "matched",
    data: JSON.stringify({ provider: "tmdb", id: "1", name: item.name, type: "movie", year: 2020, genres: [], cast: [], fetchedAt: new Date().toISOString(), contentRating }) } });
}
beforeEach(async () => { await resetDb(); vi.clearAllMocks(); setAccountImportHook(null); });
afterEach(() => vi.restoreAllMocks());

it("gives a limited account only its libraries on the home page: no public trending lists", async () => {
  const kid = await user("user", 7);
  expect((await request(app).get("/api/home").set(auth(kid.token))).body).toMatchObject({ externalEnabled: false, trending: [], popularMovies: [], popularSeries: [], featured: [] });
});
it("keeps matched titles above the limit out of the home rows", async () => {
  const owner = await user("admin"), items = await imports(owner), kid = await user("user", 8);
  await request(app).post("/api/admin/shared-libraries").set(auth(owner.token)).send({ name: "All", mediaType: "all", everyone: true });
  await matched(items.kid, owner, "G"); await matched(items.adult, owner, "TV-MA"); await backfillRatings();
  const home = await request(app).get("/api/home").set(auth(kid.token));
  expect(home.body.recentlyAdded.map((entry: { item: { id: string } }) => entry.item.id)).toEqual([items.kid.id]);
});
