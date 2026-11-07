// Test-only Node preload, copied only into NEW disposable QA volumes by the
// browser runner. This file is never included in a production image or app path.
if (process.env.QA_METADATA_FIXTURES !== "1") throw Error("Metadata transport fixture requires the disposable QA runner");
const fs = require("node:fs");
const originalFetch = globalThis.fetch;
const titles = [
  { id: 1001, imdb: "tt1254207", name: "Big Buck Bunny", year: 2008, runtime: 10 },
  { id: 1002, imdb: "tt1727587", name: "Sintel", year: 2010, runtime: 15 },
];
const synopsis = "Local protocol fixture for metadata workflow validation.";
const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const tmdb = title => ({ id: title.id, title: title.name, release_date: `${title.year}-01-01`, adult: false, overview: synopsis,
  poster_path: null, backdrop_path: null, genres: [{ id: 16, name: "Animation" }], runtime: title.runtime, vote_average: 7.4, vote_count: 5,
  credits: { cast: [{ name: "Demo performer" }] }, external_ids: { imdb_id: title.imdb } });
const omdb = title => ({ Response: "True", imdbID: title.imdb, Title: title.name, Year: String(title.year), Type: "movie", Plot: synopsis,
  Poster: "N/A", Genre: "Animation", Actors: "Demo performer", Runtime: `${title.runtime} min`, imdbRating: "7.4", Rated: "Not Rated" });
globalThis.fetch = async function(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "api.real-debrid.com") {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    fs.appendFileSync("/app/data/account-provider-requests.jsonl", JSON.stringify({ path: url.pathname, method }) + "\n", { mode: 0o600 });
    if (new Headers(init?.headers).get("Authorization") !== "Bearer account-fixture-only") return respond({ error: "bad_token" }, 401);
    const root = "/rest/1.0";
    const torrents = [
      { id: "qa-sintel", filename: "Sintel.2010.1080p.mp4", status: "downloaded", progress: 100 },
      { id: "qa-bunny", filename: "Big.Buck.Bunny.2008.1080p.mp4", status: "downloaded", progress: 100 },
    ];
    if (method === "GET" && url.pathname === root + "/user") return respond({ username: "Community fixture", email: "provider-fixture@example.invalid", type: "premium", premium: 1, expiration: "2030-01-01T00:00:00.000Z", points: 0 });
    if (method === "GET" && url.pathname === root + "/torrents") return respond(Number(url.searchParams.get("page") ?? 1) === 1 ? torrents : []);
    const info = new RegExp(`^${root}/torrents/info/(qa-sintel|qa-bunny)$`).exec(url.pathname);
    if (method === "GET" && info) {
      const base = torrents.find(item => item.id === info[1]), stem = info[1] === "qa-sintel" ? "Sintel.2010" : "Big.Buck.Bunny.2008";
      const files = [{ id: 1, path: `/${stem}.mp4`, bytes: 1682, selected: 1 }];
      if (info[1] === "qa-sintel") files.push({ id: 2, path: `/${stem}.Commentary.mp4`, bytes: 1682, selected: 1 });
      files.push({ id: 3, path: "/readme.nfo", bytes: 12, selected: 1 });
      return respond({ ...base, files, links: files.map(file => `https://hoster.example.invalid/${info[1]}/${file.id}`) });
    }
    if (method === "POST" && url.pathname === root + "/unrestrict/link") {
      const link = new URLSearchParams(String(init?.body ?? "")).get("link") ?? "";
      return respond({ download: "https://example.invalid/qa-account-video.mp4", filename: link.includes("/2") ? "Sintel.2010.Commentary.mp4" : "Sintel.2010.mp4", filesize: 1682, mimeType: "video/mp4" });
    }
    return respond({ error: "Disposable fixture refuses any unplanned provider operation" }, 405);
  }
  if (!["api.themoviedb.org", "www.omdbapi.com"].includes(url.hostname)) return originalFetch(input, init);
  let override = {};
  try { override = JSON.parse(fs.readFileSync("/app/data/metadata-qa-override.json", "utf8")); } catch {}
  if (Number.isFinite(override.delayMs)) await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(2000, override.delayMs))));
  fs.appendFileSync("/app/data/metadata-provider-requests.jsonl", JSON.stringify({ provider: url.hostname, path: url.pathname }) + "\n", { mode: 0o600 });
  if (url.hostname === "api.themoviedb.org") {
    if (new Headers(init?.headers).get("Authorization") !== "Bearer metadata-fixture-only") return respond({ success: false, status_code: 7 }, 401);
    if (url.pathname === "/3/authentication") return respond({ success: true });
    if (url.pathname === "/3/search/movie" || url.pathname === "/3/search/tv") {
      const query = (url.searchParams.get("query") ?? "").trim().toLowerCase();
      return respond({ results: url.pathname.endsWith("/tv") ? [] : titles.filter(title => title.name.toLowerCase() === query).map(tmdb) });
    }
    const external = /^\/3\/find\/(tt\d+)$/.exec(url.pathname);
    if (external) return respond({ movie_results: titles.filter(title => title.imdb === external[1]).map(tmdb), tv_results: [] });
    const detail = /^\/3\/movie\/(\d+)$/.exec(url.pathname), title = detail && titles.find(item => item.id === Number(detail[1]));
    return title ? respond({ ...tmdb(title), ...(typeof override.rating === "number" ? { vote_average: override.rating } : {}) }) : respond({ success: false, status_code: 34 }, 404);
  }
  if (url.searchParams.get("apikey") !== "metadata-fixture-only") return respond({ Response: "False", Error: "Invalid API key!" });
  const id = url.searchParams.get("i");
  if (id === "tt0109830") return respond(omdb({ id: 1003, imdb: id, name: "Connection test fixture", year: 1994, runtime: 142 }));
  if (id) { const title = titles.find(item => item.imdb === id); return title ? respond(omdb(title)) : respond({ Response: "False", Error: "Movie not found!" }); }
  const query = (url.searchParams.get("s") ?? "").trim().toLowerCase();
  const matches = url.searchParams.get("type") === "series" ? [] : titles.filter(title => title.name.toLowerCase() === query);
  return matches.length ? respond({ Response: "True", Search: matches.map(omdb), totalResults: String(matches.length) }) : respond({ Response: "False", Error: "Movie not found!" });
};
