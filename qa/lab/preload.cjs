// Lab only. Loaded into the API process (NODE_OPTIONS=--require) by qa/lab/start.cjs. It answers, inside the process, for the outside
// services the server talks to, so the whole product runs on one machine with no account and no network:
//   api.real-debrid.com  - a small account: finished torrents, one still downloading, magnets added by approved requests
//   api.themoviedb.org   - metadata for the lab's titles
//   Cinemeta, Wikidata   - refused at once (the lab uses the TMDB answers)
//   api.github.com       - one "latest release", so the update check has something to show
// Nothing here is part of the product or of any image.
if (process.env.STREAMRD_LAB !== "1") throw Error("qa/lab/preload.cjs is only for the local lab (STREAMRD_LAB=1)");
const fs = require("node:fs"), path = require("node:path");
const ORIGIN = process.env.LAB_ORIGIN, MEDIA = process.env.LAB_MEDIA, KEY = "lab-debrid-key-0123456789", TMDB_KEY = "lab-tmdb-key-0123456789";
const realFetch = globalThis.fetch;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const sizeOf = name => { try { return fs.statSync(path.join(MEDIA, name)).size; } catch { return 1000; } };

// ---- Real-Debrid
const torrent = (id, filename, files, extra = {}) => ({ id, filename, hash: id.padEnd(40, "0").slice(0, 40), status: "downloaded", progress: 100, added: "2026-01-01T00:00:00.000Z", files, ...extra });
const file = name => ({ path: `/${name}`, media: name });
const account = [
  torrent("LABBBB1080", "Big.Buck.Bunny.2008.1080p.BluRay.x264.DTS", [file("Big.Buck.Bunny.2008.1080p.BluRay.x264.DTS.mkv")]),
  torrent("LABBBB2160", "Big.Buck.Bunny.2008.2160p.WEB-DL.H264.AAC", [file("Big.Buck.Bunny.2008.2160p.WEB-DL.H264.AAC.mp4")]),
  torrent("LABSINTEL", "Sintel.2010.1080p.WEB-DL.H264.AAC", [file("Sintel.2010.1080p.WEB-DL.H264.AAC.mp4"), { path: "/readme.nfo", media: null }]),
  torrent("LABELEPH", "Elephants.Dream.2006.2160p.UHD.BluRay.HEVC.10bit.TrueHD", [file("Elephants.Dream.2006.2160p.UHD.BluRay.HEVC.10bit.TrueHD.mkv")]),
  torrent("LABTEARS", "Tears.of.Steel.2012.720p.DVDRip.XviD.MP3", [file("Tears.of.Steel.2012.720p.DVDRip.XviD.MP3.avi")]),
  torrent("LABSHOW", "Example.Show.S01.1080p.WEB.x264.AC3", [1, 2, 3].map(n => file(`Example.Show.S01E0${n}.1080p.WEB.x264.AC3.mkv`))),
  torrent("LABSPRING", "Spring.2019.1080p.WEB.x264.AAC", [file("Sintel.2010.1080p.WEB-DL.H264.AAC.mp4")], { status: "downloading", progress: 40 }),
];
// Magnets an approved request may add: info hash -> what appears in the account, finishing SECONDS after it was added.
const RELEASES = { "c0c0000000000000000000000000000000001080": "Cosmos.Laundromat.2015.1080p.WEB-DL.H264.AAC", "c0c0000000000000000000000000000000002160": "Cosmos.Laundromat.2015.2160p.UHD.BluRay.HEVC.DTS-HD" };
const SECONDS = Number(process.env.LAB_TRANSFER_SECONDS || 20);
const added = [];
const live = () => [...added.map(entry => {
  const progress = Math.min(100, Math.floor((Date.now() - entry.at) / (SECONDS * 10)));
  return torrent(entry.id, entry.name, [file("Cosmos.Laundromat.2015.1080p.WEB-DL.H264.AAC.mp4")], { status: progress >= 100 ? "downloaded" : "downloading", progress });
}), ...account];
const view = entry => ({ id: entry.id, filename: entry.filename, hash: entry.hash, bytes: entry.files.reduce((sum, item) => sum + (item.media ? sizeOf(item.media) : 12), 0), host: "real-debrid.com", split: 2000, progress: entry.progress, status: entry.status, added: entry.added,
  links: entry.status === "downloaded" ? entry.files.map((_item, index) => `https://real-debrid.com/d/${entry.id}x${index}`) : [] });
async function realDebrid(url, init, method) {
  if (new Headers(init?.headers).get("Authorization") !== `Bearer ${KEY}`) return json({ error: "bad_token", error_code: 8 }, 401);
  const route = url.pathname.replace(/^\/rest\/1\.0/, ""), body = new URLSearchParams(init?.body ? String(init.body) : "");
  if (method === "GET" && route === "/user") return json({ id: 1, username: "lab", email: "lab@example.invalid", points: 0, locale: "en", type: "premium", premium: 8640000, expiration: "2030-01-01T00:00:00.000Z" });
  if (method === "GET" && route === "/torrents") {
    const page = Number(url.searchParams.get("page") ?? 1), limit = Number(url.searchParams.get("limit") ?? 100), rows = live().slice((page - 1) * limit, page * limit);
    return rows.length ? json(rows.map(view)) : new Response(null, { status: 204 });
  }
  const info = /^\/torrents\/info\/([A-Za-z0-9]+)$/.exec(route);
  if (method === "GET" && info) {
    const entry = live().find(item => item.id === info[1]); if (!entry) return json({ error: "unknown_ressource", error_code: 7 }, 404);
    return json({ ...view(entry), files: entry.files.map((item, index) => ({ id: index + 1, path: item.path, bytes: item.media ? sizeOf(item.media) : 12, selected: 1 })) });
  }
  if (method === "POST" && route === "/torrents/addMagnet") {
    const hash = /btih:([a-f0-9]{40})/i.exec(body.get("magnet") ?? "")?.[1]?.toLowerCase(), name = hash && RELEASES[hash];
    if (!name) return json({ error: "magnet_conversion", error_code: 30 }, 400);
    const existing = added.find(entry => entry.hash === hash); if (existing) return json({ id: existing.id, uri: "" }, 201);
    const entry = { id: `LABREQ${added.length + 1}`, hash, name, at: Date.now() }; added.push(entry);
    return json({ id: entry.id, uri: "" }, 201);
  }
  if (method === "POST" && /^\/torrents\/selectFiles\/[A-Za-z0-9]+$/.test(route)) return new Response(null, { status: 204 });
  if (method === "POST" && route === "/unrestrict/link") {
    const match = /\/d\/([A-Za-z0-9]+)x(\d+)$/.exec(body.get("link") ?? ""), entry = match && live().find(item => item.id === match[1]), item = entry?.files[Number(match?.[2])];
    if (process.env.LAB_DEAD_LINKS?.split(",").includes(entry?.id)) return json({ error: "hoster_unavailable", error_code: 19 }, 503);
    if (!item?.media) return json({ error: "unavailable_file", error_code: 24 }, 404);
    return json({ id: "LABLINK", filename: item.media, mimeType: /\.mp4$/.test(item.media) ? "video/mp4" : /\.mkv$/.test(item.media) ? "video/x-matroska" : "video/x-msvideo", filesize: sizeOf(item.media), link: body.get("link"), host: "real-debrid.com", chunks: 16, crc: 1,
      download: `${ORIGIN}/media/${encodeURIComponent(item.media)}`, streamable: 1 });
  }
  return json({ error: "lab: unplanned Real-Debrid call", route, method }, 405);
}

// ---- TMDB
const TITLES = [
  { id: 10378, imdb: "tt1254207", name: "Big Buck Bunny", year: 2008, runtime: 10, rating: "G", genres: ["Animation", "Comedy"], overview: "A giant rabbit takes on three bullying rodents." },
  { id: 45745, imdb: "tt1727587", name: "Sintel", year: 2010, runtime: 15, rating: "PG-13", genres: ["Animation", "Fantasy"], overview: "A girl searches for the baby dragon she befriended." },
  { id: 9761, imdb: "tt0807840", name: "Elephants Dream", year: 2006, runtime: 11, rating: "PG", genres: ["Animation", "Science Fiction"], overview: "Two characters explore a strange machine world." },
  { id: 133701, imdb: "tt2285752", name: "Tears of Steel", year: 2012, runtime: 12, rating: "R", genres: ["Science Fiction"], overview: "Scientists try to save the world from robots in Amsterdam." },
  { id: 358332, imdb: "tt4957236", name: "Cosmos Laundromat", year: 2015, runtime: 12, rating: "PG", genres: ["Animation"], overview: "A suicidal sheep meets a mysterious salesman." },
  { id: 593910, imdb: "tt9812474", name: "Spring", year: 2019, runtime: 8, rating: "G", genres: ["Animation"], overview: "A shepherd girl and her dog face ancient spirits." },
  { id: 2001, imdb: "tt9992001", name: "Example Show", year: 2021, runtime: 45, rating: "TV-PG", genres: ["Drama"], overview: "A show that exists so the lab has episodes.", type: "series" },
];
const tmdbView = title => ({ id: title.id, title: title.name, name: title.name, original_title: title.name, original_name: title.name, release_date: `${title.year}-05-20`, first_air_date: `${title.year}-05-20`, episode_run_time: [title.runtime], runtime: title.runtime,
  adult: false, overview: title.overview, poster_path: null, backdrop_path: null, genres: title.genres.map((name, index) => ({ id: index + 1, name })), genre_ids: [], vote_average: 7.1, vote_count: 120, popularity: 10,
  credits: { cast: [{ name: "Lab Performer", character: "Lead", order: 0 }], crew: [{ name: "Lab Director", job: "Director" }] }, external_ids: { imdb_id: title.imdb },
  release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ certification: title.rating, type: 3 }] }] }, content_ratings: { results: [{ iso_3166_1: "US", rating: title.rating }] }, number_of_seasons: 1, number_of_episodes: 3 });
const isType = (title, tv) => (title.type === "series") === tv;
function tmdb(url, init) {
  const route = url.pathname.replace(/^\/3/, "");
  const key = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("api_key");
  if (key !== TMDB_KEY) return json({ success: false, status_code: 7, status_message: "Invalid API key" }, 401);
  if (route === "/authentication" || route === "/configuration") return json({ success: true });
  const search = /^\/search\/(movie|tv)$/.exec(route);
  if (search) {
    const words = (url.searchParams.get("query") ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(), year = Number(url.searchParams.get("year") ?? url.searchParams.get("first_air_date_year") ?? url.searchParams.get("primary_release_year") ?? 0);
    const results = TITLES.filter(title => isType(title, search[1] === "tv") && words && (title.name.toLowerCase().includes(words) || words.includes(title.name.toLowerCase())) && (!year || Math.abs(title.year - year) <= 1));
    return json({ page: 1, results: results.map(tmdbView), total_pages: 1, total_results: results.length });
  }
  const find = /^\/find\/(tt\d+)$/.exec(route);
  if (find) return json({ movie_results: TITLES.filter(title => title.imdb === find[1] && isType(title, false)).map(tmdbView), tv_results: TITLES.filter(title => title.imdb === find[1] && isType(title, true)).map(tmdbView) });
  const detail = /^\/(movie|tv)\/(\d+)(\/videos)?$/.exec(route), title = detail && TITLES.find(entry => entry.id === Number(detail[2]) && isType(entry, detail[1] === "tv"));
  if (title && detail[3]) return json({ id: title.id, results: [] });
  return title ? json(tmdbView(title)) : json({ success: false, status_code: 34, status_message: "Not found" }, 404);
}

globalThis.fetch = async function labFetch(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input)), method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (process.env.LAB_OUTBOUND_LOG && !["127.0.0.1", "localhost"].includes(url.hostname)) fs.appendFileSync(process.env.LAB_OUTBOUND_LOG, `${new Date().toISOString()} ${method} ${url.hostname}${url.pathname}${url.search.replace(/(api_?key|apikey)=[^&]+/gi, "$1=…")}\n`);
  if (url.hostname === "api.real-debrid.com") return realDebrid(url, init, method);
  if (url.hostname === "api.themoviedb.org") return tmdb(url, init);
  if (/(?:^|\.)strem\.io$|(?:^|\.)wikidata\.org$|(?:^|\.)omdbapi\.com$|(?:^|\.)youtube\.com$/.test(url.hostname)) return json({ error: "lab: offline" }, 503);
  if (url.hostname === "api.github.com") return json({ tag_name: process.env.LAB_LATEST_RELEASE || "v0.99.0", published_at: "2026-11-01T00:00:00Z", html_url: "https://github.com/Installation-04/StreamRD/releases/tag/v0.99.0" });
  if (["127.0.0.1", "localhost"].includes(url.hostname)) return realFetch(input, init);
  return json({ error: `lab: no network (${url.hostname})` }, 503);
};
