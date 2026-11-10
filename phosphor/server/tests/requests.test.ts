import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb } from "./helpers";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { MetadataDetails } from "../src/metadata/types";
import { fetchMetadata, searchMetadata } from "../src/metadata/providers";
import { accountProviderContext } from "../src/account-library";
vi.mock("../src/metadata/providers", async original => ({ ...await original<typeof import("../src/metadata/providers")>(), fetchMetadata: vi.fn(), searchMetadata: vi.fn() }));
let serial = 0;
const selection = { provider: "tmdb", id: "101", type: "movie" };
function details(id = "101", type: "movie" | "series" = "movie"): MetadataDetails {
 return { provider: "tmdb", id, type, name: "The Example", year: 2020, posterUrl: "https://image.tmdb.org/t/p/w500/example.jpg", description: "Fixture story", genres: ["Drama"], backdropUrl: null, cast: ["Fixture actor"], runtimeMinutes: 100, rating: 7, ratingSource: "TMDB", contentRating: "PG", imdbId: `tt${id.padStart(7,"0")}`, tmdbId: id, providerUrl: `https://www.themoviedb.org/movie/${id}`, fetchedAt: new Date().toISOString() };
}
async function actor(role: "admin" | "user" = "user") {
 const user = await db.user.create({ data: { email: `requests-${serial++}@example.invalid`, displayName: "Request fixture", hashedPassword: "unused-fixture-hash", role, debridConfig: { create: {} } } });
 return { ...user, token: signSession({ sub: user.id, email: user.email, role, version: user.sessionVersion }) };
}
async function requested(userId: string, id = "101", status = "requested") {
 const media = details(id);
 return db.mediaRequest.create({ data: { canonicalKey: `imdb:movie:${media.imdbId}`, provider: media.provider, externalId: id, mediaType: media.type, name: media.name, year: media.year, metadata: JSON.stringify(media), status,
 followers: { create: { userId } }, events: { create: { status, message: "Fixture request" } } } });
}
const magnet = "magnet:?xt=urn:btih:0123456789012345678901234567890123456789";
async function cloudOwner() { const owner = await actor("admin"); await db.debridConfig.update({ where: { userId: owner.id }, data: { realDebridToken: "server-private-cloud-key" } }); return owner; }
async function imported(userId: string, metadata = details()) {
 await db.debridConfig.update({ where: { userId }, data: { realDebridToken: "owner-private-import-key" } });
 const context = await accountProviderContext(userId, "realdebrid");
 const item = await db.accountMedia.create({ data: { userId, provider: "realdebrid", providerRef: "secret-provider-ref", credentialFingerprint: context.fingerprint, name: metadata.name, type: metadata.type, year: metadata.year, phase: "finished", progress: 100 } });
 await db.metadataRecord.create({ data: { targetType: "account", targetId: item.id, ownerId: userId, name: item.name, mediaType: item.type, status: "matched", data: JSON.stringify(metadata) } });
 return item;
}
beforeEach(async () => { await resetDb(); vi.clearAllMocks(); vi.mocked(fetchMetadata).mockImplementation(async input => details(input.id, input.type)); vi.mocked(searchMetadata).mockResolvedValue([details()]); });
afterEach(() => vi.restoreAllMocks());

it("requires active authentication for discovery and does not expose metadata credentials", async () => {
 expect((await request(app).get("/api/discovery/search?q=Example&type=movie")).status).toBe(401);
 const member = await actor();
 const response = await request(app).get("/api/discovery/search?q=Example&type=movie").set(auth(member.token));
 expect(response.status).toBe(200); expect(response.headers["cache-control"]).toContain("no-store"); expect(response.body.results[0].name).toBe("The Example");
 expect((await request(app).get("/api/discovery/search?q=Example&type=wrong").set(auth(member.token))).status).toBe(400);
});
it("fetches request identity server-side, ignores no forged media fields and deduplicates followers", async () => {
 const member = await actor();
 expect((await request(app).post("/api/requests").set(auth(member.token)).send({ ...selection, name: "Forged name" })).status).toBe(400);
 const first = await request(app).post("/api/requests").set(auth(member.token)).send(selection);
 expect(first.status).toBe(201); expect(first.body.request).toMatchObject({ name: "The Example", status: "requested", progress: null, following: true });
 expect(first.headers["cache-control"]).toContain("no-store");
 const second = await request(app).post("/api/requests").set(auth(member.token)).send(selection);
 expect(second.status).toBe(200); expect(second.body.request.id).toBe(first.body.request.id);
 expect(await db.mediaRequest.count()).toBe(1); expect(await db.requestFollower.count()).toBe(1);
});
it("deduplicates concurrent requests without leaking subscriber identities to other members", async () => {
 const one = await actor(), two = await actor();
 const responses = await Promise.all([request(app).post("/api/requests").set(auth(one.token)).send(selection), request(app).post("/api/requests").set(auth(two.token)).send(selection)]);
 expect(responses.map(response => response.status).sort()).toEqual([200,201]);
 expect(await db.mediaRequest.count()).toBe(1); expect(await db.requestFollower.count()).toBe(2);
 expect(JSON.stringify(responses.map(response => response.body))).not.toMatch(/subscribers|canonicalKey|sourceFingerprint|sourceUrl|providerRef|hashedPassword/);
 expect(JSON.stringify(responses.map(response => response.body))).not.toContain(one.email);
});
it("isolates request lists/details and makes unfollow local-only", async () => {
 const member = await actor(), stranger = await actor(), row = await requested(member.id);
 const network = vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Unexpected network"));
 expect((await request(app).get("/api/requests").set(auth(stranger.token))).body.requests).toEqual([]);
 expect((await request(app).get(`/api/requests/${row.id}`).set(auth(stranger.token))).status).toBe(404);
 const administrator = await actor("admin");
 expect((await request(app).get(`/api/requests/${row.id}`).set(auth(administrator.token))).status).toBe(200);
 expect((await request(app).get(`/api/requests/${row.id}`).set(auth(member.token))).body.events[0].message).toBe("Fixture request");
 expect((await request(app).post(`/api/requests/${row.id}/unfollow`).set(auth(member.token)).send({})).status).toBe(200);
 expect(await db.mediaRequest.count()).toBe(1); expect(await db.requestFollower.count()).toBe(0); expect(network).not.toHaveBeenCalled();
});
it("rejects late session revocation before following a metadata lookup", async () => {
 const member = await actor();
 vi.mocked(fetchMetadata).mockImplementationOnce(async () => { await db.user.update({ where: { id: member.id }, data: { sessionVersion: { increment: 1 } } }); return details(); });
 expect((await request(app).post("/api/requests").set(auth(member.token)).send(selection)).status).toBe(401);
 expect(await db.mediaRequest.count()).toBe(0);
});
it("enforces the active request limit while retaining idempotent follows", async () => {
 const member = await actor();
 for (let i = 0; i < 20; i++) await requested(member.id, String(200 + i));
 expect((await request(app).post("/api/requests").set(auth(member.token)).send(selection)).status).toBe(409);
 expect((await request(app).post("/api/requests").set(auth(member.token)).send({ ...selection, id: "200" })).status).toBe(200);
 expect(await db.requestFollower.count()).toBe(20);
});
it("discloses only current private imports and explicitly granted shared libraries", async () => {
 const owner = await actor("admin"), member = await actor(), item = await imported(owner.id);
 const library = await db.sharedLibrary.create({ data: { name: "Owner's shared movies", sourceUserId: owner.id, mediaType: "movie" } });
 const url = "/api/discovery/tmdb/movie/101";
 const hidden = await request(app).get(url).set(auth(member.token)); expect(hidden.body.availability).toEqual([]); expect(JSON.stringify(hidden.body)).not.toContain(item.id);
 const mine = await request(app).get(url).set(auth(owner.token)); expect(mine.body.availability.some((entry: {kind:string}) => entry.kind === "private")).toBe(true);
 await db.sharedLibraryGrant.create({ data: { libraryId: library.id, userId: member.id } });
 const visible = await request(app).get(url).set(auth(member.token)); expect(visible.body.availability).toEqual([{ kind: "shared", name: library.name, href: `/shared-libraries/${library.id}/${item.id}` }]);
 expect(JSON.stringify(visible.body)).not.toMatch(/secret-provider-ref|owner-private-import-key|credentialFingerprint/);
 expect((await request(app).post("/api/requests").set(auth(member.token)).send(selection)).status).toBe(409);
 await db.debridConfig.update({ where: { userId: owner.id }, data: { realDebridToken: "changed-key" } });
 expect((await request(app).get(url).set(auth(member.token))).body.availability).toEqual([]);
});
it("does not override a conflicting stored identity with a coincidentally equal name and year", async () => {
 const member = await actor(); await imported(member.id, details("999"));
 expect((await request(app).get("/api/discovery/tmdb/movie/101").set(auth(member.token))).body.availability).toEqual([]);
});
it("keeps member request status free of internal download configuration and refs", async () => {
 const member = await actor(), owner = await cloudOwner(), row = await requested(member.id);
 await db.mediaRequest.update({ where: { id: row.id }, data: { status: "downloading", destination: "cloud", progress: 37, sourceUserId: owner.id, sourceUrl: magnet, providerId: "realdebrid", providerRef: "private-ref", sourceFingerprint: "private-fingerprint" } });
 const response = await request(app).get(`/api/requests/${row.id}`).set(auth(member.token));
 expect(response.body.request).toMatchObject({ status: "downloading", progress: 37, destination: "cloud" });
 expect(JSON.stringify(response.body)).not.toMatch(/private-ref|private-fingerprint|sourceUrl|sourceUserId|subscribers|server-private-cloud-key/);
});
it("shows downloaded awaiting access rather than playable when a published request has no viewer grant", async () => {
 const member = await actor(), row = await requested(member.id, "101", "available");
 const response = await request(app).get(`/api/requests/${row.id}`).set(auth(member.token));
 expect(response.body.request).toMatchObject({ status: "downloaded", downloadState: "awaiting_library_access" });
});
it("requires admins and queues cloud approval without upstream mutation", async () => {
 const owner = await cloudOwner(), member = await actor(), row = await requested(member.id);
 const network = vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Unexpected network"));
 expect((await request(app).get("/api/admin/requests").set(auth(member.token))).status).toBe(403);
 expect((await request(app).post(`/api/admin/requests/${row.id}/approve`).set(auth(member.token)).send({ destination:"cloud", sourceUrl:magnet })).status).toBe(403);
 const approved = await request(app).post(`/api/admin/requests/${row.id}/approve`).set(auth(owner.token)).send({ destination:"cloud",sourceUrl:magnet,providerId:"realdebrid" });
 expect(approved.status).toBe(200); expect(approved.body.request).toMatchObject({ status:"approved", destination:"cloud", providerId:"realdebrid" });
 expect(approved.body.request.subscribers).toEqual([{ id:member.id,email:member.email,displayName:member.displayName }]);
 const saved = await db.mediaRequest.findUniqueOrThrow({ where:{id:row.id} }); expect(saved.sourceUserId).toBe(owner.id); expect(saved.sourceFingerprint).toBeTruthy(); expect(saved.startedAt).toBeNull(); expect(network).not.toHaveBeenCalled();
});
it("requires valid sources, configured owner credentials and compatible source-owned libraries", async () => {
 const owner = await cloudOwner(), other = await cloudOwner(), member = await actor(), row = await requested(member.id);
 const bad = await db.sharedLibrary.create({ data: { name:"Other private library",sourceUserId:other.id } });
 for (const sourceUrl of ["https://untrusted.invalid/file.torrent","magnet:?xt=urn:btih:invalid"]) expect((await request(app).post(`/api/admin/requests/${row.id}/approve`).set(auth(owner.token)).send({destination:"cloud",sourceUrl})).status).toBe(400);
 expect((await request(app).post(`/api/admin/requests/${row.id}/approve`).set(auth(owner.token)).send({destination:"cloud",sourceUrl:magnet,sharedLibraryId:bad.id})).status).toBe(400);
 const shows=await db.sharedLibrary.create({data:{name:"Series",sourceUserId:owner.id,mediaType:"series"}});
 expect((await request(app).post(`/api/admin/requests/${row.id}/approve`).set(auth(owner.token)).send({destination:"cloud",sourceUrl:magnet,sharedLibraryId:shows.id})).status).toBe(400);
 await db.debridConfig.update({where:{userId:owner.id},data:{realDebridToken:null}});
 expect((await request(app).post(`/api/admin/requests/${row.id}/approve`).set(auth(owner.token)).send({destination:"cloud",sourceUrl:magnet})).status).toBe(409);
 expect((await db.mediaRequest.findUniqueOrThrow({where:{id:row.id}})).status).toBe("requested");
});
it("rejects and cancels only before any external submission and preserves private source data", async () => {
 const owner = await cloudOwner(), member = await actor(), row = await requested(member.id);
 expect((await request(app).post(`/api/admin/requests/${row.id}/reject`).set(auth(owner.token)).send({reason:"No matching release selected"})).status).toBe(200);
 expect((await db.requestEvent.findFirstOrThrow({where:{requestId:row.id,status:"rejected"}})).message).toBe("No matching release selected");
 await db.mediaRequest.update({where:{id:row.id},data:{status:"downloading",sourceUserId:owner.id,startedAt:new Date(),providerRef:"preserve-ref"}});
 expect((await request(app).post(`/api/admin/requests/${row.id}/cancel`).set(auth(owner.token)).send({})).status).toBe(409);
 expect((await db.mediaRequest.findUniqueOrThrow({where:{id:row.id}})).providerRef).toBe("preserve-ref");
});
it("does not restart an ambiguous submission or grant library access during approval", async () => {
 const owner = await cloudOwner(), member = await actor(), row = await requested(member.id);
 const library=await db.sharedLibrary.create({data:{name:"Movies",sourceUserId:owner.id,mediaType:"movie"}});
 expect((await request(app).post(`/api/admin/requests/${row.id}/approve`).set(auth(owner.token)).send({destination:"cloud",sourceUrl:magnet,sharedLibraryId:library.id})).status).toBe(200);
 expect(await db.sharedLibraryGrant.count()).toBe(0);
 await db.mediaRequest.update({where:{id:row.id},data:{status:"attention",startedAt:new Date()}});
 expect((await request(app).post(`/api/admin/requests/${row.id}/approve`).set(auth(owner.token)).send({destination:"cloud",sourceUrl:magnet})).status).toBe(409);
});
it("finds a completed approved source without metadata and still requires a current library grant", async () => {
 const owner = await cloudOwner(), member = await actor(), other = await actor(), row = await requested(member.id);
 const context = await accountProviderContext(owner.id,"realdebrid");
 const item = await db.accountMedia.create({data:{userId:owner.id,provider:"realdebrid",providerRef:"approved-private-ref",credentialFingerprint:context.fingerprint,name:"Unrecognized filename",type:"movie",phase:"finished",progress:100}});
 const library=await db.sharedLibrary.create({data:{name:"Published movies",sourceUserId:owner.id,mediaType:"movie",grants:{create:{userId:member.id}}}});
 await db.mediaRequest.update({where:{id:row.id},data:{status:"available",destination:"cloud",sourceUserId:owner.id,providerId:"realdebrid",providerRef:"approved-private-ref",sourceFingerprint:context.fingerprint,sharedLibraryId:library.id}});
 const known = await request(app).get("/api/discovery/tmdb/movie/101").set(auth(member.token));
 expect(known.body.availability).toEqual([{kind:"shared",name:library.name,href:`/shared-libraries/${library.id}/${item.id}`}]);
 expect(known.body.request.status).toBe("available");
 const follow = await request(app).post("/api/requests").set(auth(other.token)).send(selection);
 expect(follow.status).toBe(200);expect(follow.body.request).toMatchObject({status:"downloaded",downloadState:"awaiting_library_access"});
 expect(await db.mediaRequest.count()).toBe(1);expect((await db.mediaRequest.findUniqueOrThrow({where:{id:row.id}})).status).toBe("available");
 expect(await db.requestEvent.count({where:{requestId:row.id,message:{contains:"Another member"}}})).toBe(1);
 await db.metadataRecord.create({data:{targetType:"account",targetId:item.id,ownerId:owner.id,name:item.name,mediaType:"movie",data:JSON.stringify(details("999"))}});
 expect((await request(app).get("/api/discovery/tmdb/movie/101").set(auth(member.token))).body.availability).toEqual([]);
});
it("validates local approval ownership and never contacts qBittorrent during approval", async () => {
 const owner = await actor("admin"), other = await actor("admin"), member = await actor(), row = await requested(member.id);
 const network = vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Unexpected network"));
 const configured = await request(app).put("/api/admin/request-settings").set(auth(owner.token)).send({qbit:{enabled:true,baseUrl:"http://qbittorrent:8080",username:"fixture-admin",password:"private-qbit-password"}});
 expect(configured.status).toBe(200);
 expect((await request(app).post(`/api/admin/requests/${row.id}/approve`).set(auth(other.token)).send({destination:"local",sourceUrl:magnet})).status).toBe(409);
 const approved = await request(app).post(`/api/admin/requests/${row.id}/approve`).set(auth(owner.token)).send({destination:"local",sourceUrl:magnet});
 expect(approved.status).toBe(200);expect(approved.body.request).toMatchObject({status:"approved",destination:"local",progress:null});
 expect(JSON.stringify(approved.body)).not.toContain("private-qbit-password");expect(network).not.toHaveBeenCalled();
});
it("reconciles an existing cloud reference through the owning administrator without re-submission", async () => {
 const owner = await cloudOwner(), other = await cloudOwner(), member = await actor(), row = await requested(member.id);
 const context = await accountProviderContext(owner.id,"realdebrid");
 await db.mediaRequest.update({where:{id:row.id},data:{status:"attention",destination:"cloud",sourceUserId:owner.id,providerId:"realdebrid",sourceUrl:magnet,sourceFingerprint:context.fingerprint,startedAt:new Date()}});
 const network = vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Unexpected network"));
 expect((await request(app).post(`/api/admin/requests/${row.id}/resume`).set(auth(other.token)).send({reference:"existing-transfer"})).status).toBe(409);
 const resumed = await request(app).post(`/api/admin/requests/${row.id}/resume`).set(auth(owner.token)).send({reference:"existing-transfer"});
 expect(resumed.status).toBe(200);expect(resumed.body.request.status).toBe("queued");
 expect((await db.mediaRequest.findUniqueOrThrow({where:{id:row.id}})).providerRef).toBe("existing-transfer");expect(network).not.toHaveBeenCalled();
});

it("recovers only proven preflight-blocked approvals without restarting ambiguous submissions", async () => {
 const owner = await cloudOwner(), replacement = await cloudOwner(), member = await actor();
 const row = await requested(member.id, "102", "attention");
 await db.mediaRequest.update({where:{id:row.id},data:{destination:"cloud",sourceUserId:owner.id,providerId:"realdebrid",sourceUrl:magnet,sourceFingerprint:"old-binding",downloadState:"approval_blocked",error:"Restore connection",startedAt:null,providerRef:null}});
 const approved = await request(app).post(`/api/admin/requests/${row.id}/approve`).set(auth(replacement.token)).send({destination:"cloud",sourceUrl:magnet,providerId:"realdebrid"});
 expect(approved.status).toBe(200);
 const saved = await db.mediaRequest.findUniqueOrThrow({where:{id:row.id}});
 expect(saved).toMatchObject({status:"approved",sourceUserId:replacement.id,downloadState:null,error:null,startedAt:null,providerRef:null});
 expect(saved.sourceFingerprint).toBe((await accountProviderContext(replacement.id,"realdebrid")).fingerprint);
 for (const action of ["reject","cancel"]) {
   const blocked = await requested(member.id, action === "reject" ? "103" : "104", "attention");
   await db.mediaRequest.update({where:{id:blocked.id},data:{sourceUserId:owner.id,downloadState:"approval_blocked",startedAt:null,providerRef:null}});
   expect((await request(app).post(`/api/admin/requests/${blocked.id}/${action}`).set(auth(owner.token)).send({})).status).toBe(200);
 }
 const ambiguous = await requested(member.id,"105","attention");
 expect((await request(app).post(`/api/admin/requests/${ambiguous.id}/approve`).set(auth(owner.token)).send({destination:"cloud",sourceUrl:magnet})).status).toBe(409);
});

it("allows new requests after twenty completed local downloads without treating them as active work", async () => {
 const member = await actor();
 for (let i = 0; i < 20; i++) {
   const row = await requested(member.id, String(300 + i), "downloaded");
   await db.mediaRequest.update({where:{id:row.id},data:{destination:"local",progress:100,downloadState:"awaiting_library_import",downloadedAt:new Date()}});
 }
 const response = await request(app).post("/api/requests").set(auth(member.token)).send(selection);
 expect(response.status).toBe(201);expect(response.body.request.status).toBe("requested");
 expect(await db.requestFollower.count({where:{userId:member.id}})).toBe(21);
});
