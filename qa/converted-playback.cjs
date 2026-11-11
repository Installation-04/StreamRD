#!/usr/bin/env node
/**
 * Converted playback in a real browser. The other journeys run on Playwright's Chromium, which has no H.264 or AAC decoder, so they cannot
 * tell whether a converted stream plays. This one needs Google Chrome (or Edge) and ffmpeg, and drives the server's real stream route:
 *   1. an MKV with H.264 and DTS (or AC-3) plays from the start once its audio is converted;
 *   2. started part-way in, the copied picture of an open-GOP file is refused by the browser with a decode error (the known cause);
 *   3. the player's answer to that, the same stream with video=1, plays from the same moment;
 *   4. a refused stream is reported on the <source> element, which is where the player has to listen.
 * The page below follows the same protocol as web/src/components/SharedPlayer.tsx; it does not load that component.
 *
 *   npm ci --prefix server && (cd server && npx prisma generate) && node qa/converted-playback.cjs
 *   CHROME_PATH=/path/to/chrome overrides the browser; without it Playwright's "chrome" channel is used.
 */
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs"), http = require("node:http"), os = require("node:os"), path = require("node:path");
const server = path.join(__dirname, "..", "server");
const fail = message => { console.error(`FAIL: ${message}`); process.exitCode = 1; };

async function main() {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) throw Error("ffmpeg is required");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streamrd-playback-qa-"));
  const dts = /\bdca\b/.test(spawnSync("ffmpeg", ["-hide_banner", "-encoders"]).stdout.toString());
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24,noise=alls=20:allf=t", "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "40", "-ac", "6",
    "-c:v", "libx264", "-preset", "medium", "-x264-params", "open-gop=1:keyint=48:b-pyramid=none", "-pix_fmt", "yuv420p", ...(dts ? ["-c:a", "dca", "-strict", "-2"] : ["-c:a", "ac3"]), path.join(dir, "opengop.mkv")]);

  const origin = http.createServer((req, res) => {
    const file = path.join(dir, "opengop.mkv"), size = fs.statSync(file).size, range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    const start = range ? Number(range[1]) : 0, end = range && range[2] ? Number(range[2]) : size - 1;
    res.writeHead(range ? 206 : 200, { "Accept-Ranges": "bytes", "Content-Length": end - start + 1, ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) });
    fs.createReadStream(file, { start, end }).pipe(res);
  });
  await new Promise(done => origin.listen(0, "127.0.0.1", done));

  process.env.TRANSCODE_ALLOW_PRIVATE_HOSTS = "1"; process.env.NODE_ENV ??= "test";
  require(require.resolve("tsx/cjs", { paths: [server] }));   // the server's own TypeScript loader, so the route under test is the source itself
  const express = require(require.resolve("express", { paths: [server] }));
  const { streamRouter } = require(path.join(server, "src", "routes", "stream.ts")), transcode = require(path.join(server, "src", "transcode.ts"));
  const source = `http://127.0.0.1:${origin.address().port}/opengop.mkv`, plan = await transcode.planPlayback(source, "opengop.mkv");
  if (plan.mode !== "audio") fail(`expected the audio to be converted and the picture copied, got "${plan.mode}"`);
  const app = express();
  app.use("/api/stream", streamRouter);
  app.get("/", (_req, res) => res.type("html").send(`<!doctype html><video id="v" autoplay muted playsinline preload="metadata"></video><script>
    const v = document.getElementById("v"), s = document.createElement("source"); window.sourceError = false;
    s.src = new URLSearchParams(location.search).get("src"); s.type = "video/mp4"; s.addEventListener("error", () => { window.sourceError = true; }); v.appendChild(s);
  </script>`));
  const api = app.listen(0, "127.0.0.1"); await new Promise(done => api.once("listening", done));
  const base = `http://127.0.0.1:${api.address().port}`, id = transcode.registerStream(source, "audio", "qa");

  const { chromium } = require("playwright");
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }), args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const watch = async (src, wait = 5000) => {
    const page = await browser.newPage(); await page.goto(`${base}/?src=${encodeURIComponent(src)}`);
    await page.waitForFunction(() => { const v = document.getElementById("v"); return v.error || window.sourceError || v.currentTime > 2; }, null, { timeout: 30000 }).catch(() => undefined);
    const state = await page.evaluate(() => { const v = document.getElementById("v"); return { at: v.currentTime, code: v.error ? v.error.code : null, message: v.error ? v.error.message : "", sourceError: window.sourceError, h264: v.canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"') }; });
    await page.close(); return state;
  };
  const report = {};
  try {
    report.start = await watch(`/api/stream/${id}?start=0`);
    if (!report.start.h264) throw Error("this browser has no H.264/AAC decoder; use Google Chrome or Edge");
    if (report.start.code || report.start.at <= 2) fail(`the converted stream did not play from the start: ${JSON.stringify(report.start)}`);
    report.copied = await watch(`/api/stream/${id}?start=20`);
    if (report.copied.code !== 3) console.warn(`note: this browser played the copied picture part-way in (${JSON.stringify(report.copied)}); the fallback was not needed here`);
    report.forced = await watch(`/api/stream/${id}?start=20&video=1`);
    if (report.forced.code || report.forced.at <= 2) fail(`the re-encoded stream did not play: ${JSON.stringify(report.forced)}`);
    report.refused = await watch("/api/stream/aaaaaaaaaaaaaaaaaaaaaaaa?start=0");
    if (!report.refused.sourceError || report.refused.code !== null) fail(`a refused stream should be reported on the <source>: ${JSON.stringify(report.refused)}`);
  } finally { await browser.close(); api.close(); origin.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(JSON.stringify({ browser: process.env.CHROME_PATH ?? "chrome", audio: dts ? "dts" : "ac3", ...report }, null, 2));
  if (process.env.QA_ARTIFACT_DIR) { fs.mkdirSync(process.env.QA_ARTIFACT_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.QA_ARTIFACT_DIR, "converted-playback.json"), JSON.stringify(report, null, 2)); }
}
main().then(() => process.exit(process.exitCode ?? 0), error => { console.error(`FAIL: ${error.message}`); process.exit(1); });
