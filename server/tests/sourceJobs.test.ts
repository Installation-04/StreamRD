import { afterEach, beforeEach, expect, it, vi } from "vitest";
import request from "supertest";
import { db } from "../src/db";
import { SourceJobs } from "../src/providers/sourceJobs";
import { providers } from "../src/providers/registry";
import { app, auth, resetDb, signup, TestUser } from "./helpers";
let user: TestUser;
const creds = { apiKey: "private-test-key" };
const source = "magnet:?xt=urn:btih:test";
const queued = { provider: "realdebrid" as const, id: "saved-ref", name: "movie", phase: "queued" as const, progress: 20, links: [] };
beforeEach(async () => { await resetDb(); user = await signup(); });
afterEach(() => vi.restoreAllMocks());
it("persists pending references and resumes after a new resolver instance", async () => {
  const add = vi.spyOn(providers.realdebrid, "addTorrent").mockResolvedValue(queued);
  const poll = vi.spyOn(providers.realdebrid, "getTorrentStatus").mockResolvedValue({ ...queued, phase: "finished", links: ["https://host/file"] });
  vi.spyOn(providers.realdebrid, "unrestrictLink").mockResolvedValue({ provider: "realdebrid", url: "https://stream/file", filename: "movie.mp4" });
  await expect(new SourceJobs().resolve(user.id, "realdebrid", creds, source)).rejects.toThrow("not ready");
  expect(await new SourceJobs().resolve(user.id, "realdebrid", creds, source)).toMatchObject({ url: "https://stream/file" });
  expect(add).toHaveBeenCalledTimes(1);
  expect(poll).toHaveBeenCalledWith(creds, "saved-ref");
  expect(JSON.stringify(await db.playbackSourceJob.findMany())).not.toContain("private-test-key");
});
it("coalesces simultaneous requests", async () => {
  const add = vi.spyOn(providers.realdebrid, "addTorrent").mockResolvedValue(queued);
  const jobs = new SourceJobs();
  const results = await Promise.allSettled([jobs.resolve(user.id, "realdebrid", creds, source), jobs.resolve(user.id, "realdebrid", creds, source)]);
  expect(results.map(r => r.status)).toEqual(["rejected", "rejected"]);
  expect(add).toHaveBeenCalledTimes(1);
});
it("isolates users and changed credentials", async () => {
  const other = await signup();
  const add = vi.spyOn(providers.realdebrid, "addTorrent").mockResolvedValue(queued);
  const jobs = new SourceJobs();
  for (const [id, key] of [[user.id, creds.apiKey], [other.id, creds.apiKey], [user.id, "new-key"]]) {
    await expect(jobs.resolve(id, "realdebrid", { apiKey: key }, source)).rejects.toThrow("not ready");
  }
  expect(add).toHaveBeenCalledTimes(3);
});
it("recreates expired references and recovers abandoned leases", async () => {
  const add = vi.spyOn(providers.realdebrid, "addTorrent").mockResolvedValue(queued);
  await expect(new SourceJobs().resolve(user.id, "realdebrid", creds, source)).rejects.toThrow();
  await db.playbackSourceJob.updateMany({ data: { expiresAt: new Date(0), leaseUntil: new Date(0) } });
  await expect(new SourceJobs().resolve(user.id, "realdebrid", creds, source)).rejects.toThrow("not ready");
  expect(add).toHaveBeenCalledTimes(2);
});
it("does not add another torrent while another worker holds its lease", async () => {
  vi.spyOn(providers.realdebrid, "addTorrent").mockResolvedValue(queued);
  await expect(new SourceJobs().resolve(user.id, "realdebrid", creds, source)).rejects.toThrow();
  await db.playbackSourceJob.updateMany({ data: { leaseUntil: new Date(Date.now() + 60000) } });
  const poll = vi.spyOn(providers.realdebrid, "getTorrentStatus");
  await expect(new SourceJobs().resolve(user.id, "realdebrid", creds, source)).rejects.toThrow("not ready");
  expect(poll).not.toHaveBeenCalled();
});

it("keeps pending responses compatible and completes through the existing API", async () => {
  const title = await db.title.create({ data: { name: "Pending Movie", sources: JSON.stringify([{ kind: "magnet", url: source }]) } });
  await db.debridConfig.update({ where: { userId: user.id }, data: { realDebridToken: creds.apiKey } });
  const add = vi.spyOn(providers.realdebrid, "addTorrent").mockResolvedValue(queued);
  const first = await request(app).post("/api/play").set(auth(user.token)).send({ titleId: title.id });
  expect(first.status).toBe(502);
  expect(first.body).toMatchObject({ pending: true, retryAfterMs: 5000, progress: 20 });
  expect(first.body.error).toContain("not ready");
  expect(await db.playbackLog.count()).toBe(0);
  vi.spyOn(providers.realdebrid, "getTorrentStatus").mockResolvedValue({ ...queued, phase: "finished", links: ["https://host/file"] });
  vi.spyOn(providers.realdebrid, "unrestrictLink").mockResolvedValue({ provider: "realdebrid", url: "https://stream/file", filename: "movie.mp4" });
  const second = await request(app).post("/api/play").set(auth(user.token)).send({ titleId: title.id });
  expect(second.status).toBe(200);
  expect(second.body.stream.url).toBe("https://stream/file");
  expect(add).toHaveBeenCalledTimes(1);
  expect(await db.playbackLog.count({ where: { success: true } })).toBe(1);
});
it("coordinates independent workers while an upstream add is in flight", async () => {
  let finish!: (value: typeof queued) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const add = vi.spyOn(providers.realdebrid, "addTorrent").mockImplementation(() => {
    entered();
    return new Promise(resolve => { finish = resolve; });
  });
  const first = new SourceJobs().resolve(user.id, "realdebrid", creds, source);
  const firstResult = expect(first).rejects.toThrow("not ready");
  await started;
  await expect(new SourceJobs().resolve(user.id, "realdebrid", creds, source)).rejects.toThrow("not ready");
  finish(queued);
  await firstResult;
  expect(add).toHaveBeenCalledTimes(1);
});
it("keeps references on transient errors but resets removed torrents", async () => {
  const add = vi.spyOn(providers.realdebrid, "addTorrent").mockResolvedValue(queued);
  const jobs = new SourceJobs();
  await expect(jobs.resolve(user.id, "realdebrid", creds, source)).rejects.toThrow("not ready");
  const { ProviderError } = await import("../src/providers/types");
  const poll = vi.spyOn(providers.realdebrid, "getTorrentStatus").mockRejectedValue(new ProviderError("realdebrid", "unavailable", 503));
  await expect(jobs.resolve(user.id, "realdebrid", creds, source)).rejects.toThrow("unavailable");
  expect((await db.playbackSourceJob.findFirstOrThrow()).providerRef).toBe("saved-ref");
  poll.mockRejectedValue(new ProviderError("realdebrid", "removed", 404));
  await expect(jobs.resolve(user.id, "realdebrid", creds, source)).rejects.toThrow("removed");
  expect((await db.playbackSourceJob.findFirstOrThrow()).providerRef).toBeNull();
  await expect(jobs.resolve(user.id, "realdebrid", creds, source)).rejects.toThrow("not ready");
  expect(add).toHaveBeenCalledTimes(2);
});
it("requires a choice for multi-video torrents and resolves the chosen file without re-adding", async () => {
  const title = await db.title.create({ data: { name: "Episode pack", sources: JSON.stringify([{ kind: "magnet", url: source }]) } });
  await db.debridConfig.update({ where: { userId: user.id }, data: { realDebridToken: creds.apiKey } });
  const files = [
    { id: "1", path: "sample.mp4", size: 1, link: "https://private/sample" },
    { id: "2", path: "S01E01.mp4", size: 100, link: "https://private/episode1" },
    { id: "3", path: "S01E02.mkv", size: 200, link: "https://private/episode2" },
  ];
  const ready = { ...queued, phase: "finished" as const, progress: 100, files, links: files.map(f => f.link) };
  const add = vi.spyOn(providers.realdebrid, "addTorrent").mockResolvedValue(ready);
  vi.spyOn(providers.realdebrid, "getTorrentStatus").mockResolvedValue(ready);
  const unlock = vi.spyOn(providers.realdebrid, "unrestrictLink").mockResolvedValue({ provider: "realdebrid", url: "https://stream/episode2", filename: "S01E02.mkv" });
  const first = await request(app).post("/api/play").set(auth(user.token)).send({ titleId: title.id });
  expect(first.status).toBe(409);
  expect(first.body).toMatchObject({ selectionRequired: true, provider: "realdebrid", sourceIndex: 0 });
  expect(JSON.stringify(first.body)).not.toContain("https://private");
  expect(unlock).not.toHaveBeenCalled();
  expect(await db.playbackLog.count()).toBe(0);
  const fileToken = first.body.files.find((file: { name: string }) => file.name === "S01E02.mkv").token;
  const selected = await request(app).post("/api/play").set(auth(user.token)).send({ titleId: title.id, sourceIndex: 0, selection: { provider: "realdebrid", fileToken } });
  expect(selected.status).toBe(200);
  expect(unlock).toHaveBeenCalledWith(expect.anything(), "https://private/episode2");
  expect(add).toHaveBeenCalledTimes(1);
  const invalid = await request(app).post("/api/play").set(auth(user.token)).send({ titleId: title.id, sourceIndex: 0, selection: { provider: "realdebrid", fileToken: "0".repeat(64) } });
  expect(invalid.status).toBe(409);
  expect(unlock).toHaveBeenCalledTimes(1);
  const missingSource = await request(app).post("/api/play").set(auth(user.token)).send({ titleId: title.id, selection: { provider: "realdebrid", fileToken } });
  expect(missingSource.status).toBe(400);
});
it("returns Premiumize cloud links directly instead of passing them through directdl again", async () => {
  const files = [{ id: "1", path: "movie.mp4", link: "https://cdn/movie", size: 100, direct: true }];
  vi.spyOn(providers.premiumize, "addTorrent").mockResolvedValue({ ...queued, provider: "premiumize", phase: "finished", files, links: [files[0].link] });
  const unlock = vi.spyOn(providers.premiumize, "unrestrictLink");
  const result = await new SourceJobs().resolve(user.id, "premiumize", creds, source);
  expect(result).toMatchObject({ url: "https://cdn/movie", filename: "movie.mp4", filesize: 100 });
  expect(unlock).not.toHaveBeenCalled();
});
it("does not reuse a file token across accounts or catalog sources", async () => {
  const title = await db.title.create({ data: { name: "Pack", sources: JSON.stringify([{ kind: "magnet", url: source }, { kind: "magnet", url: source + "-other" }]) } });
  const other = await signup();
  await db.debridConfig.updateMany({ data: { realDebridToken: creds.apiKey } });
  const files = [{ id: "1", path: "one.mp4", link: "https://private/one" }, { id: "2", path: "two.mp4", link: "https://private/two" }];
  const ready = { ...queued, phase: "finished" as const, files, links: files.map(file => file.link) };
  vi.spyOn(providers.realdebrid, "addTorrent").mockResolvedValue(ready);
  vi.spyOn(providers.realdebrid, "getTorrentStatus").mockResolvedValue(ready);
  const unlock = vi.spyOn(providers.realdebrid, "unrestrictLink");
  const first = await request(app).post("/api/play").set(auth(user.token)).send({ titleId: title.id });
  expect(first.status).toBe(409);
  const selection = { provider: "realdebrid", fileToken: first.body.files[1].token };
  const crossUser = await request(app).post("/api/play").set(auth(other.token)).send({ titleId: title.id, sourceIndex: 0, selection });
  const crossSource = await request(app).post("/api/play").set(auth(user.token)).send({ titleId: title.id, sourceIndex: 1, selection });
  expect(crossUser.status).toBe(409); expect(crossSource.status).toBe(409);
  expect(unlock).not.toHaveBeenCalled();
});
