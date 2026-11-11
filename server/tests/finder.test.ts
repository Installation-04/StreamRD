import { beforeEach, expect, it } from "vitest";
import { matchesTitle, parseTorznab, rank, Raw } from "../src/requests/finder";

const raw = (title: string, over: Partial<Raw> = {}): Raw => ({ title, hash: "a".repeat(40), magnet: null, sizeBytes: 4 * 1024 ** 3, seeders: 50, source: "Test", ...over });
const movie = { name: "Crank", year: 2006, type: "movie" as const }, show = { name: "Breaking Bad", year: 2008, type: "series" as const };
let n = 0; const hashed = (title: string, over: Partial<Raw> = {}) => raw(title, { hash: (++n).toString(16).padStart(40, "0"), ...over });

it("matches the wanted title and not its sequels or other years", () => {
  expect(matchesTitle(movie, "Crank 2006 1080p BluRay x264")).toBe(true);
  expect(matchesTitle(movie, "Crank.2006.Directors.Cut.1080p.BluRay.DTS.x264-CtrlHD.mkv")).toBe(true);
  expect(matchesTitle(movie, "Crank High Voltage 2009 1080p BluRay")).toBe(false);
  expect(matchesTitle(movie, "Crank High Voltage 1080p BluRay")).toBe(false);
  expect(matchesTitle(movie, "Crank 2012 1080p")).toBe(false);
  expect(matchesTitle(movie, "Crank 1080p BluRay")).toBe(true);
  expect(matchesTitle({ name: "Mr. Morfina", year: 2025, type: "movie" }, "Mr Morfina 2025 720p WEB-DL")).toBe(true);
  expect(matchesTitle(show, "Breaking.Bad.S01.1080p.BluRay.x264")).toBe(true);
});

it("ranks for what plays in a browser, drops fakes and single episodes, and picks a pack for a show", () => {
  const ranked = rank(movie, [hashed("Crank 2006 2160p UHD BluRay HEVC TrueHD Atmos", { sizeBytes: 60 * 1024 ** 3 }), hashed("Crank 2006 1080p WEB-DL H264 AAC"), hashed("Crank 2006 720p HDTV x264", { seeders: 5 }), hashed("Crank 2006 HDCAM x264"), hashed("Crank 2006 1080p BluRay x264", { sizeBytes: 50 * 1024 ** 2 }), hashed("Crank High Voltage 2009 1080p BluRay")]);
  expect(ranked.map(c => c.title)[0]).toBe("Crank 2006 1080p WEB-DL H264 AAC");
  expect(ranked.some(c => /HDCAM|High Voltage/.test(c.title))).toBe(false);
  const tv = rank(show, [hashed("Breaking Bad S01E01 1080p WEB-DL"), hashed("Breaking Bad S01 1080p BluRay x264"), hashed("Breaking Bad Complete Series 720p BluRay")]);
  expect(tv.every(c => c.pack)).toBe(true); expect(tv[0].title).toBe("Breaking Bad S01 1080p BluRay x264");
});

it("keeps one entry per info hash, builds a magnet from a bare hash, and refuses what is not a magnet", () => {
  const one = rank(movie, [raw("Crank 2006 720p WEB-DL", { hash: "b".repeat(40) }), raw("Crank 2006 1080p WEB-DL", { hash: "b".repeat(40) })]);
  expect(one).toHaveLength(1); expect(one[0].title).toContain("1080p"); expect(one[0].magnet).toBe(`magnet:?xt=urn:btih:${"b".repeat(40)}&dn=${encodeURIComponent("Crank 2006 1080p WEB-DL")}`);
  expect(rank(movie, [raw("Crank 2006 1080p", { hash: null, magnet: "http://evil.example/a.torrent" }), raw("Crank 2006 1080p", { hash: "zz" })])).toEqual([]);
});

it("reads a Torznab feed, including hash-only items, CDATA and entities", () => {
  const xml = `<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>
    <item><title><![CDATA[Crank.2006.1080p.BluRay.x264 &amp; more]]></title><link>magnet:?xt=urn:btih:${"c".repeat(40)}&amp;dn=Crank</link><torznab:attr name="seeders" value="12"/><torznab:attr name="size" value="4294967296"/></item>
    <item><title>Crank 2006 720p</title><torznab:attr name="infohash" value="${"D".repeat(40)}"/></item>
    <item><title>No hash here</title><link>https://example.com/file.torrent</link></item></channel></rss>`;
  const items = parseTorznab(xml, "Feed");
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({ title: "Crank.2006.1080p.BluRay.x264 & more", hash: "c".repeat(40), seeders: 12, sizeBytes: 4294967296, source: "Feed" });
  expect(items[0].magnet).toContain("magnet:?xt=urn:btih:"); expect(items[1]).toMatchObject({ hash: "d".repeat(40), magnet: null });
});
beforeEach(() => { n = 0; });
