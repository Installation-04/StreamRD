import { createHash } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb, adminAndUser } from "./helpers";
import { db } from "../src/db";
import { config } from "../src/config";
import { DEFAULT_SERVER_SETTINGS, saveServerSettings } from "../src/settings";
const product = process.cwd().includes("phosphor") ? "phosphor" : "streamrd";
const roots = [config.mediaSourceRoot, config.mediaLibraryRoot];
beforeEach(async () => { await resetDb(); config.mediaSourceRoot = "/private/source"; config.mediaLibraryRoot = "/private/library"; });
afterEach(() => { [config.mediaSourceRoot, config.mediaLibraryRoot] = roots; vi.restoreAllMocks(); });
it("requires login and gives members actionable setup without admin paths or secrets", async () => {
  expect((await request(app).get("/api/account/setup")).status).toBe(401);
  const { user } = await adminAndUser();
  const res = await request(app).get("/api/account/setup").set(auth(user.token));
  expect(res.status).toBe(200); expect(res.headers["cache-control"]).toContain("no-store");
  expect(res.body.configurationReady).toBe(false); expect(res.body.connectionVerified).toBe(false);
  expect(res.body.progress).toEqual({ completed: 1, total: 3 }); expect(res.body.library).toBeUndefined();
  expect(res.body.checks.every((c: { href: string | null }) => !c.href?.startsWith("/admin"))).toBe(true);
  expect(res.body.checks.map((c: { id: string }) => c.id)).not.toContain("account-library");   // importing is the administrator's; members are not sent to a page that refuses them
  expect(res.body.checks.every((c: { href: string | null }) => c.href !== "/library")).toBe(true);
  expect(JSON.stringify(res.body)).not.toContain("/private"); expect(JSON.stringify(res.body)).not.toContain(config.jwtSecret);
  expect(res.body.product).toBe(product);
});
it("isolates account credentials and never calls providers or claims verification", async () => {
  const { admin, user } = await adminAndUser();
  await db.debridConfig.update({ where: { userId: admin.id }, data: { realDebridToken: "private-credential-marker" } });
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No upstream request expected"));
  const mine = await request(app).get("/api/account/setup").set(auth(admin.token));
  expect(mine.body.providers.find((p: { id: string }) => p.id === "realdebrid")).toMatchObject({ configured: true, eligible: true, verification: "not-tested" });
  expect(JSON.stringify(mine.body)).not.toContain("private-credential-marker");
  expect((await request(app).get("/api/account/setup").set(auth(user.token))).body.providers.every((p: { configured: boolean }) => !p.configured)).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it("does not count globally disabled providers as usable configuration", async () => {
  const { admin } = await adminAndUser();
  await db.debridConfig.update({ where: { userId: admin.id }, data: { realDebridToken: "fixture" } });
  await saveServerSettings({ ...DEFAULT_SERVER_SETTINGS, disabledProviders: ["realdebrid"] });
  const res = await request(app).get("/api/account/setup").set(auth(admin.token));
  expect(res.body.providers.find((p: { id: string }) => p.id === "realdebrid")).toMatchObject({ configured: true, eligible: false, enabled: false });
  expect(res.body.checks.find((c: { id: string }) => c.id === "providers").status).toBe("action");
});
it("keeps the optional library separate from required configuration and honors admin role changes", async () => {
  const { admin } = await adminAndUser();
  const res = await request(app).get("/api/account/setup").set(auth(admin.token));
  expect(res.body.library).toEqual({ configured: true, verification: "not-tested" });
  expect(res.body.checks.find((c: { id: string }) => c.id === "library").required).toBe(false);
  await db.user.update({ where: { id: admin.id }, data: { role: "user" } });
  const changed = await request(app).get("/api/account/setup").set(auth(admin.token));
  expect(changed.body.role).toBe("user"); expect(changed.body.library).toBeUndefined();
});
it("lets granted viewers finish onboarding without personal provider keys or indexers", async () => {
 const {admin,user}=await adminAndUser();
 const key="shared-server-fixture-key";
 await db.debridConfig.update({where:{userId:admin.id},data:{realDebridToken:key}});
 const credentialFingerprint=createHash("sha256").update(JSON.stringify([admin.id,"realdebrid",key,""])).digest("hex");
 await db.accountMedia.create({data:{userId:admin.id,provider:"realdebrid",providerRef:"private-owner-ref",credentialFingerprint,name:"Server movie",phase:"finished",progress:100}});
 const library=await db.sharedLibrary.create({data:{name:"Movie night",sourceUserId:admin.id,grants:{create:{userId:user.id}}}});
 const fetch=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Unexpected setup provider request"));
 const response=await request(app).get("/api/account/setup").set(auth(user.token));
 expect(response.status).toBe(200);expect(response.body.configurationReady).toBe(true);
 expect(response.body.sharedLibraries).toEqual({libraryCount:1,readyCount:1});
 expect(response.body.checks.find((c:{id:string})=>c.id==="providers")).toMatchObject({required:false,status:"complete",href:"/shared-libraries"});
 expect(response.body.providers.every((p:{configured:boolean})=>!p.configured)).toBe(true);
 expect(JSON.stringify(response.body)).not.toMatch(/shared-server-fixture-key|private-owner-ref|credentialFingerprint/);
 expect(fetch).not.toHaveBeenCalled();
 await db.sharedLibraryGrant.delete({where:{libraryId_userId:{libraryId:library.id,userId:user.id}}});
 const removed=await request(app).get("/api/account/setup").set(auth(user.token));
 expect(removed.body.sharedLibraries).toEqual({libraryCount:0,readyCount:0});expect(removed.body.configurationReady).toBe(false);
});
it("does not claim playable sharing when its source credentials are missing or the library is disabled", async () => {
 const {admin,user}=await adminAndUser();
 const library=await db.sharedLibrary.create({data:{name:"Empty server library",sourceUserId:admin.id,grants:{create:{userId:user.id}}}});
 const response=await request(app).get("/api/account/setup").set(auth(user.token));
 expect(response.body.sharedLibraries).toEqual({libraryCount:1,readyCount:0});expect(response.body.configurationReady).toBe(false);
 await db.sharedLibrary.update({where:{id:library.id},data:{enabled:false}});
 const disabled=await request(app).get("/api/account/setup").set(auth(user.token));
 expect(disabled.body.sharedLibraries).toEqual({libraryCount:0,readyCount:0});
});
