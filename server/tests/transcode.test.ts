import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer, Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { accountProviderContext } from "../src/account-library";
import { playAccountItem } from "../src/providers/account-library";
import { ProviderError } from "../src/providers/types";
import { convertibleUrl, decideMode, ffmpegArgs, guessMode, maxConversions, planPlayback, Probe, probeStream, registerStream } from "../src/transcode";

vi.mock("../src/providers/account-library", () => ({ scanAccountPage: vi.fn(), playAccountItem: vi.fn() }));
const play = vi.mocked(playAccountItem);
const probe = (over: Partial<Probe> = {}): Probe => ({ formats: ["mov", "mp4"], video: "h264", audio: "aac", pixFmt: "yuv420p", durationSeconds: 90, width: 1920, height: 1080, ...over });

it("hands ffmpeg only public http(s) links without credentials", () => {
  const allowed = process.env.TRANSCODE_ALLOW_PRIVATE_HOSTS; delete process.env.TRANSCODE_ALLOW_PRIVATE_HOSTS;
  expect(convertibleUrl("https://download.example.com/file.mkv?token=abc")).toBe("https://download.example.com/file.mkv?token=abc");
  for (const bad of ["file:///etc/passwd", "ftp://example.com/a", "https://user:pw@example.com/a", "http://localhost/a", "http://127.0.0.1/a", "http://10.0.0.5/a", "http://192.168.1.9/a", "http://172.20.0.1/a", "http://169.254.169.254/a", "http://[::1]/a", "http://nas.local/a", "not a url", "", null, undefined])
    expect(convertibleUrl(bad as string)).toBeNull();
  process.env.TRANSCODE_ALLOW_PRIVATE_HOSTS = "1"; expect(convertibleUrl("http://192.168.1.9/a")).toBe("http://192.168.1.9/a"); expect(convertibleUrl("file:///etc/passwd")).toBeNull();
  if (allowed === undefined) delete process.env.TRANSCODE_ALLOW_PRIVATE_HOSTS; else process.env.TRANSCODE_ALLOW_PRIVATE_HOSTS = allowed;
});

it("decides what a browser needs from the real streams", () => {
  expect(decideMode(probe())).toBe("direct");
  expect(decideMode(probe({ formats: ["matroska", "webm"] }))).toBe("remux");
  expect(decideMode(probe({ formats: ["matroska", "webm"], audio: "dts" }))).toBe("audio");
  expect(decideMode(probe({ audio: "truehd" }))).toBe("audio");
  expect(decideMode(probe({ video: "hevc" }))).toBe("video");
  expect(decideMode(probe({ pixFmt: "yuv420p10le" }))).toBe("video");
  expect(decideMode(probe({ video: "vc1", formats: ["asf"] }))).toBe("video");
  expect(decideMode(probe({ audio: null }))).toBe("direct");
});

it("guesses from the file name when nothing can be probed", () => {
  expect(guessMode("Crank.2006.1080p.BluRay.DTS.x264.mkv")).toBe("audio");
  expect(guessMode("Film.2020.2160p.HEVC.mkv")).toBe("video");
  expect(guessMode("Film.2020.720p.AAC.mp4")).toBe("direct");
  expect(guessMode("Film.2020.720p.DTS.mp4")).toBe("audio");
});

it("builds ffmpeg arguments per mode without a shell, a protocol allow-list on, and start only when asked", () => {
  const url = "https://download.example.com/a b;rm -rf.mkv";
  const remux = ffmpegArgs(url, "remux", 0), audio = ffmpegArgs(url, "audio", 125.5), video = ffmpegArgs(url, "video", 0);
  expect(remux).toContain(url); expect(remux.join(" ")).toMatch(/-protocol_whitelist http,https,tcp,tls,crypto/); expect(remux).not.toContain("-ss");
  expect(remux.join(" ")).toMatch(/-c:v copy -c:a copy/); expect(audio.join(" ")).toMatch(/-ss 125\.500 -i/); expect(audio.join(" ")).toMatch(/-c:v copy -c:a aac/);
  expect(video.join(" ")).toMatch(/-c:v libx264/); expect(video.join(" ")).toMatch(/scale=w='min\(1920,iw\)':h=-2/);
  for (const args of [remux, audio, video]) { expect(args.at(-1)).toBe("pipe:1"); expect(args.join(" ")).toMatch(/frag_keyframe\+empty_moov/); }
  expect(ffmpegArgs(url, "audio", -4)).not.toContain("-ss");
});

// ---- Real ffmpeg, against real files served over http. Skipped where ffmpeg is not installed.
const haveFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "streamrd-transcode-"));
let server: Server, base = "";
const make = (name: string, args: string[]) => { try { execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=d=3:s=160x120:r=10", "-f", "lavfi", "-i", "sine=d=3", "-t", "3", ...args, join(dir, name)], { stdio: "ignore" }); return true; } catch { return false; } };
const fixtures: Record<string, boolean> = {};
beforeAll(async () => {
  if (!haveFfmpeg) return;
  fixtures.plain = make("plain.mp4", ["-preset", "ultrafast", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
  fixtures.dts = make("ac3.mkv", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "ac3"]);
  fixtures.remux = make("aac.mkv", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "10", "-c:a", "aac"]);
  fixtures.tenbit = make("ten.mkv", ["-c:v", "libx264", "-pix_fmt", "yuv420p10le", "-c:a", "ac3"]);
  // An "open GOP" H.264 file, as most Blu-ray style encodes are: its later keyframes are not clean entry points.
  try { execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24,noise=alls=20:allf=t", "-f", "lavfi", "-i", "sine", "-t", "12", "-c:v", "libx264", "-preset", "medium", "-x264-params", "open-gop=1:keyint=48:b-pyramid=none", "-pix_fmt", "yuv420p", "-c:a", "ac3", join(dir, "opengop.mkv")], { stdio: "ignore" }); fixtures.openGop = true; } catch { fixtures.openGop = false; }
  server = createServer((req, res) => {
    const file = join(dir, (req.url ?? "").split("?")[0].replace(/[^a-z0-9.]/gi, ""));
    try {
      const size = statSync(file).size, range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
      if (range) { const start = Number(range[1]), end = range[2] ? Number(range[2]) : size - 1; res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1, "Accept-Ranges": "bytes" }); createReadStream(file, { start, end }).pipe(res); }
      else { res.writeHead(200, { "Content-Length": size, "Accept-Ranges": "bytes" }); createReadStream(file).pipe(res); }
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.TRANSCODE = "true"; process.env.TRANSCODE_ALLOW_PRIVATE_HOSTS = "1";
}, 120_000);
afterAll(async () => { process.env.TRANSCODE = "false"; delete process.env.TRANSCODE_ALLOW_PRIVATE_HOSTS; delete process.env.TRANSCODE_MAX; delete process.env.FFMPEG_PATH; if (server) { server.closeAllConnections?.(); await new Promise(done => server.close(done)); } });
const real = haveFfmpeg ? it : it.skip;
const streams = (file: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt", "-of", "json", file]).toString()).streams as Array<{ codec_type: string; codec_name: string; pix_fmt?: string }>;

real("probes real files and chooses the cheapest conversion that plays", async () => {
  expect((await probeStream(`${base}/plain.mp4`))).toMatchObject({ video: "h264", audio: "aac" });
  expect((await planPlayback(`${base}/plain.mp4`, "plain.mp4")).mode).toBe("direct");
  expect((await planPlayback(`${base}/aac.mkv`, "aac.mkv")).mode).toBe("remux");
  const audio = await planPlayback(`${base}/ac3.mkv`, "ac3.mkv"); expect(audio.mode).toBe("audio"); expect(audio.probe!.durationSeconds).toBeGreaterThan(2);
  if (fixtures.tenbit) expect((await planPlayback(`${base}/ten.mkv`, "ten.mkv")).mode).toBe("video");
  expect(await probeStream(`${base}/missing.mkv`)).toBeNull();
  process.env.TRANSCODE = "false"; expect((await planPlayback(`${base}/ac3.mkv`, "ac3.mkv")).mode).toBe("direct"); process.env.TRANSCODE = "true";
});

real("streams a converted MP4 that a browser can play, with AAC audio and untouched H.264 video", async () => {
  const id = registerStream(`${base}/ac3.mkv`, "audio", "someone");
  const response = await request(app).get(`/api/stream/${id}`).buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => done(null, Buffer.concat(chunks))); });
  expect(response.status).toBe(200); expect(response.headers["content-type"]).toBe("video/mp4"); expect(response.headers["cache-control"]).toBe("no-store");
  const file = join(dir, "out-audio.mp4"); writeFileSync(file, response.body);
  expect(response.body.subarray(4, 8).toString()).toBe("ftyp");
  expect(streams(file).map(stream => `${stream.codec_type}:${stream.codec_name}`).sort()).toEqual(["audio:aac", "video:h264"]);
});

real("re-encodes the video for formats a browser cannot decode, and can start part-way in", async () => {
  if (!fixtures.tenbit) return;
  const grab = (id: string, query = "") => request(app).get(`/api/stream/${id}${query}`).buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => done(null, Buffer.concat(chunks))); });
  const whole = await grab(registerStream(`${base}/ten.mkv`, "video", "someone")); const file = join(dir, "out-video.mp4"); writeFileSync(file, whole.body);
  expect(streams(file).find(stream => stream.codec_type === "video")).toMatchObject({ codec_name: "h264", pix_fmt: "yuv420p" });
  const later = await grab(registerStream(`${base}/aac.mkv`, "remux", "someone"), "?start=1.5"); const second = join(dir, "out-later.mp4"); writeFileSync(second, later.body);
  const length = (path: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).toString().trim());
  expect(length(second)).toBeLessThan(2.5);
});

// Browsers decode strictly: one reference to a picture that is not in the stream stops playback (Chrome: PIPELINE_ERROR_DECODE).
// ffmpeg's "-err_detect explode -xerror" applies the same rule, so it stands in for a browser's decoder here.
const decodesStrictly = (file: string) => spawnSync("ffmpeg", ["-v", "error", "-err_detect", "explode", "-xerror", "-i", file, "-map", "0:v:0", "-f", "null", "-"]).status === 0;
real("re-encodes the picture when the player says the browser could not decode the copied one (open-GOP H.264 started part-way in)", async () => {
  if (!fixtures.openGop) return;
  const grab = (id: string, query: string) => request(app).get(`/api/stream/${id}${query}`).buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => done(null, Buffer.concat(chunks))); });
  const id = registerStream(`${base}/opengop.mkv`, "audio", "someone");
  const save = async (name: string, query: string) => { const response = await grab(id, query); expect(response.status).toBe(200); const file = join(dir, name); writeFileSync(file, response.body); return file; };
  expect(decodesStrictly(await save("og-start.mp4", ""))).toBe(true);            // from the very start the copied picture is clean
  expect(decodesStrictly(await save("og-copy.mp4", "?start=6"))).toBe(false);    // the cause: resumed or sought, the copied picture is not decodable by a browser
  const forced = await save("og-forced.mp4", "?start=6&video=1");
  expect(decodesStrictly(forced)).toBe(true);                                     // the fix: the same stream id, picture re-encoded
  expect(streams(forced).map(stream => `${stream.codec_type}:${stream.codec_name}`).sort()).toEqual(["audio:aac", "video:h264"]);
  const log = await db.logEvent.findFirst({ where: { type: "playback", level: "info" }, orderBy: { createdAt: "desc" } });
  expect(log?.message).toMatch(/could not decode the copied picture \(audio\) at 6s/); expect(log?.message).not.toMatch(/127\.0\.0\.1|opengop/);
}, 60_000);

it("says why when the player asks for the picture to be converted and that is turned off", async () => {
  process.env.TRANSCODE_VIDEO = "false";
  try {
    const id = registerStream("https://example.com/a.mkv", "audio", "x");
    const refused = await request(app).get(`/api/stream/${id}?video=1`);
    expect(refused.status).toBe(409); expect(refused.body.error).toMatch(/picture is converted too, and that is turned off on this server \(Admin → Server → Conversion\)/);
    expect((await request(app).get(`/api/stream/${id}/status`)).body.lastError).toMatch(/Admin → Server → Conversion/);
    expect((await request(app).get(`/api/stream/${id}?video=yes`)).status).toBe(400);
  } finally { delete process.env.TRANSCODE_VIDEO; }
});

it("tells a viewer what a dead link means for them, keeps the owner's instructions for the owner, and logs the failed play", async () => {
  const owner = await member("admin"), viewer = await member("user");
  await db.debridConfig.upsert({ where: { userId: owner.id }, create: { userId: owner.id, realDebridToken: "private-fixture-key" }, update: {} });
  const ctx = await accountProviderContext(owner.id, "realdebrid");
  const media = await db.accountMedia.create({ data: { userId: owner.id, provider: "realdebrid", providerRef: "ref-gone", credentialFingerprint: ctx.fingerprint, name: "Gone Film", year: 2001, type: "movie", phase: "finished", progress: 100, groupKey: "movie|gone film|2001", isPrimary: true } });
  const created = await request(app).post("/api/admin/shared-libraries").set(auth(owner.token)).send({ name: "Films", mediaType: "movie" });
  await request(app).post(`/api/admin/shared-libraries/${created.body.library.id}/users`).set(auth(owner.token)).send({ userId: viewer.id });
  const url = `/api/shared-libraries/${created.body.library.id}/items/${media.id}/play`;
  play.mockRejectedValue(new ProviderError("realdebrid", "unknown_ressource for private-fixture-key", 404));
  const seen = await request(app).post(url).set(auth(viewer.token)).send({});
  expect(seen.status).toBe(404); expect(seen.body.error).toMatch(/cannot be played right now: its link stopped working\. The administrator is told automatically/);
  expect(seen.body.error).not.toMatch(/Rescan|provider account|private-fixture-key/);
  const mine = await request(app).post(url).set(auth(owner.token)).send({});
  expect(mine.status).toBe(404); expect(mine.body.error).toMatch(/no longer available in the provider account\. Rescan/);
  play.mockRejectedValue(new ProviderError("realdebrid", "upstream timeout", 504));
  const later = await request(app).post(url).set(auth(viewer.token)).send({});
  expect(later.status).toBe(503); expect(later.body.error).toMatch(/provider did not answer\. Try again in a moment/);
  await new Promise(done => setTimeout(done, 100));
  const lines = await db.logEvent.findMany({ where: { type: "playback", level: "warn" }, orderBy: { createdAt: "asc" } });
  expect(lines).toHaveLength(3); expect(lines[0].message).toMatch(/^Could not play Gone Film \(2001\): This item is no longer available/); expect(lines[0].userId).toBe(viewer.id);
  expect(JSON.stringify(lines)).not.toContain("private-fixture-key");
  expect((await db.accountMedia.findUniqueOrThrow({ where: { id: media.id } })).health).toBe("broken");   // two refusals: the link is marked
  play.mockReset();
});

it("follows the conversion choices made in Admin → Server, without a restart", async () => {
  const owner = await member("admin");
  const put = (body: object) => request(app).put("/api/admin/system/settings").set(auth(owner.token)).send(body);
  process.env.TRANSCODE = "true"; delete process.env.TRANSCODE_MAX; delete process.env.TRANSCODE_VIDEO; delete process.env.TRANSCODE_ALLOW_PRIVATE_HOSTS;
  try {
    expect(maxConversions()).toBe(2); expect(convertibleUrl("http://192.168.1.9/a.mkv")).toBeNull();
    expect((await put({ transcodeMax: 6, transcodeAllowPrivateHosts: true, transcodeVideo: false })).status).toBe(200);
    expect(maxConversions()).toBe(6); expect(convertibleUrl("http://192.168.1.9/a.mkv")).toBe("http://192.168.1.9/a.mkv");
    const refused = await request(app).get(`/api/stream/${registerStream("https://example.com/a.mkv", "audio", "x")}?video=1`);
    expect(refused.status).toBe(409); expect(refused.body.error).toMatch(/Admin → Server → Conversion/);
    expect((await put({ transcode: false })).status).toBe(200);
    expect(await planPlayback("https://example.com/a.mkv", "a.mkv")).toMatchObject({ mode: "direct", reason: "off" });   // nothing is converted, and nothing is probed
    expect((await put({ transcode: null, transcodeMax: null, transcodeAllowPrivateHosts: null, transcodeVideo: null })).body.sources).toMatchObject({ transcode: "environment", transcodeMax: "default" });
    expect(maxConversions()).toBe(2);
  } finally { process.env.TRANSCODE = "true"; process.env.TRANSCODE_ALLOW_PRIVATE_HOSTS = "1"; }
});

it("refuses unknown or malformed stream ids and bad start times", async () => {
  expect((await request(app).get("/api/stream/aaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
  expect((await request(app).get("/api/stream/short")).status).toBe(400);
  expect((await request(app).get(`/api/stream/${registerStream("https://example.com/a.mkv", "audio", "x")}?start=-3`)).status).toBe(400);
  expect((await request(app).get(`/api/stream/${registerStream("https://example.com/a.mkv", "audio", "x")}?url=http://evil`)).status).toBe(400);
});

it("answers 503 while the server is already converting as many videos as it is set to", async () => {
  const stub = join(dir, "slow-ffmpeg.sh"); writeFileSync(stub, "#!/bin/sh\nsleep 8\n", { mode: 0o755 });
  process.env.FFMPEG_PATH = stub; process.env.TRANSCODE_MAX = "1";
  const listener = app.listen(0); await new Promise(done => listener.once("listening", done));
  const port = (listener.address() as { port: number }).port, first = new AbortController();
  const pending = fetch(`http://127.0.0.1:${port}/api/stream/${registerStream("https://example.com/a.mkv", "audio", "x")}`, { signal: first.signal }).catch(() => null);
  await new Promise(done => setTimeout(done, 400));
  const second = await fetch(`http://127.0.0.1:${port}/api/stream/${registerStream("https://example.com/b.mkv", "audio", "x")}`);
  expect(second.status).toBe(503); expect(second.headers.get("retry-after")).toBe("10");
  first.abort(); await pending; await new Promise(done => listener.close(done));
  delete process.env.FFMPEG_PATH; delete process.env.TRANSCODE_MAX;
});

it("answers with the reason, not an empty video, when the conversion fails at once, and lets the player ask why", async () => {
  const stub = join(dir, "failing-ffmpeg.sh"); writeFileSync(stub, "#!/bin/sh\necho 'Error opening input: Server returned 403 Forbidden for https://secret.example.invalid/file.mkv?token=abc' >&2\nexit 1\n", { mode: 0o755 });
  process.env.FFMPEG_PATH = stub;
  try {
    const id = registerStream("https://secret.example.invalid/file.mkv?token=abc", "audio", "someone");
    const failed = await request(app).get(`/api/stream/${id}`);
    expect(failed.status).toBe(502); expect(failed.body.error).toMatch(/could not convert this video: .*403 Forbidden/); expect(JSON.stringify(failed.body)).not.toMatch(/secret\.example|token=abc/);
    const why = await request(app).get(`/api/stream/${id}/status`);
    expect(why.status).toBe(200); expect(why.body).toMatchObject({ known: true, running: false }); expect(why.body.lastError).toMatch(/403 Forbidden for <link>/); expect(JSON.stringify(why.body)).not.toMatch(/secret\.example|token=abc/);
    expect((await request(app).get("/api/stream/aaaaaaaaaaaaaaaaaaaaaaaa/status")).body).toEqual({ known: false, lastError: null, running: false });
    expect((await request(app).get("/api/stream/short/status")).status).toBe(400);
  } finally { delete process.env.FFMPEG_PATH; }
});

it("lets the newest request for a stream replace the older one instead of counting both against the limit", async () => {
  const stub = join(dir, "slow2-ffmpeg.sh"); writeFileSync(stub, "#!/bin/sh\nsleep 8\n", { mode: 0o755 });
  process.env.FFMPEG_PATH = stub; process.env.TRANSCODE_MAX = "1";
  const listener = app.listen(0); await new Promise(done => listener.once("listening", done));
  const port = (listener.address() as { port: number }).port, id = registerStream("https://example.com/a.mkv", "audio", "x");
  const first = new AbortController(), second = new AbortController();
  const one = fetch(`http://127.0.0.1:${port}/api/stream/${id}`, { signal: first.signal }).then(res => res.status).catch(() => "closed");
  await new Promise(done => setTimeout(done, 400));
  const two = fetch(`http://127.0.0.1:${port}/api/stream/${id}`, { signal: second.signal }).then(res => res.status).catch(() => "closed");
  await new Promise(done => setTimeout(done, 400));
  const other = await fetch(`http://127.0.0.1:${port}/api/stream/${registerStream("https://example.com/b.mkv", "audio", "x")}`);   // still at the limit: one conversion is running
  expect(other.status).toBe(503);
  expect(await one).toBe("closed");    // the older request was replaced, not answered with an error
  first.abort(); second.abort(); await two; await new Promise(done => listener.close(done));
  delete process.env.FFMPEG_PATH; delete process.env.TRANSCODE_MAX;
});

// ---- The play route.
let serial = 0;
async function member(role: "admin" | "user") {
  const created = await db.user.create({ data: { email: `transcode-${serial++}@example.invalid`, displayName: "Person", hashedPassword: "fixture-no-password-auth", role } });
  return { ...created, token: signSession({ sub: created.id, email: created.email, role, version: created.sessionVersion }) };
}
beforeEach(async () => { await resetDb(); play.mockReset(); });
real("a play of a file the browser cannot open answers with a stream of ours and the real length; a playable one answers as before", async () => {
  const owner = await member("admin"), viewer = await member("user");
  await db.debridConfig.upsert({ where: { userId: owner.id }, create: { userId: owner.id, realDebridToken: "private-fixture-key" }, update: {} });
  const ctx = await accountProviderContext(owner.id, "realdebrid");
  const media = await db.accountMedia.create({ data: { userId: owner.id, provider: "realdebrid", providerRef: "ref-1", credentialFingerprint: ctx.fingerprint, name: "Crank", year: 2006, type: "movie", phase: "finished", progress: 100, groupKey: "movie|crank|2006", isPrimary: true } });
  const created = await request(app).post("/api/admin/shared-libraries").set(auth(owner.token)).send({ name: "Films", mediaType: "movie" });
  await request(app).post(`/api/admin/shared-libraries/${created.body.library.id}/users`).set(auth(owner.token)).send({ userId: viewer.id });
  const url = `/api/shared-libraries/${created.body.library.id}/items/${media.id}/play`;
  play.mockResolvedValueOnce({ mediaKey: "k1", stream: { provider: "realdebrid", url: `${base}/ac3.mkv`, filename: "Crank.2006.1080p.BluRay.DTS.x264.mkv", mimeType: "video/x-matroska" } });
  const converted = await request(app).post(url).set(auth(viewer.token)).send({});
  expect(converted.status).toBe(200); expect(converted.body.playback).toMatchObject({ mode: "audio", video: "h264", audio: "ac3" });
  expect(converted.body.playback.url).toMatch(/^\/api\/stream\/[A-Za-z0-9_-]{30,}$/); expect(converted.body.playback.durationSeconds).toBeGreaterThan(2);
  expect(converted.body.durationSeconds).toBeGreaterThan(2);
  expect(JSON.stringify(converted.body.playback)).not.toContain("127.0.0.1");
  play.mockResolvedValueOnce({ mediaKey: "k1", stream: { provider: "realdebrid", url: `${base}/plain.mp4`, filename: "Film.mp4", mimeType: "video/mp4" } });
  const direct = await request(app).post(url).set(auth(viewer.token)).send({});
  expect(direct.body.playback).toMatchObject({ mode: "direct" }); expect(direct.body.playback.url).toBeUndefined();
  // Each play is in the log: who, which title, what the server decided. Never the link or the file name.
  await new Promise(done => setTimeout(done, 100));
  const plays = await db.logEvent.findMany({ where: { type: "playback", userId: viewer.id }, orderBy: { createdAt: "asc" } });
  expect(plays.map(line => line.message)).toEqual(["Playing Crank (2006): audio converted", "Playing Crank (2006): as it is"]);
  expect(JSON.parse(plays[0].meta!)).toMatchObject({ itemId: media.id, mode: "audio", video: "h264", audio: "ac3" }); expect(plays[0].provider).toBe("realdebrid");
  expect(JSON.stringify(plays)).not.toMatch(/127\.0\.0\.1|ac3\.mkv|BluRay/);
});
