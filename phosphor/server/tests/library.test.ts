import { afterEach, beforeEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { MediaLibrary, LibraryInput, libraryPath } from "../src/library";
import { config } from "../src/config";
import { app, auth, resetDb } from "./helpers";
let temporary: string, source: string, output: string, library: MediaLibrary;
const media = (extra: Partial<LibraryInput> = {}): LibraryInput => ({ name: "Example", year: 2024, type: "movie", sourcePath: "movie.mkv", ...extra });
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(tmpdir(), "media-library-"));
  source = path.join(temporary, "mount"); output = path.join(temporary, "library");
  await fs.mkdir(source); await fs.writeFile(path.join(source, "movie.mkv"), "video fixture");
  library = new MediaLibrary(() => ({ sourceRoot: source, exportRoot: output }));
});
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });
it("creates movie and episode layouts recognized by Plex and Jellyfin", async () => {
  const movie = await library.add(media());
  expect(movie.libraryPath).toBe("Movies/Example (2024)/Example (2024).mkv");
  expect(await fs.readFile(path.join(output, movie.libraryPath), "utf8")).toBe("video fixture");
  const episode = await library.add(media({ name: "Example Show", type: "episode", season: 0, episode: 2 }));
  expect(episode.libraryPath).toBe("TV Shows/Example Show (2024)/Season 00/Example Show - S00E02.mkv");
  expect((await library.list()).entries.every(e => e.linked && e.sourceAvailable)).toBe(true);
});
it("keeps URL-only installations disabled without creating directories", async () => {
  const disabled = new MediaLibrary(() => ({ sourceRoot: "", exportRoot: "" }));
  expect(await disabled.list()).toEqual({ enabled: false, entries: [] });
  await expect(disabled.add(media())).rejects.toMatchObject({ status: 503 });
  await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects traversal, absolute paths, URL targets and unsupported files", async () => {
  for (const sourcePath of ["../movie.mkv", "/movie.mkv", "https://cdn.invalid/movie.mp4", "folder/../../movie.mkv", "a\\movie.mkv", "movie.txt", "./movie.mkv"]) {
    await expect(library.add(media({ sourcePath }))).rejects.toThrow();
  }
  expect((await library.list()).entries).toHaveLength(0);
});
it("rejects escaping source symlinks and non-file targets", async () => {
  const outside = path.join(temporary, "private.mkv"); await fs.writeFile(outside, "private");
  await fs.symlink(outside, path.join(source, "escape.mkv"));
  await expect(library.add(media({ sourcePath: "escape.mkv" }))).rejects.toThrow("outside");
  await fs.mkdir(path.join(source, "directory.mkv"));
  await expect(library.add(media({ sourcePath: "directory.mkv" }))).rejects.toThrow("file");
});
it("refuses overlapping roots and symlink output roots", async () => {
  const overlap = new MediaLibrary(() => ({ sourceRoot: source, exportRoot: path.join(source, "output") }));
  await expect(overlap.add(media())).rejects.toThrow("separate");
  await fs.mkdir(path.join(temporary, "elsewhere")); await fs.symlink(path.join(temporary, "elsewhere"), output);
  await expect(library.add(media())).rejects.toThrow("real directories");
});
it("refuses symlinked output parents instead of writing outside the library", async () => {
  await fs.mkdir(output); const outside = path.join(temporary, "outside"); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(output, "Movies"));
  await expect(library.add(media())).rejects.toThrow("real directories");
  expect(await fs.readdir(outside)).toEqual([]);
});
it("serializes duplicate exports and persists private metadata across restarts", async () => {
  const entries = await Promise.all(Array.from({ length: 8 }, () => library.add(media())));
  expect(new Set(entries.map(e => e.id)).size).toBe(1);
  expect((await fs.stat(path.join(output, ".media-library.json"))).mode & 0o777).toBe(0o600);
  const restarted = new MediaLibrary(() => ({ sourceRoot: source, exportRoot: output }));
  expect((await restarted.list()).entries[0].id).toBe(entries[0].id);
});
it("refuses source collisions and unmanaged files or symlinks", async () => {
  await library.add(media()); await fs.writeFile(path.join(source, "other.mkv"), "other video");
  await expect(library.add(media({ sourcePath: "other.mkv" }))).rejects.toThrow("another source");
  const unmanaged = media({ name: "Unmanaged" }), file = path.join(output, libraryPath(unmanaged));
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "keep me");
  await expect(library.add(unmanaged)).rejects.toThrow("outside this library");
  expect(await fs.readFile(file, "utf8")).toBe("keep me");
  await fs.unlink(file); await fs.symlink(path.join(source, "movie.mkv"), file);
  await expect(library.add(unmanaged)).rejects.toThrow("outside this library");
});
it("repairs missing links without deleting unavailable sources or replacing conflicts", async () => {
  const entry = await library.add(media()), file = path.join(output, entry.libraryPath);
  await fs.unlink(file); expect(await library.repair()).toEqual([{ id: entry.id, status: "repaired" }]);
  await fs.unlink(file); await fs.writeFile(file, "external replacement");
  expect(await library.repair()).toEqual([{ id: entry.id, status: "conflict" }]);
  await fs.unlink(path.join(source, "movie.mkv"));
  expect(await library.repair()).toEqual([{ id: entry.id, status: "unavailable" }]);
  expect(await fs.readFile(file, "utf8")).toBe("external replacement");
  expect((await library.list()).entries).toHaveLength(1);
});
it("survives a missing mount without erasing the manifest or exported links", async () => {
  const entry = await library.add(media());
  const before = await fs.readFile(path.join(output, ".media-library.json"), "utf8");
  await fs.rename(source, `${source}-offline`);
  await expect(library.repair()).rejects.toMatchObject({ status: 503 });
  expect(await fs.readFile(path.join(output, ".media-library.json"), "utf8")).toBe(before);
  expect((await fs.lstat(path.join(output, entry.libraryPath))).isSymbolicLink()).toBe(true);
});
it("removes only owned links and retains source files and unrelated entries", async () => {
  const entry = await library.add(media()), another = await library.add(media({ name: "Another" }));
  await library.remove(entry.id);
  await expect(fs.lstat(path.join(output, entry.libraryPath))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path.join(source, "movie.mkv"), "utf8")).toBe("video fixture");
  expect((await library.list()).entries.map(e => e.id)).toEqual([another.id]);
});
it("does not remove an externally replaced link or follow an output-parent symlink", async () => {
  const entry = await library.add(media()), file = path.join(output, entry.libraryPath);
  await fs.unlink(file); await fs.writeFile(file, "keep");
  await expect(library.remove(entry.id)).rejects.toThrow("changed externally");
  expect(await fs.readFile(file, "utf8")).toBe("keep");
  await fs.rename(path.join(output, "Movies"), path.join(output, "Movies-original"));
  await fs.symlink(path.join(output, "Movies-original"), path.join(output, "Movies"));
  await expect(library.remove(entry.id)).rejects.toThrow("real directories");
});
it("refuses corrupted manifests rather than assuming ownership of existing exports", async () => {
  const entry = await library.add(media());
  await fs.writeFile(path.join(output, ".media-library.json"), '{"version":1,"entries":[{"id":"bad"}]}');
  await expect(library.add(media({ name: "New" }))).rejects.toThrow("manifest is invalid");
  expect((await fs.lstat(path.join(output, entry.libraryPath))).isSymbolicLink()).toBe(true);
});
it("sanitizes scanner names, validates episode metadata and limits filename bytes", async () => {
  const entry = await library.add(media({ name: 'An: Example / Test? .. ' }));
  expect(entry.libraryPath).toBe("Movies/An Example Test (2024)/An Example Test (2024).mkv");
  await expect(library.add(media({ name: ".." }))).rejects.toThrow("usable");
  await expect(library.add(media({ type: "episode" }))).rejects.toThrow();
  const long = await library.add(media({ name: "映".repeat(160) }));
  expect(Buffer.byteLength(path.basename(long.libraryPath))).toBeLessThan(255);
});
it("requires admin access for filesystem APIs and handles disabled, invalid and valid requests", async () => {
  await resetDb();
  const signup = async (email: string) => (await request(app).post("/api/auth/signup").send({ email, password: "password123", displayName: "Library tester" })).body.token as string;
  const admin = await signup("library-admin@test.local"), user = await signup("library-user@test.local");
  const original = { source: config.mediaSourceRoot, output: config.mediaLibraryRoot };
  try {
    config.mediaSourceRoot = ""; config.mediaLibraryRoot = "";
    expect((await request(app).get("/api/admin/library")).status).toBe(401);
    expect((await request(app).post("/api/admin/library/entries").set(auth(user)).send(media())).status).toBe(403);
    expect((await request(app).get("/api/admin/library").set(auth(admin))).body.enabled).toBe(false);
    expect((await request(app).post("/api/admin/library/entries").set(auth(admin)).send(media())).status).toBe(503);
    config.mediaSourceRoot = source; config.mediaLibraryRoot = output;
    expect((await request(app).post("/api/admin/library/entries").set(auth(admin)).send(media({ type: "episode" }))).status).toBe(400);
    const added = await request(app).post("/api/admin/library/entries").set(auth(admin)).send(media());
    expect(added.status).toBe(201);
    expect((await request(app).get("/api/admin/library").set(auth(admin))).body.entries[0].linked).toBe(true);
    expect((await request(app).post("/api/admin/library/repair").set(auth(admin))).body.results[0].status).toBe("ready");
    expect((await request(app).delete(`/api/admin/library/entries/${added.body.entry.id}`).set(auth(admin))).status).toBe(200);
    expect((await request(app).delete(`/api/admin/library/entries/${added.body.entry.id}`).set(auth(admin))).status).toBe(404);
  } finally { config.mediaSourceRoot = original.source; config.mediaLibraryRoot = original.output; }
});
