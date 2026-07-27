import { afterEach, describe, expect, it, vi } from "vitest";
import { searchIndexer } from "../src/indexers/torznab";

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Sample Indexer</title>
    <item>
      <title>Some.Movie.2024.1080p.WEB-DL</title>
      <guid>abc123</guid>
      <link>magnet:?xt=urn:btih:aaaa&amp;dn=Some.Movie</link>
      <pubDate>Mon, 01 Jan 2024 00:00:00 +0000</pubDate>
      <torznab:attr name="size" value="2147483648" />
      <torznab:attr name="seeders" value="120" />
      <torznab:attr name="peers" value="140" />
    </item>
    <item>
      <title>Some.Show.S01.COMPLETE</title>
      <guid>def456</guid>
      <link>https://indexer.example/download/def456.torrent</link>
      <pubDate>Tue, 02 Jan 2024 00:00:00 +0000</pubDate>
      <enclosure url="https://indexer.example/download/def456.torrent" length="500000000" type="application/x-bittorrent" />
      <torznab:attr name="seeders" value="3" />
      <torznab:attr name="peers" value="5" />
    </item>
  </channel>
</rss>`;

afterEach(() => vi.unstubAllGlobals());

describe("searchIndexer (Torznab)", () => {
  const indexer = { id: "idx1", name: "Sample Indexer", baseUrl: "http://jackett.local/api", apiKey: "key123" };

  it("parses magnet and torrent-file items with size/seeders/peers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(SAMPLE_XML, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchIndexer(indexer, "some movie");
    expect(results).toHaveLength(2);

    const [magnetResult, torrentResult] = results;
    expect(magnetResult).toMatchObject({
      indexerId: "idx1",
      indexerName: "Sample Indexer",
      title: "Some.Movie.2024.1080p.WEB-DL",
      hasMagnet: true,
      sizeBytes: 2147483648,
      seeders: 120,
      peers: 140,
    });
    expect(magnetResult.link).toContain("magnet:?xt=urn:btih:aaaa");

    expect(torrentResult).toMatchObject({
      hasMagnet: false,
      sizeBytes: 500000000,
      seeders: 3,
      link: "https://indexer.example/download/def456.torrent",
    });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("t=search");
    expect(String(url)).toContain("apikey=key123");
    expect(String(url)).toContain("q=some+movie");
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    await expect(searchIndexer(indexer, "x")).rejects.toThrowError(/HTTP 500/);
  });

  it("respects the limit option", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(SAMPLE_XML, { status: 200 })));
    const results = await searchIndexer(indexer, "x", { limit: 1 });
    expect(results).toHaveLength(1);
  });
});
