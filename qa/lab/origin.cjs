// Lab only. The "internet" of the lab: the video files a debrid link resolves to (with range requests), and a Torznab indexer.
const fs = require("node:fs"), http = require("node:http"), path = require("node:path");
const MEDIA = process.env.LAB_MEDIA, PORT = Number(process.env.LAB_ORIGIN_PORT || 47990);
const RELEASES = [
  { title: "Cosmos.Laundromat.2015.1080p.WEB-DL.H264.AAC-LAB", hash: "c0c0000000000000000000000000000000001080", size: 1_400_000_000, seeders: 45 },
  { title: "Cosmos.Laundromat.2015.2160p.UHD.BluRay.HEVC.DTS-HD-LAB", hash: "c0c0000000000000000000000000000000002160", size: 14_000_000_000, seeders: 80 },
  { title: "Cosmos.Laundromat.2015.HDCAM.x264-LAB", hash: "c0c00000000000000000000000000000000000ca", size: 700_000_000, seeders: 300 },
  { title: "Cosmos.Laundromat.2.2019.1080p.WEB.H264-LAB", hash: "c0c0000000000000000000000000000000000002", size: 1_500_000_000, seeders: 200 },
  { title: "Cosmos.2014.1080p.BluRay.x264-LAB", hash: "c0c0000000000000000000000000000000002014", size: 9_000_000_000, seeders: 150 },
  { title: "The.Matrix.1999.1080p.BluRay.x264-LAB", hash: "a0a0000000000000000000000000000000001999", size: 9_000_000_000, seeders: 500 },
];
const xml = value => String(value).replace(/[<>&"]/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[char]));
const item = release => `<item><title>${xml(release.title)}</title><guid>${release.hash}</guid><size>${release.size}</size><link>${xml(`magnet:?xt=urn:btih:${release.hash}&dn=${release.title}`)}</link>` +
  `<torznab:attr name="seeders" value="${release.seeders}"/><torznab:attr name="infohash" value="${release.hash}"/><torznab:attr name="size" value="${release.size}"/></item>`;
http.createServer((req, res) => {
  const url = new URL(req.url, "http://lab");
  if (url.pathname === "/torznab/api") {
    if (url.searchParams.get("apikey") !== "lab-indexer-key") { res.writeHead(401).end("<error code=\"100\" description=\"Incorrect user credentials\"/>"); return; }
    const words = (url.searchParams.get("q") ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const found = RELEASES.filter(release => words.every(word => release.title.toLowerCase().includes(word)));
    res.writeHead(200, { "Content-Type": "application/rss+xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Lab indexer</title>${found.map(item).join("")}</channel></rss>`);
    return;
  }
  const name = path.basename(decodeURIComponent(url.pathname.replace(/^\/media\//, ""))), file = path.join(MEDIA, name);
  if (!url.pathname.startsWith("/media/") || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  const size = fs.statSync(file).size, range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? ""), start = range ? Number(range[1]) : 0, end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size) { res.writeHead(416, { "Content-Range": `bytes */${size}` }).end(); return; }
  const type = /\.mp4$/.test(name) ? "video/mp4" : /\.mkv$/.test(name) ? "video/x-matroska" : "application/octet-stream";
  res.writeHead(range ? 206 : 200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Access-Control-Allow-Origin": "*", ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) });
  if (req.method === "HEAD") { res.end(); return; }
  fs.createReadStream(file, { start, end }).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`lab origin on :${PORT}`));
