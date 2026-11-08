import request from "supertest";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { getProvider } from "../src/providers/registry";
import { cloudContext, resumeRequestPolling, runRequestJob } from "../src/requests/worker";
import { qbitContext } from "../src/requests/config";
import { QbitClient, normalizeQbitUrl, validateMagnet } from "../src/requests/clients";
vi.mock("../src/providers/registry", () => ({ getProvider: vi.fn() }));
const magnet = "magnet:?xt=urn:btih:" + "1".repeat(40);
const add = vi.fn(), poll = vi.fn(); let serial = 0;
async function owner(role = "admin") {
 const user = await db.user.create({ data: { email: `worker-${serial++}@example.invalid`, displayName: "Operator", hashedPassword: "fixture", role, debridConfig: { create: { realDebridToken: "original-cloud-key" } } } });
 return { ...user, token: signSession({ sub:user.id,email:user.email,role:role === "admin" ? "admin" : "user",version:user.sessionVersion }) };
}
async function approved(destination: "cloud"|"local" = "cloud") {
 const admin = await owner();
 if (destination === "local") await db.setting.upsert({ where:{key:"requests.qbit"},create:{key:"requests.qbit",value:JSON.stringify({enabled:true,baseUrl:"https://qbit.fixture.invalid",username:"operator",password:"never-return-password",ownerId:admin.id})},update:{} });
 const ctx = destination === "cloud" ? await cloudContext(admin.id,"realdebrid") : await qbitContext(admin.id);
 const job = await db.mediaRequest.create({data:{canonicalKey:`fixture:${serial++}`,provider:"tmdb",externalId:"1",mediaType:"movie",name:"Example movie",year:2020,metadata:"{}",status:"approved",destination,sourceUserId:admin.id,sourceUrl:magnet,providerId:destination === "cloud" ? "realdebrid" : null,sourceFingerprint:ctx.fingerprint}});
 return {admin,job};
}
const status = (phase="downloading",progress:unknown=37) => ({id:"known-ref",provider:"realdebrid",name:"Example movie",phase,progress,links:[]});
async function due(id:string) { await db.mediaRequest.update({where:{id},data:{nextPollAt:new Date(0),leaseUntil:null}}); }
function loginResponse() { return new Response("Ok.",{headers:{"Set-Cookie":"SID=0123456789abcdef0123456789abcdef; HttpOnly; path=/"}}); }
beforeEach(async()=>{await resetDb();vi.clearAllMocks();vi.mocked(getProvider).mockReturnValue({addTorrent:add,getTorrentStatus:poll} as unknown as ReturnType<typeof getProvider>);add.mockResolvedValue(status());poll.mockResolvedValue(status());});
afterEach(()=>vi.restoreAllMocks());
it("submits cloud magnets only once and persists actual progress before read-only polling",async()=>{
 const {job}=await approved();await runRequestJob();expect(add).toHaveBeenCalledTimes(1);
 expect(await db.mediaRequest.findUniqueOrThrow({where:{id:job.id}})).toMatchObject({status:"downloading",providerRef:"known-ref",progress:37,leaseUntil:null});
 await due(job.id);poll.mockResolvedValue(status("downloading",61));await runRequestJob();expect(add).toHaveBeenCalledTimes(1);expect(poll).toHaveBeenCalledTimes(1);
 expect((await db.mediaRequest.findUniqueOrThrow({where:{id:job.id}})).progress).toBe(61);
});
it("leases prevent concurrent worker processes from submitting the same request twice",async()=>{
 const {job}=await approved();let release!:(v:unknown)=>void;add.mockImplementation(()=>new Promise(done=>{release=done;}));
 const first=runRequestJob();await vi.waitFor(()=>expect(add).toHaveBeenCalledTimes(1));expect(await runRequestJob()).toBe(false);release(status());await first;
 expect(add).toHaveBeenCalledTimes(1);expect((await db.mediaRequest.findUniqueOrThrow({where:{id:job.id}})).providerRef).toBe("known-ref");
});
it("never resubmits an interrupted submitting record even with a very recent startedAt",async()=>{
 const {job}=await approved();await db.mediaRequest.update({where:{id:job.id},data:{status:"submitting",startedAt:new Date(),leaseUntil:new Date(0)}});
 await runRequestJob();expect(add).not.toHaveBeenCalled();expect((await db.mediaRequest.findUniqueOrThrow({where:{id:job.id}})).status).toBe("attention");
 await due(job.id);expect(await runRequestJob()).toBe(false);
});
it("retains an interrupted known reference and resumes polling without adding",async()=>{
 const {job}=await approved();await db.mediaRequest.update({where:{id:job.id},data:{status:"submitting",providerRef:"known-ref",startedAt:new Date(),leaseUntil:new Date(0)}});
 await runRequestJob();await due(job.id);await runRequestJob();expect(add).not.toHaveBeenCalled();expect(poll).toHaveBeenCalledTimes(1);
});
it("leaves ambiguous submission in attention and requires an existing reference for recovery",async()=>{
 const {admin,job}=await approved();add.mockRejectedValue(new Error("private URL and token should not escape"));await runRequestJob();
 const saved=await db.mediaRequest.findUniqueOrThrow({where:{id:job.id}});expect(saved.status).toBe("attention");expect(saved.error).not.toContain("private URL");
 await expect(resumeRequestPolling(job.id,admin.id)).rejects.toThrow(/Inspect the destination/);
 await resumeRequestPolling(job.id,admin.id,"known-ref");await runRequestJob();expect(add).toHaveBeenCalledTimes(1);expect(poll).toHaveBeenCalledTimes(1);
});
it("preserves a confirmed reference when keys change during submission and refuses polling through new keys",async()=>{
 const {admin,job}=await approved();add.mockImplementation(async()=>{await db.debridConfig.update({where:{userId:admin.id},data:{realDebridToken:"changed-key"}});return status();});
 await runRequestJob();expect(await db.mediaRequest.findUniqueOrThrow({where:{id:job.id}})).toMatchObject({status:"attention",providerRef:"known-ref"});
 await expect(resumeRequestPolling(job.id,admin.id)).rejects.toThrow(/changed/);expect(poll).not.toHaveBeenCalled();
 await db.debridConfig.update({where:{userId:admin.id},data:{realDebridToken:"original-cloud-key"}});await resumeRequestPolling(job.id,admin.id);await runRequestJob();expect(add).toHaveBeenCalledTimes(1);expect(poll).toHaveBeenCalledTimes(1);
});
it("does not invent progress when a provider omits it",async()=>{
 const {job}=await approved();add.mockResolvedValue({...status("queued"),progress:undefined});await runRequestJob();expect((await db.mediaRequest.findUniqueOrThrow({where:{id:job.id}})).progress).toBeNull();
});
it("cloud completion stays downloaded until a current import is published in the selected library",async()=>{
 const {admin,job}=await approved();const library=await db.sharedLibrary.create({data:{name:"Movies",sourceUserId:admin.id,mediaType:"movie"}});await db.mediaRequest.update({where:{id:job.id},data:{sharedLibraryId:library.id}});
 add.mockResolvedValue(status("finished",100));await runRequestJob();expect((await db.mediaRequest.findUniqueOrThrow({where:{id:job.id}})).status).toBe("downloaded");expect(await db.accountScan.count()).toBe(1);
 await due(job.id);await runRequestJob();expect((await db.mediaRequest.findUniqueOrThrow({where:{id:job.id}})).status).toBe("downloaded");
 await db.accountMedia.create({data:{userId:admin.id,provider:"realdebrid",providerRef:"known-ref",credentialFingerprint:job.sourceFingerprint!,name:"Example movie",type:"movie",phase:"finished",progress:100}});
 await due(job.id);await runRequestJob();expect((await db.mediaRequest.findUniqueOrThrow({where:{id:job.id}})).status).toBe("available");
});
it("qBittorrent uses its session cookie and avoids re-adding an already present approved hash",async()=>{
 const fetch=vi.spyOn(globalThis,"fetch").mockImplementation(async(url,init)=>{
  if(String(url).endsWith("/auth/login"))return loginResponse();expect((init?.headers as Record<string,string>).Cookie).toMatch(/^SID=/);
  return new Response(JSON.stringify([{hash:"1".repeat(40),state:"downloading",progress:0.42,completion_on:0}]));
 });
 const ctx={enabled:true,baseUrl:"https://qbit.fixture.invalid",username:"operator",password:"private",ownerId:"fixture"};const client=new QbitClient(ctx);await client.login();expect(await client.add(magnet,"request-id")).toMatchObject({phase:"downloading",progress:42});expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([["pausedDL","queued","paused"],["stoppedDL","queued","paused"],["stalledDL","queued","waiting_for_peers"],["checkingDL","queued","checking"],["metaDL","queued","fetching_metadata"]])("reports qBittorrent state %s without calling it an active download",async(state,phase,label)=>{
 vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify([{hash:"1".repeat(40),state,progress:0.42,completion_on:0}])));
 const client=new QbitClient({enabled:true,baseUrl:"https://qbit.fixture.invalid",username:"operator",password:"private",ownerId:"fixture"});expect(await client.info("1".repeat(40))).toMatchObject({phase,state:label,progress:42});
});
it("keeps completed local transfers downloaded without claiming browser library availability",async()=>{
 const {job}=await approved("local");vi.spyOn(QbitClient.prototype,"login").mockResolvedValue();vi.spyOn(QbitClient.prototype,"add").mockResolvedValue({ref:"1".repeat(40),phase:"finished",progress:100,state:"completed"});
 await runRequestJob();await due(job.id);await runRequestJob();expect((await db.mediaRequest.findUniqueOrThrow({where:{id:job.id}})).status).toBe("downloaded");expect(await db.accountScan.count()).toBe(0);
});
it("validates magnet identity and rejects unsafe client URL shapes",()=>{
 expect(validateMagnet(magnet)).toBe("1".repeat(40));expect(validateMagnet("magnet:?xt=urn:btih:"+"A".repeat(32))).toBe("0".repeat(40));
 for(const value of ["https://example.invalid/file.torrent","magnet:?xt=urn:btih:bad","magnet:?xt=urn:btih:"+"1".repeat(40)+"&xt=urn:btih:"+"2".repeat(40)])expect(()=>validateMagnet(value)).toThrow();
 for(const value of ["file:///etc/passwd","https://name:secret@example.invalid","https://example.invalid/?key=secret"])expect(()=>normalizeQbitUrl(value)).toThrow();
});
it("caps client responses and rejects authentication without a valid SID",async()=>{
 vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response("Ok.",{headers:{"Set-Cookie":"SID=unsafe-cookie"}}));const client=new QbitClient({enabled:true,baseUrl:"https://qbit.fixture.invalid",username:"operator",password:"private",ownerId:"fixture"});await expect(client.login()).rejects.toThrow(/authentication/);
 vi.mocked(fetch).mockResolvedValue(new Response("x".repeat(1024*1024+1)));await expect(client.info("1".repeat(40))).rejects.toThrow(/allowed size/);
});
it.each(["demoted","deleted","inactive"])("keeps saved qBittorrent secrets owner-scoped and safely resets an abandoned %s owner connection",async(reason)=>{
 const first=await owner(), second=await owner();
 const saved=await request(app).put("/api/admin/request-settings").set(auth(first.token)).send({qbit:{enabled:true,baseUrl:"http://qbit.fixture.invalid:8080",username:"operator",password:"never-return-password"}});expect(saved.status).toBe(200);expect(JSON.stringify(saved.body)).not.toContain("never-return-password");
 const other=await request(app).get("/api/admin/request-settings").set(auth(second.token));expect(other.body.settings.qbit).toMatchObject({ownedByYou:false,baseUrl:"",username:"",canReset:false});
 expect((await request(app).post("/api/admin/request-settings/reset").set(auth(second.token))).status).toBe(409);
 if(reason === "deleted") await db.user.delete({where:{id:first.id}});
 else await db.user.update({where:{id:first.id},data:reason === "inactive"?{active:false}:{role:"user"}});
 expect((await request(app).get("/api/admin/request-settings").set(auth(second.token))).body.settings.qbit.canReset).toBe(true);
 const reset=await request(app).post("/api/admin/request-settings/reset").set(auth(second.token));expect(reset.status).toBe(200);expect(reset.body.settings.qbit).toMatchObject({ownedByYou:true,enabled:false,passwordConfigured:false,baseUrl:"",username:""});
 expect((await request(app).put("/api/admin/request-settings").set(auth(second.token)).send({qbit:{enabled:true,baseUrl:"http://qbit.fixture.invalid",username:"operator"}})).status).toBe(400);
});

it("keeps known preflight failures blocked for a new explicit approval without attempting a transfer",async()=>{
 const {admin,job}=await approved();await db.debridConfig.update({where:{userId:admin.id},data:{realDebridToken:null}});await runRequestJob();
 expect(add).not.toHaveBeenCalled();expect(await db.mediaRequest.findUniqueOrThrow({where:{id:job.id}})).toMatchObject({status:"attention",startedAt:null,providerRef:null,downloadState:"approval_blocked"});
 await due(job.id);expect(await runRequestJob()).toBe(false);
});
it("treats a local authentication failure as not submitted and does not automatically retry it",async()=>{
 const {job}=await approved("local");vi.spyOn(QbitClient.prototype,"login").mockRejectedValue(new Error("invalid password"));const submit=vi.spyOn(QbitClient.prototype,"add");await runRequestJob();
 expect(submit).not.toHaveBeenCalled();expect(await db.mediaRequest.findUniqueOrThrow({where:{id:job.id}})).toMatchObject({status:"attention",downloadState:"approval_blocked",startedAt:null});
});
it("requires an upload/completed state before local download completion",async()=>{
 vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify([{hash:"1".repeat(40),state:"checkingUP",progress:1,completion_on:1000}])));
 const client=new QbitClient({enabled:true,baseUrl:"https://qbit.fixture.invalid",username:"operator",password:"private",ownerId:"fixture"});expect(await client.info("1".repeat(40))).toMatchObject({phase:"queued",progress:100,state:"checking"});
});
it("preserves blank saved passwords and disables the client when the owner explicitly clears it",async()=>{
 const first=await owner();expect((await request(app).put("/api/admin/request-settings").set(auth(first.token)).send({qbit:{enabled:true,baseUrl:"https://qbit.fixture.invalid",username:"operator",password:"preserve-fixture"}})).status).toBe(200);
 expect((await request(app).put("/api/admin/request-settings").set(auth(first.token)).send({qbit:{password:""}})).body.settings.qbit.passwordConfigured).toBe(true);
 expect((await qbitContext(first.id)).settings.password).toBe("preserve-fixture");
 const cleared=await request(app).put("/api/admin/request-settings").set(auth(first.token)).send({qbit:{clearPassword:true}});expect(cleared.status).toBe(200);expect(cleared.body.settings.qbit).toMatchObject({enabled:false,passwordConfigured:false});
});
it("requires administrator access for local client settings and never fetches on configuration saves",async()=>{
 const member=await owner("user"),admin=await owner();const fetch=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("No upstream configuration requests"));
 expect((await request(app).get("/api/admin/request-settings")).status).toBe(401);expect((await request(app).get("/api/admin/request-settings").set(auth(member.token))).status).toBe(403);
 expect((await request(app).put("/api/admin/request-settings").set(auth(admin.token)).send({qbit:{enabled:true,baseUrl:"https://qbit.fixture.invalid",username:"operator",password:"fake-password"}})).status).toBe(200);expect(fetch).not.toHaveBeenCalled();
});

it("accepts qBittorrent v4 base64 session cookies without allowing cookie separators", async () => {
 const { QbitClient } = await import("../src/requests/clients");
 const sid="AbCdEfGhIjKlMnOpQrStUv+/12345678=";
 const fetch=vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(new Response("Ok.",{headers:{"set-cookie":`SID=${sid}; HttpOnly; path=/; SameSite=Strict`}})).mockResolvedValueOnce(new Response("[]"));
 const client=new QbitClient({enabled:true,baseUrl:"http://127.0.0.1:8082",username:"admin",password:"fake-password-only",ownerId:"fixture"});
 await client.login();expect(await client.info("1".repeat(40))).toBeNull();
 expect(new Headers(fetch.mock.calls[1][1]?.headers).get("Cookie")).toBe(`SID=${sid}`);
});
