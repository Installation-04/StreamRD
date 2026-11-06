import { afterEach, expect, it, vi } from "vitest";
import { RealDebridProvider } from "../src/providers/realdebrid";
import { AllDebridProvider } from "../src/providers/alldebrid";
import { PremiumizeProvider } from "../src/providers/premiumize";
const creds = { apiKey: "fixture-key" };
function responses(...bodies: unknown[]) {
  const mock = vi.fn();
  for (const body of bodies) mock.mockResolvedValueOnce(new Response(JSON.stringify(body)));
  vi.stubGlobal("fetch", mock); return mock;
}
afterEach(() => vi.unstubAllGlobals());
it("maps RD links to selected files rather than all file positions", async () => {
  responses({ id: "ref", filename: "Pack", status: "downloaded", progress: 100, links: ["https://host/video"], files: [{ id: 1, path: "/readme.txt", bytes: 4, selected: 0 }, { id: 2, path: "/episode.mkv", bytes: 100, selected: 1 }] });
  const status = await new RealDebridProvider().getTorrentStatus(creds, "ref");
  expect(status.files).toEqual([{ id: "2", path: "/episode.mkv", size: 100, link: "https://host/video" }]);
});
it("does not guess an RD mapping with inconsistent selected-file counts", async () => {
  responses({ id: "ref", filename: "Pack", status: "downloaded", progress: 100, links: ["https://host/video"], files: [{ id: 1, path: "one.mp4", bytes: 1, selected: 1 }, { id: 2, path: "two.mp4", bytes: 1, selected: 1 }] });
  expect((await new RealDebridProvider().getTorrentStatus(creds, "ref")).files).toEqual([]);
});
it("loads and flattens the AllDebrid file tree", async () => {
  const mock = responses({ status: "success", data: { magnets: { id: 99, filename: "Pack", statusCode: 4, size: 10, downloaded: 10 } } }, { status: "success", data: { magnets: [{ id: 99, files: [{ n: "Season 1", e: [{ n: "E01.mp4", s: 123, l: "https://ad/file1" }, { n: "E02.mkv", s: 234, l: "https://ad/file2" }] }] }] } });
  const status = await new AllDebridProvider().getTorrentStatus(creds, "99");
  expect(status.files?.map(f => f.path)).toEqual(["Season 1/E01.mp4", "Season 1/E02.mkv"]);
  expect(mock.mock.calls[1][1].body.get("id[]")).toBe("99");
});
it("avoids file-list requests for unfinished AllDebrid magnets", async () => {
  const mock = responses({ status: "success", data: { magnets: { id: 99, filename: "Pack", statusCode: 1, size: 10, downloaded: 2 } } });
  expect((await new AllDebridProvider().getTorrentStatus(creds, "99")).phase).toBe("downloading");
  expect(mock).toHaveBeenCalledTimes(1);
});
it("resolves a finished Premiumize single-file transfer to a direct link", async () => {
  responses({ status: "success", transfers: [{ id: "ref", name: "Movie", status: "finished", progress: 1, file_id: "file" }] }, { status: "success", id: "file", name: "movie.mp4", size: 100, link: "https://cdn/movie" });
  const status = await new PremiumizeProvider().getTorrentStatus(creds, "ref");
  expect(status.files).toEqual([{ id: "file", path: "movie.mp4", size: 100, link: "https://cdn/movie", direct: true }]);
});
it("resolves nested Premiumize folders, preserving file paths", async () => {
  responses({ status: "success", transfers: [{ id: "ref", name: "Pack", status: "seeding", progress: 1, folder_id: "root" }] }, { status: "success", content: [{ id: "child", name: "Season 1", type: "folder" }] }, { status: "success", content: [{ id: "file", name: "E01.mkv", type: "file", size: 100, link: "https://cdn/episode" }] });
  expect((await new PremiumizeProvider().getTorrentStatus(creds, "ref")).files?.[0]).toMatchObject({ path: "Season 1/E01.mkv", direct: true });
});
it("returns 404 for removed Premiumize references", async () => {
  responses({ status: "success", transfers: [] });
  await expect(new PremiumizeProvider().getTorrentStatus(creds, "missing")).rejects.toMatchObject({ statusCode: 404 });
});
