import { expect, it } from "vitest";
import { chooseFile, FileSelectionRequired, InvalidFileSelection } from "../src/providers/files";
import { TorrentFile, TorrentStatus } from "../src/providers/types";
const file = (id: string, path: string): TorrentFile => ({ id, path, size: 100, link: `https://private-source.example/${id}` });
const status = (files: TorrentFile[]): TorrentStatus => ({ provider: "realdebrid", id: "ref", name: "Pack", phase: "finished", progress: 100, files, links: files.map(f => f.link) });
function choices(s: TorrentStatus, key = "account-source") {
  try { chooseFile("realdebrid", key, s); throw new Error("Expected file choices"); }
  catch (err) { expect(err).toBeInstanceOf(FileSelectionRequired); return (err as FileSelectionRequired).files; }
}
it("skips samples and non-video files when there is a single main video", () => {
  const movie = file("2", "Movie/Movie.mkv");
  expect(chooseFile("realdebrid", "key", status([file("1", "Movie/sample.mkv"), movie, file("3", "readme.txt")]))).toEqual(movie);
});
it("requires explicit selection for episode packs and never exposes provider links", () => {
  const s = status([file("1", "Show/S01E01.mp4"), file("2", "Show/S01E02.mkv")]);
  const list = choices(s);
  expect(list.map(f => f.name)).toEqual(["Show/S01E01.mp4", "Show/S01E02.mkv"]);
  expect(JSON.stringify(list)).not.toContain("private-source");
  expect(chooseFile("realdebrid", "account-source", s, list[1].token)).toEqual(s.files![1]);
});
it("binds file choices to account/source, reference, and file metadata", () => {
  const s = status([file("1", "one.mp4"), file("2", "two.mp4")]);
  const token = choices(s)[1].token;
  expect(() => chooseFile("realdebrid", "other-account", s, token)).toThrow(InvalidFileSelection);
  expect(() => chooseFile("realdebrid", "account-source", { ...s, id: "new-reference" }, token)).toThrow(InvalidFileSelection);
  expect(() => chooseFile("realdebrid", "account-source", status([file("1", "one.mp4"), file("2", "changed.mp4")]), token)).toThrow(InvalidFileSelection);
});
it("keeps choices stable when direct signed links rotate", () => {
  const s = status([file("1", "one.mp4"), file("2", "two.mp4")]);
  const token = choices(s)[1].token;
  s.files![1].link = "https://new-signed-link.example/file";
  expect(chooseFile("realdebrid", "account-source", s, token).link).toContain("new-signed-link");
});
it("does not auto-play a sample-only torrent", () => {
  expect(choices(status([file("1", "sample.mp4")]))[0].sample).toBe(true);
});
it("rejects empty or non-video content", () => {
  for (const files of [[], [file("1", "manual.pdf")], [file("1", "archive.rar")]]) expect(() => chooseFile("realdebrid", "key", status(files))).toThrow("No video files");
});
it("requires selection when older adapters supply multiple unnamed links", () => {
  const s = { ...status([]), files: undefined, links: ["https://host/one", "https://host/two"] };
  expect(choices(s)).toHaveLength(2);
});
it("fails explicitly instead of hiding files in oversized packs", () => {
  expect(() => chooseFile("realdebrid", "key", status(Array.from({ length: 501 }, (_, i) => file(String(i), `${i}.mp4`))))).toThrow("more than 500");
});
