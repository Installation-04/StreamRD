import request from "supertest";
import { beforeEach, expect, it, vi, afterEach } from "vitest";
import { db } from "../src/db";
import { beginPlayback, mediaKeyFor } from "../src/progress";
import { signSession } from "../src/auth/jwt";
import { app, auth, resetDb, TestUser } from "./helpers";
import { providers } from "../src/providers/registry";
let user: TestUser, other: TestUser, profileId: string, otherProfile: string, titleId: string;
async function account(email: string): Promise<TestUser> {
  const u = await db.user.create({ data: { email, displayName: "Progress fixture", hashedPassword: "not-used-for-login" } });
  return { id: u.id, email, token: signSession({ sub: u.id, email, role: "user" }) };
}
beforeEach(async () => {
  await resetDb(); user = await account("progress@test.local"); other = await account("other@test.local");
  profileId = (await db.profile.create({ data: { userId: user.id, name: "Kids" } })).id;
  otherProfile = (await db.profile.create({ data: { userId: other.id, name: "Other" } })).id;
  titleId = (await db.title.create({ data: { name: "Progress movie", sources: '[{"kind":"link","url":"https://host/movie"}]' } })).id;
});
afterEach(() => vi.restoreAllMocks());
const write = (sessionId: string, sequence: number, positionSeconds = 30, durationSeconds = 100, who?: TestUser) => request(app).put("/api/play/progress").set(auth((who ?? user).token)).send({ sessionId, sequence, positionSeconds, durationSeconds });
it("resumes persisted progress across sessions and isolates profiles and files", async () => {
  const session = await beginPlayback(user.id, titleId, "file-a", profileId);
  expect(session.resumeSeconds).toBe(0);
  expect((await write(session.sessionId, 0, 42)).body.accepted).toBe(true);
  expect((await beginPlayback(user.id, titleId, "file-a", profileId)).resumeSeconds).toBe(42);
  expect((await beginPlayback(user.id, titleId, "file-b", profileId)).resumeSeconds).toBe(0);
  expect((await beginPlayback(user.id, titleId, "file-a")).resumeSeconds).toBe(0);
});
it("ignores duplicate/out-of-order updates and superseded players", async () => {
  const old = await beginPlayback(user.id, titleId, "movie");
  await write(old.sessionId, 3, 45);
  expect((await write(old.sessionId, 2, 10)).body).toMatchObject({ accepted: false, reason: "out-of-order" });
  const newer = await beginPlayback(user.id, titleId, "movie");
  expect((await write(old.sessionId, 4, 80)).body).toMatchObject({ accepted: false, reason: "superseded" });
  expect((await write(newer.sessionId, 0, 50)).body.accepted).toBe(true);
  expect((await db.playbackProgress.findFirstOrThrow()).positionSeconds).toBe(50);
});
it("does not expose sessions or progress across accounts", async () => {
  const session = await beginPlayback(user.id, titleId, "movie", profileId);
  expect((await write(session.sessionId, 0, 30, 100, other)).status).toBe(404);
  expect((await request(app).get(`/api/play/continue?profileId=${profileId}`).set(auth(other.token))).status).toBe(404);
  expect((await request(app).post("/api/play").set(auth(user.token)).send({ titleId, trackProgress: true, profileId: otherProfile })).status).toBe(404);
});
it("rejects malformed, impossible and expired updates", async () => {
  const session = await beginPlayback(user.id, titleId, "movie");
  for (const data of [ { sequence: -1 }, { positionSeconds: -1 }, { positionSeconds: 200 }, { durationSeconds: 0 }, { positionSeconds: "30" }, { durationSeconds: 604801 } ]) {
    const response = await request(app).put("/api/play/progress").set(auth(user.token)).send({ sessionId: session.sessionId, sequence: 0, positionSeconds: 30, durationSeconds: 100, ...data });
    expect(response.status).toBe(400);
  }
  await db.playbackSession.update({ where: { id: session.sessionId }, data: { expiresAt: new Date(0) } });
  expect((await write(session.sessionId, 0)).status).toBe(410);
  expect((await request(app).put("/api/play/progress").send({})).status).toBe(401);
});
it("hides unstarted/completed videos and allows replay or seeking backwards", async () => {
  const session = await beginPlayback(user.id, titleId, "movie");
  const list = () => request(app).get("/api/play/continue").set(auth(user.token));
  expect((await list()).body.titles).toEqual([]);
  await write(session.sessionId, 0, 50);
  expect((await list()).body.titles[0]).toMatchObject({ id: titleId, positionSeconds: 50, durationSeconds: 100 });
  await write(session.sessionId, 1, 95);
  expect((await list()).body.titles).toEqual([]);
  const replay = await beginPlayback(user.id, titleId, "movie");
  expect(replay.resumeSeconds).toBe(0);
  await write(replay.sessionId, 0, 20);
  await write(replay.sessionId, 1, 10);
  expect((await list()).body.titles[0].positionSeconds).toBe(10);
});
it("paginates distinct titles and rejects cross-profile cursors", async () => {
  const titles = await Promise.all(Array.from({ length: 5 }, (_, i) => db.title.create({ data: { name: `Other movie ${i}` } })));
  for (const title of titles) {
    const session = await beginPlayback(user.id, title.id, "file", profileId); await write(session.sessionId, 0);
  }
  const secondFile = await beginPlayback(user.id, titles[0].id, "file-2", profileId); await write(secondFile.sessionId, 0, 40);
  const ids: string[] = []; let cursor: string | null = null;
  do {
    const page: request.Response = await request(app).get(`/api/play/continue?profileId=${profileId}&limit=2${cursor ? `&cursor=${cursor}` : ""}`).set(auth(user.token));
    expect(page.status).toBe(200); ids.push(...page.body.titles.map((title: { id: string }) => title.id)); cursor = page.body.nextCursor;
    if (cursor) expect((await request(app).get(`/api/play/continue?cursor=${cursor}`).set(auth(user.token))).status).toBe(400);
  } while (cursor);
  expect(ids).toHaveLength(5); expect(new Set(ids).size).toBe(5);
});
it("deleting a profile cascades sessions/progress without affecting account scope", async () => {
  await beginPlayback(user.id, titleId, "movie", profileId); await beginPlayback(user.id, titleId, "movie");
  await db.profile.delete({ where: { id: profileId } });
  expect(await db.playbackSession.count()).toBe(1); expect(await db.playbackProgress.count()).toBe(1);
});
it("adds tracking only for opted-in clients and reuses a stable media identity", async () => {
  await db.debridConfig.create({ data: { userId: user.id, realDebridToken: "fixture" } });
  vi.spyOn(providers.realdebrid, "unrestrictLink").mockResolvedValue({ provider: "realdebrid", url: "https://signed/video", filename: "movie.mp4", filesize: 100 });
  const legacy = await request(app).post("/api/play").set(auth(user.token)).send({ titleId });
  expect(legacy.status).toBe(200); expect(legacy.body.playback).toBeUndefined(); expect(await db.playbackSession.count()).toBe(0);
  const tracked = await request(app).post("/api/play").set(auth(user.token)).send({ titleId, profileId, trackProgress: true });
  expect(tracked.body.playback.resumeSeconds).toBe(0);
  await write(tracked.body.playback.sessionId, 0, 40);
  const again = await request(app).post("/api/play").set(auth(user.token)).send({ titleId, profileId, trackProgress: true });
  expect(again.body.playback.resumeSeconds).toBe(40);
  expect((await db.playbackProgress.findFirstOrThrow()).mediaKey).toBe(mediaKeyFor("https://host/movie", "movie.mp4", 100));
});

it("serializes concurrent progress updates by sequence", async () => {
  const session = await beginPlayback(user.id, titleId, "concurrent");
  const results = await Promise.all([write(session.sessionId, 2, 50), write(session.sessionId, 1, 20)]);
  expect(results.every(result => result.status === 200)).toBe(true);
  expect((await db.playbackProgress.findFirstOrThrow()).positionSeconds).toBe(50);
});
it("keeps active-user enforcement on progress writes", async () => {
  const session = await beginPlayback(user.id, titleId, "movie");
  await db.user.update({ where: { id: user.id }, data: { active: false } });
  expect((await write(session.sessionId, 0)).status).toBe(401);
});
