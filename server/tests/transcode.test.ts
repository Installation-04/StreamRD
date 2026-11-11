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
import { convertibleUrl, decideMode, ffmpegArgs, guessMode, planPlayback, Probe, probeStream, registerStream } from "../src/transcode";

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
afterAll(async () => { process.env.TRANSCODE = "false"; delete process.env.TRANSCODE_ALLOW_PRIVATE_HOSTS; delete process.env.TRANSCODE_MAX; delete process.env.FFMPEG_PATH; await new Promise(done => server?.close(done)); });
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
});
