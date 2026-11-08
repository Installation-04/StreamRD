// Test-only Node preload, copied only into NEW disposable QA volumes by the
// browser runner. This file is never included in a production image or app path.
if (process.env.QA_METADATA_FIXTURES !== "1") throw Error("Metadata transport fixture requires the disposable QA runner");
const fs = require("node:fs");
const originalFetch = globalThis.fetch;
const titles = [
  { id: 1001, imdb: "tt1254207", name: "Big Buck Bunny", year: 2008, runtime: 10 },
  { id: 1002, imdb: "tt1727587", name: "Sintel", year: 2010, runtime: 15 },
  { id: 1003, imdb: "tt0807840", name: "Elephants Dream", year: 2006, runtime: 11 },
  { id: 1004, imdb: "tt9990004", name: "Request Local Fixture", year: 2020, runtime: 1 },
  { id: 2001, imdb: "tt9992001", name: "Request Series Fixture", year: 2021, runtime: 45, type: "series" },
];
const synopsis = "Local protocol fixture for metadata workflow validation.";
const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const tmdb = title => ({ id: title.id, title: title.name, name: title.name, release_date: `${title.year}-01-01`, first_air_date: `${title.year}-01-01`, episode_run_time: [title.runtime], adult: false, overview: synopsis,
  poster_path: null, backdrop_path: null, genres: [{ id: 16, name: "Animation" }], runtime: title.runtime, vote_average: 7.4, vote_count: 5,
  credits: { cast: [{ name: "Demo performer" }] }, external_ids: { imdb_id: title.imdb } });
const omdb = title => ({ Response: "True", imdbID: title.imdb, Title: title.name, Year: String(title.year), Type: title.type ?? "movie", Plot: synopsis,
  Poster: "N/A", Genre: "Animation", Actors: "Demo performer", Runtime: `${title.runtime} min`, imdbRating: "7.4", Rated: "Not Rated" });
// Acquisition state is deliberately separate from original read-only library fixtures.
// Only explicit admin-approved fixture magnets can add a transfer. No real service
// can be contacted through these hostnames or recorded test keys.
const requestStateFile = "/app/data/request-qa-state.json";
function requestState() {
  try { return JSON.parse(fs.readFileSync(requestStateFile, "utf8")); } catch { return { cloudAdded: false, localAdded: false, localTag: null }; }
}
function requestOverride() {
  try { return JSON.parse(fs.readFileSync("/app/data/request-qa-override.json", "utf8")); } catch { return {}; }
}
function saveRequestState(state) { fs.writeFileSync(requestStateFile, JSON.stringify(state), { mode: 0o600 }); }
function fixtureProgress(kind) {
  const value = requestOverride()[`${kind}Progress`];
  return typeof value === "number" ? Math.max(0, Math.min(100, value)) : kind === "cloud" ? 37 : 42;
}
function bodyValue(init, field) {
  return init?.body && typeof init.body.get === "function" ? init.body.get(field) : new URLSearchParams(String(init?.body ?? "")).get(field);
}
const CLOUD_HASH = "1111111111111111111111111111111111111111";
const LOCAL_HASH = "2222222222222222222222222222222222222222";
globalThis.fetch = async function(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "qbit.fixture.invalid") {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    fs.appendFileSync("/app/data/request-client-requests.jsonl", JSON.stringify({ path: url.pathname, method }) + "\n", { mode: 0o600 });
    if (url.pathname === "/api/v2/auth/login" && method === "POST") {
      if (bodyValue(init, "username") !== "fakeuser" || bodyValue(init, "password") !== "qbit-fixture-only") return new Response("Fails.", { status: 200 });
      return new Response("Ok.", { headers: { "Set-Cookie": "SID=0123456789abcdef0123456789abcdef; HttpOnly; path=/" } });
    }
    if (!new Headers(init?.headers).get("Cookie")?.includes("SID=0123456789abcdef0123456789abcdef")) return new Response("Forbidden", { status: 403 });
    if (url.pathname === "/api/v2/app/version" && method === "GET") return new Response("v5.0.4");
    if (url.pathname === "/api/v2/app/webapiVersion" && method === "GET") return new Response("2.11.4");
    if (url.pathname === "/api/v2/torrents/add" && method === "POST") {
      const magnet = String(bodyValue(init, "urls") ?? "");
      if (!magnet.toLowerCase().includes(`urn:btih:${LOCAL_HASH}`)) return new Response("Fixture refuses unplanned torrent", { status: 400 });
      const state = requestState();
      if (state.localAdded) return new Response("Fixture refuses duplicate add", { status: 409 });
      saveRequestState({ ...state, localAdded: true, localTag: bodyValue(init, "tags") ?? "" });
      return new Response("Ok.");
    }
    if (url.pathname === "/api/v2/torrents/info" && ["GET", "POST"].includes(method)) {
      const state = requestState(), hashes = url.searchParams.get("hashes") ?? bodyValue(init, "hashes");
      if (!state.localAdded || (hashes && hashes !== LOCAL_HASH)) return respond([]);
      const progress = fixtureProgress("local") / 100;
      return respond([{ hash: LOCAL_HASH, name: "Request.Local.Fixture.2020.mp4", progress,
        state: progress >= 1 ? "uploading" : "downloading", tags: state.localTag,
        size: 1682, total_size: 1682, downloaded: Math.floor(progress * 1682), amount_left: Math.ceil((1 - progress) * 1682),
        completion_on: progress >= 1 ? 1700000000 : -1, save_path: "/fixture-local-downloads" }]);
    }
    return new Response("Disposable fixture refuses unplanned qBittorrent operation", { status: 405 });
  }
  if (url.hostname === "api.real-debrid.com") {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    fs.appendFileSync("/app/data/account-provider-requests.jsonl", JSON.stringify({ path: url.pathname, method }) + "\n", { mode: 0o600 });
    if (new Headers(init?.headers).get("Authorization") !== "Bearer account-fixture-only") return respond({ error: "bad_token" }, 401);
    const root = "/rest/1.0";
    const torrents = [
      { id: "qa-sintel", filename: "Sintel.2010.1080p.mp4", status: "downloaded", progress: 100 },
      { id: "qa-bunny", filename: "Big.Buck.Bunny.2008.1080p.mp4", status: "downloaded", progress: 100 },
    ];
    const acquisition = requestState();
    if (acquisition.cloudAdded) {
      const progress = fixtureProgress("cloud");
      torrents.push({ id: "qa-request-cloud", filename: "Elephants.Dream.2006.1080p.mp4", status: progress >= 100 ? "downloaded" : "downloading", progress });
    }
    if (method === "POST" && url.pathname === root + "/torrents/addMagnet") {
      const magnet = String(bodyValue(init, "magnet") ?? "");
      if (!magnet.toLowerCase().includes(`urn:btih:${CLOUD_HASH}`)) return respond({ error: "Fixture refuses unplanned torrent" }, 400);
      if (acquisition.cloudAdded) return respond({ error: "Fixture refuses duplicate add" }, 409);
      saveRequestState({ ...acquisition, cloudAdded: true });
      return respond({ id: "qa-request-cloud" });
    }
    if (method === "POST" && url.pathname === root + "/torrents/selectFiles/qa-request-cloud") return new Response(null, { status: 204 });
    if (method === "GET" && url.pathname === root + "/torrents/info/qa-request-cloud" && acquisition.cloudAdded) {
      const base = torrents.find(item => item.id === "qa-request-cloud"), files = [{ id: 1, path: "/Elephants.Dream.2006.mp4", bytes: 1682, selected: 1 }];
      return respond({ ...base, files, links: base.progress >= 100 ? ["https://hoster.example.invalid/qa-request-cloud/1"] : [] });
    }
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
      return respond({ download: "https://example.invalid/qa-account-video.mp4", filename: link.includes("qa-request-cloud") ? "Elephants.Dream.2006.mp4" : link.includes("/2") ? "Sintel.2010.Commentary.mp4" : "Sintel.2010.mp4", filesize: 1682, mimeType: "video/mp4" });
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
      return respond({ results: titles.filter(title => (title.type ?? "movie") === (url.pathname.endsWith("/tv") ? "series" : "movie") && title.name.toLowerCase() === query).map(tmdb) });
    }
    const external = /^\/3\/find\/(tt\d+)$/.exec(url.pathname);
    if (external) return respond({ movie_results: titles.filter(title => title.imdb === external[1] && title.type !== "series").map(tmdb), tv_results: titles.filter(title => title.imdb === external[1] && title.type === "series").map(tmdb) });
    const detail = /^\/3\/(movie|tv)\/(\d+)$/.exec(url.pathname), title = detail && titles.find(item => item.id === Number(detail[2]) && (item.type ?? "movie") === (detail[1] === "tv" ? "series" : "movie"));
    return title ? respond({ ...tmdb(title), ...(typeof override.rating === "number" ? { vote_average: override.rating } : {}) }) : respond({ success: false, status_code: 34 }, 404);
  }
  if (url.searchParams.get("apikey") !== "metadata-fixture-only") return respond({ Response: "False", Error: "Invalid API key!" });
  const id = url.searchParams.get("i");
  if (id === "tt0109830") return respond(omdb({ id: 1003, imdb: id, name: "Connection test fixture", year: 1994, runtime: 142 }));
  if (id) { const title = titles.find(item => item.imdb === id); return title ? respond(omdb(title)) : respond({ Response: "False", Error: "Movie not found!" }); }
  const query = (url.searchParams.get("s") ?? "").trim().toLowerCase();
  const matches = titles.filter(title => (title.type ?? "movie") === (url.searchParams.get("type") ?? "movie") && title.name.toLowerCase() === query);
  return matches.length ? respond({ Response: "True", Search: matches.map(omdb), totalResults: String(matches.length) }) : respond({ Response: "False", Error: "Movie not found!" });
};
