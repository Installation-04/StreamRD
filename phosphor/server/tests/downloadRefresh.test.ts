import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db } from "../src/db";
import { app, auth, resetDb } from "./helpers";
import { signSession } from "../src/auth/jwt";
import { debridManager } from "../src/providers/manager";
import { ProviderError } from "../src/providers/types";
import { clearDownloadRefreshCache } from "../src/downloadRefresh";
let userId: string, token: string, jobId: string;
beforeEach(async () => {
  await resetDb(); clearDownloadRefreshCache();
  const user = await db.user.create({ data: { email: "refresh@test.local", displayName: "Refresh", hashedPassword: "not-for-login", debridConfig: { create: { realDebridToken: "fixture" } } } });
  userId = user.id; token = signSession({ sub: user.id, email: user.email, role: "user" });
  jobId = (await db.downloadJob.create({ data: { userId, title: "Job", sourceUrl: "magnet:fixture", provider: "realdebrid", providerRef: "ref", status: "downloading", progress: 20 } })).id;
});
afterEach(() => vi.restoreAllMocks());
const refresh = () => request(app).post(`/api/downloads/${jobId}/refresh`).set(auth(token));
const pending = { provider: "realdebrid" as const, id: "ref", name: "Job", phase: "downloading" as const, progress: 40, links: [] };
it("coalesces simultaneous refreshes and briefly caches repeated requests", async () => {
  const mock = vi.spyOn(debridManager, "refresh").mockResolvedValue({ status: pending });
  const responses = await Promise.all([refresh(), refresh(), refresh()]);
  expect(responses.every(response => response.status === 200 && response.body.job.progress === 40)).toBe(true);
  await refresh(); expect(mock).toHaveBeenCalledTimes(1);
});
it("preserves active jobs after temporary provider failures and recovers", async () => {
  const mock = vi.spyOn(debridManager, "refresh").mockRejectedValue(new ProviderError("realdebrid", "overloaded", 503));
  const result = await refresh();
  expect(result.status).toBe(503); expect(result.headers["retry-after"]).toBe("8");
  expect(result.body).toMatchObject({ retryable: true, retryAfterMs: 8000, job: { status: "downloading", progress: 20 } });
  clearDownloadRefreshCache(); mock.mockResolvedValue({ status: pending });
  const recovered = await refresh(); expect(recovered.body.job).toMatchObject({ status: "downloading", progress: 40, error: null });
});
it("makes permanent authentication failures terminal", async () => {
  vi.spyOn(debridManager, "refresh").mockRejectedValue(new ProviderError("realdebrid", "invalid credentials", 401));
  const result = await refresh(); expect(result.status).toBe(502); expect(result.body.retryable).toBe(false); expect(result.body.job.status).toBe("error");
});
it("does not leak cached jobs across accounts or after deletion", async () => {
  vi.spyOn(debridManager, "refresh").mockResolvedValue({ status: pending }); await refresh();
  const other = await db.user.create({ data: { email: "other@test.local", displayName: "Other", hashedPassword: "not-for-login" } });
  const otherToken = signSession({ sub: other.id, email: other.email, role: "user" });
  expect((await request(app).post(`/api/downloads/${jobId}/refresh`).set(auth(otherToken))).status).toBe(404);
  await db.downloadJob.delete({ where: { id: jobId } }); expect((await refresh()).status).toBe(404);
});
it("invalidates refresh sharing when credentials change", async () => {
  const mock = vi.spyOn(debridManager, "refresh").mockResolvedValue({ status: pending }); await refresh();
  await db.debridConfig.update({ where: { userId }, data: { realDebridToken: "new-fixture" } });
  await refresh(); expect(mock).toHaveBeenCalledTimes(2);
});
it("keeps finished-but-unresolved transfers active for another attempt", async () => {
  vi.spyOn(debridManager, "refresh").mockResolvedValue({ status: { ...pending, phase: "finished", progress: 100 } });
  expect((await refresh()).body.job).toMatchObject({ status: "downloading", progress: 100 });
});
it("does not resurrect a job removed during a provider request", async () => {
  vi.spyOn(debridManager, "refresh").mockImplementation(async () => { await db.downloadJob.delete({ where: { id: jobId } }); return { status: pending }; });
  expect((await refresh()).status).toBe(404); expect(await db.downloadJob.count()).toBe(0);
});
