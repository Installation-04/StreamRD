import { beforeEach, afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { MediaLibrary, suggestLibraryMedia } from "../src/library";
import { config } from "../src/config";
import { app, auth, resetDb, adminAndUser } from "./helpers";
let base: string, source: string, output: string, library: MediaLibrary;
beforeEach(async () => { base = await fs.mkdtemp(path.join(tmpdir(), "library-community-")); source = path.join(base, "media"); output = path.join(base, "export"); await fs.mkdir(source); library = new MediaLibrary(() => ({ sourceRoot: source, exportRoot: output })); });
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });
it("browses only readable confined videos and directories without writing the scanner tree", async () => {
  await fs.mkdir(path.join(source, "Movies"));
  for (const file of ["Film.2024.mkv", ".hidden.mp4", "notes.txt"]) await fs.writeFile(path.join(source, file), "fixture");
  await fs.writeFile(path.join(base, "outside.mp4"), "outside"); await fs.symlink(path.join(base, "outside.mp4"), path.join(source, "escape.mp4"));
  const page = await library.browse();
  expect(page.path).toBe(""); expect(page.parentPath).toBeNull();
  expect(page.items.map(item => item.name)).toEqual(["Film.2024.mkv", "Movies"]);
  expect(page.items[0].suggested).toMatchObject({ name: "Film", year: 2024, type: "movie", sourcePath: "Film.2024.mkv" });
  await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
});
it("paginates deterministically without duplicates and scopes cursors to directories", async () => {
  for (let n = 0; n < 13; n++) await fs.writeFile(path.join(source, `Film-${String(n).padStart(2, "0")}.mp4`), "fixture");
  await fs.mkdir(path.join(source, "nested"));
  const names: string[] = []; let cursor: string | undefined;
  do { const page = await library.browse({ limit: 3, cursor }); names.push(...page.items.map(i => i.name)); cursor = page.nextCursor ?? undefined; } while (cursor);
  expect(names).toHaveLength(14); expect(new Set(names).size).toBe(14); expect(names).toEqual([...names].sort());
  const first = await library.browse({ limit: 3 });
  await expect(library.browse({ path: "nested", cursor: first.nextCursor! })).rejects.toThrow("cursor");
  expect((await library.browse({ path: "nested" })).parentPath).toBe("");
});
it("rejects traversal, root escapes, bad pagination and files used as directories", async () => {
  await fs.symlink(base, path.join(source, "outside")); await fs.writeFile(path.join(source, "file.mp4"), "fixture");
  for (const folder of ["../", "/tmp", "a/../../", "outside", "file.mp4", "a\\b"]) await expect(library.browse({ path: folder })).rejects.toThrow();
  for (const limit of [0, 101, 1.5]) await expect(library.browse({ limit })).rejects.toThrow();
  await expect(library.browse({ cursor: "invalid" })).rejects.toThrow("cursor");
});
it("infers reviewable movie and episode hints without creating exports", async () => {
  expect(suggestLibraryMedia("Shows/Example.Show.2023.S01E02.1080p.mkv")).toMatchObject({ name: "Example Show", year: 2023, type: "episode", season: 1, episode: 2 });
  expect(suggestLibraryMedia("Example.Show.S00E01.mp4")).toMatchObject({ name: "Example Show", season: 0, episode: 1 });
  expect(suggestLibraryMedia("Example.Show.1x02.mkv")).toMatchObject({ name: "Example Show", season: 1, episode: 2 });
  await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
});
it("keeps partial batch successes and preserves original media and collisions", async () => {
  await fs.writeFile(path.join(source, "a.mp4"), "original a"); await fs.writeFile(path.join(source, "b.mp4"), "original b");
  const result = await library.addBatch([
    { name: "Film", year: 2024, type: "movie", sourcePath: "a.mp4" },
    { name: "Film", year: 2024, type: "movie", sourcePath: "b.mp4" },
    { name: "Show", type: "episode", season: 1, episode: 2, sourcePath: "b.mp4" },
    { name: "Invalid episode", type: "episode", sourcePath: "b.mp4" },
  ]);
  expect(result.summary).toEqual({ exported: 2, failed: 2 }); expect(result.results.map(i => i.status)).toEqual(["exported", "error", "exported", "error"]);
  expect(await fs.readFile(path.join(source, "a.mp4"), "utf8")).toBe("original a");
  expect(await fs.readFile(path.join(output, "Movies/Film (2024)/Film (2024).mp4"), "utf8")).toBe("original a");
  const repeated = await library.addBatch([{ name: "Film", year: 2024, type: "movie", sourcePath: "a.mp4" }]);
  expect(repeated.results[0].entry?.id).toBe(result.results[0].entry?.id);
  await expect(library.addBatch([])).rejects.toThrow(); await expect(library.addBatch(Array(101).fill({}))).rejects.toThrow();
});
it("protects browse and batch APIs with admin authorization and bounded payloads", async () => {
  await resetDb(); const { admin, user } = await adminAndUser();
  const original = [config.mediaSourceRoot, config.mediaLibraryRoot]; config.mediaSourceRoot = source; config.mediaLibraryRoot = output;
  try {
    expect((await request(app).get("/api/admin/library/files")).status).toBe(401);
    expect((await request(app).get("/api/admin/library/files").set(auth(user.token))).status).toBe(403);
    expect((await request(app).post("/api/admin/library/entries/batch").set(auth(user.token)).send({ items: [{}] })).status).toBe(403);
    expect((await request(app).get("/api/admin/library/files?limit=101").set(auth(admin.token))).status).toBe(400);
    expect((await request(app).post("/api/admin/library/entries/batch").set(auth(admin.token)).send({ items: [] })).status).toBe(400);
    expect((await request(app).get("/api/admin/library/files").set(auth(admin.token))).body.items).toEqual([]);
    const partial = await request(app).post("/api/admin/library/entries/batch").set(auth(admin.token)).send({ items: [null] });
    expect(partial.status).toBe(200); expect(partial.body.summary).toEqual({ exported: 0, failed: 1 });
  } finally { [config.mediaSourceRoot, config.mediaLibraryRoot] = original; }
});
