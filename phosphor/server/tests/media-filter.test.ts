import request from "supertest";
import { beforeEach, expect, it } from "vitest";
import { app, auth, resetDb, adminAndUser } from "./helpers";
import { db } from "../src/db";
import { classifyTitle } from "../src/media-filter";
import { mediaHint } from "../src/account-library";

const KEEP = ["Crank 2006 Director's Cut 1080p BluRay DTS x264-CtrlHD.mkv", "The Hunger Games 2012 1080p BluRay x264", "Game of Thrones S01E02 720p HDTV x264", "Parker", "Safe", "G20",
  "Windows on the World 2010 720p WEB-DL", "Movie 2020 1080p WEB-DL REPACK", "Switch 2023 1080p WEB-DL", "Dune 2021 2160p UHD BluRay x265 HDR", "Wonder Woman 1984", "Steam Boy 2004 BDRip",
  "Playstation Network Hackers documentary 2012 WEB-DL"];
const SKIP: Array<[string, string]> = [["XBOX Master Game Collection [CCI", "game"], ["3424e951679a42e7ad891930319ce1df[EZTV x to", "unreadable"], ["Cyberpunk 2077 FitGirl Repack", "game"],
  ["God.of.War.PS4-DUPLEX", "game"], ["Super Mario Collection Nintendo Switch NSW", "game"], ["Adobe Photoshop 2024 v25 Crack", "software"], ["Windows 11 Pro x64 Activated", "software"],
  ["Pink Floyd Discography MP3 320kbps", "music"], ["Learn Python Udemy Course 2023", "book"], ["Some Game Setup.exe", "file"], ["manual.pdf", "file"], ["Best PC Games Collection 2020", "game"]];
beforeEach(async () => { await resetDb(); });

it("keeps movies and shows and skips games, software, music, books and unreadable names", () => {
  for (const name of KEEP) expect(classifyTitle(name), name).toEqual({ keep: true });
  for (const [name, reason] of SKIP) expect(classifyTitle(name), name).toEqual({ keep: false, reason });
});
it("applies the filter when importing account items and still derives type, year and cleaned name", () => {
  const item = (name: string) => ({ providerRef: "ref-" + name.length, name, phase: "finished" as const, progress: 100 });
  expect(mediaHint(item("XBOX Master Game Collection [CCI"))).toBeNull();
  expect(mediaHint(item("3424e951679a42e7ad891930319ce1df[EZTV x to"))).toBeNull();
  expect(mediaHint(item("Crank.2006.Directors.Cut.1080p.BluRay.DTS.x264-CtrlHD.mkv"))).toMatchObject({ name: "Crank", type: "movie", year: 2006 });
  expect(mediaHint(item("Show.Name.S02E05.720p.HDTV.x264"))).toMatchObject({ name: "Show Name", type: "series" });
});

async function seed(userId: string, names: string[]) {
  return Promise.all(names.map((name, index) => db.accountMedia.create({ data: { userId, provider: "realdebrid", providerRef: `${name}-${index}`, credentialFingerprint: "f".repeat(64), name, type: "movie", phase: "finished", progress: 100 } })));
}
it("previews and then removes only the caller's non-movie entries, leaving the provider and other users alone", async () => {
  const { admin, user } = await adminAndUser();
  const mine = await seed(admin.id, ["Parker", "XBOX Master Game Collection [CCI", "Adobe Photoshop 2024", "3424e951679a42e7ad891930319ce1df[EZTV x to", "Safe"]);
  const theirs = await seed(user.id, ["XBOX Master Game Collection [CCI"]);
  await db.metadataRecord.create({ data: { targetType: "account", targetId: mine[1].id, ownerId: admin.id, name: mine[1].name, mediaType: "movie", status: "review", requestedBy: "automatic" } });
  expect((await request(app).post("/api/account/library/cleanup").send({})).status).toBe(401);

  const preview = await request(app).post("/api/account/library/cleanup").set(auth(admin.token)).send({});
  expect(preview.status).toBe(200); expect(preview.headers["cache-control"]).toContain("no-store");
  expect(preview.body).toMatchObject({ matched: 3, removed: 0, applied: false, counts: { game: 1, software: 1, unreadable: 1 } });
  expect(preview.body.samples.map((row: { name: string }) => row.name)).toContain("XBOX Master Game Collection [CCI");
  expect(await db.accountMedia.count()).toBe(6); // a preview never deletes

  expect((await request(app).post("/api/account/library/cleanup").set(auth(admin.token)).send({ apply: "yes" })).status).toBe(400);
  const applied = await request(app).post("/api/account/library/cleanup").set(auth(admin.token)).send({ apply: true });
  expect(applied.body).toMatchObject({ matched: 3, removed: 3, applied: true });
  expect((await db.accountMedia.findMany({ where: { userId: admin.id }, orderBy: { name: "asc" } })).map(row => row.name)).toEqual(["Parker", "Safe"]);
  expect(await db.accountMedia.findUnique({ where: { id: theirs[0].id } })).not.toBeNull(); // another user's identical title is untouched
  expect(await db.metadataRecord.count({ where: { targetId: mine[1].id } })).toBe(0);
  expect((await request(app).post("/api/account/library/cleanup").set(auth(admin.token)).send({ apply: true })).body).toMatchObject({ matched: 0, removed: 0 });
});
