#!/usr/bin/env node
/**
 * The local lab: the real StreamRD API and web app behind the real gateway code, on this machine, with no Docker, no debrid account and no
 * network. A preload answers for the outside services (qa/lab/preload.cjs) and a small server plays the part of the internet
 * (qa/lab/origin.cjs). Use it to click through the product in a browser with real video decoders, or to run qa/lab/journey.cjs.
 *
 *   node qa/lab/start.cjs            builds what is missing, then serves http://127.0.0.1:8080 until stopped
 *   LAB_DIR=/some/dir                where the database and logs live (default: a folder under the system temp dir)
 *   LAB_MEDIA_DIR=/some/dir          where the generated videos are kept between runs (about 300 MB; made once, in a minute or two)
 *   LAB_FRESH=1                      start from an empty database
 *   LAB_HELPER=0                     run without the helper that launches Plex and Jellyfin (it runs against a stand-in for Docker)
 * Sign-in details are yours to choose on the first-run page. Debrid key: lab-debrid-key-0123456789. Indexer: http://127.0.0.1:47990/torznab/api
 * with key lab-indexer-key.
 */
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto"), fs = require("node:fs"), http = require("node:http"), os = require("node:os"), path = require("node:path");
const root = path.join(__dirname, "..", ".."), server = path.join(root, "server"), web = path.join(root, "web");
const lab = process.env.LAB_DIR || path.join(os.tmpdir(), "streamrd-lab"), media = process.env.LAB_MEDIA_DIR || path.join(os.tmpdir(), "streamrd-lab-media"), data = path.join(lab, "data");
const ports = { gateway: Number(process.env.LAB_PORT || 8080), api: 47821, web: 3000, origin: 47990 };
const children = [];
const run = (cwd, command, args, env = {}) => execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
const start = (name, cwd, args, env) => {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const log = fs.createWriteStream(path.join(lab, `${name}.log`), { flags: "a" });
  child.stdout.pipe(log); child.stderr.pipe(log); children.push(child);
  child.on("exit", code => { if (!stopping) { console.error(`${name} stopped (${code}); see ${path.join(lab, `${name}.log`)}`); stop(1); } });
};
let stopping = false;
const stop = code => { if (stopping) return; stopping = true; for (const child of children) child.kill("SIGTERM"); setTimeout(() => process.exit(code), 500); };
process.on("SIGINT", () => stop(0)); process.on("SIGTERM", () => stop(0));

function videos() {
  fs.mkdirSync(media, { recursive: true });
  const have = name => fs.existsSync(path.join(media, name));
  const make = (name, seconds, _label, tone, args, extra = []) => {
    if (have(name)) return;
    console.log(`lab: making ${name}`);
    const made = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24,noise=alls=10:allf=t", "-f", "lavfi", "-i", `sine=frequency=${tone}:sample_rate=48000`, ...extra, "-t", String(seconds), ...args, path.join(media, name)], { stdio: ["ignore", "ignore", "inherit"] });
    if (made.status !== 0) throw Error(`ffmpeg could not make ${name} (it needs libx264, libx265, libxvid and the DTS and TrueHD encoders)`);
  };
  const h264 = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"], mp4 = [...h264, "-ac", "2", "-c:a", "aac", "-movflags", "+faststart"];
  make("Big.Buck.Bunny.2008.1080p.BluRay.x264.DTS.mkv", 120, "BigBuckBunny", 440, ["-ac", "6", "-c:v", "libx264", "-preset", "ultrafast", "-x264-params", "keyint=250:open-gop=1:bframes=3:b-pyramid=normal", "-pix_fmt", "yuv420p", "-c:a", "dca", "-strict", "-2"]);   // open GOP: a browser refuses the copied picture at every seek point
  make("Big.Buck.Bunny.2008.2160p.WEB-DL.H264.AAC.mp4", 40, "BBB4K", 440, mp4);
  make("Sintel.2010.1080p.WEB-DL.H264.AAC.mp4", 60, "Sintel", 550, mp4);
  make("Cosmos.Laundromat.2015.1080p.WEB-DL.H264.AAC.mp4", 40, "CosmosLaundromat", 880, mp4);
  make("Elephants.Dream.2006.2160p.UHD.BluRay.HEVC.10bit.TrueHD.mkv", 40, "ElephantsDream", 660, ["-ac", "6", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-pix_fmt", "yuv420p10le", "-c:a", "truehd", "-strict", "-2"]);
  make("Tears.of.Steel.2012.720p.DVDRip.XviD.MP3.avi", 40, "TearsOfSteel", 770, ["-ac", "2", "-c:v", "libxvid", "-q:v", "5", "-c:a", "libmp3lame"]);
  const subtitles = path.join(media, "lab.srt"); fs.writeFileSync(subtitles, "1\n00:00:01,000 --> 00:00:05,000\nHello from the subtitles\n");
  for (const episode of [1, 2, 3]) make(`Example.Show.S01E0${episode}.1080p.WEB.x264.AC3.mkv`, 45, `ShowS01E0${episode}`, 300 + episode * 50, ["-map", "0:v", "-map", "1:a", "-map", "2", ...h264, "-g", "48", "-ac", "6", "-c:a", "ac3", "-c:s", "srt"], ["-i", subtitles]);
  fs.rmSync(subtitles, { force: true });
}
function secret(name) { const file = path.join(data, name); if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 }); return fs.readFileSync(file, "utf8").trim(); }
function gateway() {
  // The product's own gateway: the proxy() function of the single container's start script, run as it is.
  const source = fs.readFileSync(path.join(root, "infra", "single-container", "start.cjs"), "utf8");
  const body = source.slice(source.indexOf("function proxy("), source.indexOf("async function check("));
  const gateways = [], health = async () => true; // eslint-disable-line no-unused-vars
  eval(body); proxy(ports.gateway, ports.web, ports.api); // eslint-disable-line no-eval, no-undef
}
async function ready(url) { for (let attempt = 0; attempt < 120; attempt++) { try { const response = await fetch(url); if (response.ok) return; } catch { /* not yet */ } await new Promise(done => setTimeout(done, 500)); } throw Error(`${url} did not come up`); }

(async () => {
  if (process.env.LAB_FRESH === "1") fs.rmSync(data, { recursive: true, force: true });
  fs.mkdirSync(data, { recursive: true });
  videos();
  if (!fs.existsSync(path.join(server, "node_modules"))) run(server, "npm", ["ci", "--no-audit", "--no-fund"]);
  if (!fs.existsSync(path.join(web, "node_modules"))) run(web, "npm", ["ci", "--no-audit", "--no-fund"]);
  if (process.env.LAB_REBUILD === "1" || !fs.existsSync(path.join(server, "dist", "src", "index.js"))) { run(server, "npx", ["prisma", "generate"]); run(server, "npm", ["run", "build"]); }
  const standalone = path.join(web, ".next", "standalone");
  if (process.env.LAB_REBUILD === "1" || !fs.existsSync(path.join(standalone, "server.js")) || !fs.existsSync(path.join(web, ".next", "lab-same-origin"))) {
    run(web, "npm", ["run", "build"], { NEXT_PUBLIC_API_BASE_URL: "", NEXT_TELEMETRY_DISABLED: "1" });   // same origin, as in the single container
    fs.cpSync(path.join(web, ".next", "static"), path.join(standalone, ".next", "static"), { recursive: true });
    if (fs.existsSync(path.join(web, "public"))) fs.cpSync(path.join(web, "public"), path.join(standalone, "public"), { recursive: true });
    fs.writeFileSync(path.join(web, ".next", "lab-same-origin"), "");
  }
  const env = { NODE_ENV: "production", PORT: String(ports.api), DATABASE_URL: `file:${path.join(data, "streamrd.db")}`, JWT_SECRET: secret("jwt"), DATA_ENCRYPTION_KEY: secret("data-key"),
    MEDIA_SOURCE_ROOT: path.join(data, "downloads"), MEDIA_LIBRARY_ROOT: path.join(data, "library"), CORS_ORIGINS: "", TRANSCODE_ALLOW_PRIVATE_HOSTS: "true",
    TMDB_DEFAULT_API_KEY: "lab-tmdb-key-0123456789", STREAMRD_LAB: "1", LAB_ORIGIN: `http://127.0.0.1:${ports.origin}`, LAB_MEDIA: media, LAB_ORIGIN_PORT: String(ports.origin), LAB_OUTBOUND_LOG: path.join(lab, "outbound.log") };
  fs.mkdirSync(env.MEDIA_SOURCE_ROOT, { recursive: true });
  run(server, process.execPath, ["scripts/prepare-db.cjs"], env);
  if (process.env.LAB_HELPER !== "0") {
    // The real helper, against a stand-in for Docker: Launch, the deploy log, auto-start and Restart can be tried from the pages.
    const socket = path.join(lab, "docker.sock");
    Object.assign(env, { MEDIA_MANAGER_URL: "http://127.0.0.1:8099", MEDIA_MANAGER_TOKEN: secret("helper-token") });
    start("docker", __dirname, ["fake-docker.cjs"], { LAB_DOCKER_SOCKET: socket });
    start("helper", root, [path.join("infra", "single-container", "media-manager.cjs")], { DOCKER_SOCKET: socket, MEDIA_MANAGER_TOKEN: env.MEDIA_MANAGER_TOKEN, HOST_INSTALL_DIR: lab, PORT: "8099", STREAMRD_CONTAINER: "streamrd" });
  }
  start("origin", __dirname, ["origin.cjs"], env);
  start("api", server, ["--require", path.join(__dirname, "preload.cjs"), "dist/src/index.js"], env);
  start("web", standalone, ["server.js"], { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", PORT: String(ports.web), HOSTNAME: "127.0.0.1" });
  gateway();
  await ready(`http://127.0.0.1:${ports.api}/api/health`); await ready(`http://127.0.0.1:${ports.web}/login`);
  console.log(`lab: StreamRD is on http://127.0.0.1:${ports.gateway}  (logs and data in ${lab})`);
})().catch(error => { console.error(`lab: ${error.message}`); stop(1); });
