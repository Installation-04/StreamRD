import request from "supertest";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { config } from "../src/config";
import { db } from "../src/db";
import { signSession } from "../src/auth/jwt";
import { hashPassword } from "../src/auth/passwords";
import * as passwords from "../src/auth/passwords";
import { invitationHash, REGISTRATION_KEY, settleRegistrationDefault } from "../src/auth/access";
import { app, auth, resetDb } from "./helpers";

let passwordHash: string;
let admin: {id: string; token: string};
let member: {id: string; token: string};
const originalAdminEmail = config.adminEmail;
beforeAll(async () => { passwordHash = await hashPassword("password123"); });
beforeEach(async () => {
  await resetDb();
  config.adminEmail = "";
  const a = await db.user.create({data:{email:"admin@access.test",displayName:"Owner",role:"admin",hashedPassword:passwordHash}});
  const u = await db.user.create({data:{email:"member@access.test",displayName:"Member",hashedPassword:passwordHash}});
  admin = {id:a.id,token:signSession({sub:a.id,email:a.email,role:"admin"})};
  member = {id:u.id,token:signSession({sub:u.id,email:u.email,role:"user"})};
});
afterEach(() => { config.adminEmail = originalAdminEmail; vi.restoreAllMocks(); });
const signupBody = (email="invited@access.test",inviteToken?:string) => ({email,password:"password123",displayName:"Guest",...(inviteToken?{inviteToken}:{})});
const policy = (mode:"open"|"invite"|"closed") => request(app).put("/api/admin/access").set(auth(admin.token)).send({mode});
async function invite(email="invited@access.test") {
  const result=await request(app).post("/api/admin/invitations").set(auth(admin.token)).send({email});
  expect(result.status).toBe(201);
  return result.body as {inviteToken:string;invitation:{id:string;email:string;status:string}};
}

it("keeps registration open where the administrator chose it",async()=>{
  const status=await request(app).get("/api/auth/registration");
  expect(status.body).toEqual({mode:"open",bootstrapAvailable:false});
  expect(status.headers["cache-control"]).toContain("no-store");
  const created=await request(app).post("/api/auth/signup").send(signupBody());
  expect(created.status).toBe(201);expect(created.body.user.role).toBe("user");
});

it("is invitation only where nobody chose: the first account sets the server up, everyone after needs an invitation",async()=>{
  await db.setting.deleteMany({where:{key:"auth.registration"}});
  expect((await request(app).get("/api/auth/registration")).body).toEqual({mode:"invite",bootstrapAvailable:false});
  expect((await request(app).get("/api/admin/access").set(auth(admin.token))).body.mode).toBe("invite");
  const refused=await request(app).post("/api/auth/signup").send(signupBody());
  expect(refused.status).toBe(403);expect(refused.body.error).toBe("An invitation is required to create an account");
  const {inviteToken}=await invite("invited@access.test");
  const joined=await request(app).post("/api/auth/signup").send({...signupBody("invited@access.test"),inviteToken});
  expect(joined.status).toBe(201);expect(joined.body.user.role).toBe("user");
  // A brand-new server: no policy saved, no accounts. The owner creates the first account without an invitation and becomes the administrator.
  await db.invitation.deleteMany();await db.user.deleteMany();
  expect((await request(app).get("/api/auth/registration")).body).toEqual({mode:"invite",bootstrapAvailable:true});
  const owner=await request(app).post("/api/auth/signup").send(signupBody("owner@access.test"));
  expect(owner.status).toBe(201);expect(owner.body.user.role).toBe("admin");
  expect((await request(app).post("/api/auth/signup").send(signupBody("next@access.test"))).status).toBe(403);
  // A server with accounts and no saved choice gets the default written down once, with a sentence for the log; a saved choice is left alone.
  await db.setting.deleteMany({where:{key:"auth.registration"}});
  expect(await settleRegistrationDefault()).toMatch(/New accounts now need an invitation/);
  expect(JSON.parse((await db.setting.findUniqueOrThrow({where:{key:"auth.registration"}})).value)).toEqual({mode:"invite"});
  expect(await settleRegistrationDefault()).toBeNull();
  // The administrator can still open it.
  expect((await request(app).put("/api/admin/access").set({Authorization:`Bearer ${owner.body.token}`}).send({mode:"open"})).status).toBe(200);
  expect((await request(app).post("/api/auth/signup").send(signupBody("next@access.test"))).status).toBe(201);
});

it("limits policy, invitation and session administration to admins",async()=>{
  for(const path of ["/api/admin/access","/api/admin/invitations"]){
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).get(path).set(auth(member.token))).status).toBe(403);
  }
  expect((await request(app).put("/api/admin/access").set(auth(member.token)).send({mode:"closed"})).status).toBe(403);
  expect((await request(app).post("/api/admin/invitations").set(auth(member.token)).send({email:"other@access.test"})).status).toBe(403);
  expect((await request(app).post("/api/admin/invitations/unknown/revoke").set(auth(member.token))).status).toBe(403);
  expect((await request(app).post(`/api/admin/users/${admin.id}/revoke-sessions`).set(auth(member.token))).status).toBe(403);
});

it("enforces invite-only registration without changing existing account access",async()=>{
  expect((await policy("invite")).status).toBe(200);
  const blocked=await request(app).post("/api/auth/signup").send({...signupBody(),role:"admin"});
  expect(blocked.status).toBe(403);
  expect((await request(app).get("/api/account/profile").set(auth(member.token))).status).toBe(200);
  expect((await db.user.count())).toBe(2);
  expect((await policy("invalid" as "open")).status).toBe(400);
});

it("issues a hashed, email-bound invitation and consumes it exactly once",async()=>{
  await policy("invite");
  const link=await invite("Invited@Access.Test");
  expect(link.inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const stored=await db.invitation.findUniqueOrThrow({where:{id:link.invitation.id}});
  expect(stored.tokenHash).toBe(invitationHash(link.inviteToken));
  expect(JSON.stringify(stored)).not.toContain(link.inviteToken);
  const inspect=await request(app).post("/api/auth/invitation").send({inviteToken:link.inviteToken});
  expect(inspect.status).toBe(200);expect(inspect.body.email).toBe("invited@access.test");
  expect(inspect.headers["cache-control"]).toContain("no-store");
  expect(Object.keys(inspect.body).sort()).toEqual(["email","expiresAt","libraries","limited"]);
  const wrong=await request(app).post("/api/auth/signup").send(signupBody("wrong@access.test",link.inviteToken));
  expect(wrong.status).toBe(400);expect((await db.invitation.findUniqueOrThrow({where:{id:stored.id}})).acceptedAt).toBeNull();
  const accepted=await request(app).post("/api/auth/signup").send({...signupBody("invited@access.test",link.inviteToken),role:"admin"});
  expect(accepted.status).toBe(201);expect(accepted.body.user.role).toBe("user");
  expect((await request(app).post("/api/auth/invitation").send({inviteToken:link.inviteToken})).status).toBe(400);
  const listing=await request(app).get("/api/admin/invitations").set(auth(admin.token));
  expect(listing.body.invitations[0].status).toBe("accepted");
  expect(JSON.stringify(listing.body)).not.toContain(link.inviteToken);
  expect(JSON.stringify(listing.body)).not.toContain(stored.tokenHash);
  expect(JSON.stringify(await db.logEvent.findMany())).not.toContain(link.inviteToken);
  expect((await request(app).post(`/api/admin/invitations/${stored.id}/revoke`).set(auth(admin.token))).status).toBe(409);
});

it("rejects expired, revoked and malformed links before hashing passwords",async()=>{
  await policy("invite");
  const link=await invite();
  await db.invitation.update({where:{id:link.invitation.id},data:{expiresAt:new Date(Date.now()-1000)}});
  const hash=vi.spyOn(passwords,"hashPassword");
  for(const token of [link.inviteToken,"malformed"]){
    expect((await request(app).post("/api/auth/signup").send(signupBody("invited@access.test",token))).status).toBe(400);
    expect((await request(app).post("/api/auth/invitation").send({inviteToken:token})).status).toBe(400);
  }
  const replacement=await invite();
  const revoked=await request(app).post(`/api/admin/invitations/${replacement.invitation.id}/revoke`).set(auth(admin.token));
  expect(revoked.status).toBe(200);expect(revoked.body.invitation.status).toBe("revoked");
  expect((await request(app).post("/api/auth/signup").send(signupBody("invited@access.test",replacement.inviteToken))).status).toBe(400);
  expect(hash).not.toHaveBeenCalled();
});

it("invalidates older pending invitations when a replacement is issued",async()=>{
  const first=await invite();const second=await invite();
  expect((await request(app).post("/api/auth/invitation").send({inviteToken:first.inviteToken})).status).toBe(400);
  expect((await request(app).post("/api/auth/invitation").send({inviteToken:second.inviteToken})).status).toBe(200);
  expect((await request(app).post("/api/admin/invitations").set(auth(admin.token)).send({email:"member@access.test"})).status).toBe(409);
  expect((await request(app).post("/api/admin/invitations").set(auth(admin.token)).send({email:"new@access.test",expiresInDays:31})).status).toBe(400);
});

it("allows only one account for concurrent acceptance of the same invitation",async()=>{
  await policy("invite");const link=await invite();
  const results=await Promise.all([1,2].map(()=>request(app).post("/api/auth/signup").send(signupBody("invited@access.test",link.inviteToken))));
  expect(results.filter(r=>r.status===201)).toHaveLength(1);
  expect([400,409]).toContain(results.find(r=>r.status!==201)!.status);
  expect(await db.user.count({where:{email:"invited@access.test"}})).toBe(1);
  expect((await db.invitation.findUniqueOrThrow({where:{id:link.invitation.id}})).acceptedAt).not.toBeNull();
});

it("closed registration refuses valid invitations and new issuance but preserves sign-in",async()=>{
  const link=await invite();await policy("closed");
  expect((await request(app).post("/api/auth/signup").send(signupBody("invited@access.test",link.inviteToken))).status).toBe(403);
  expect((await request(app).post("/api/admin/invitations").set(auth(admin.token)).send({email:"next@access.test"})).status).toBe(409);
  expect((await request(app).post("/api/auth/login").send({email:"member@access.test",password:"password123"})).status).toBe(200);
  expect((await db.invitation.findUniqueOrThrow({where:{id:link.invitation.id}})).acceptedAt).toBeNull();
});

it("fails closed for malformed registration settings",async()=>{
  await db.setting.upsert({where:{key:REGISTRATION_KEY},create:{key:REGISTRATION_KEY,value:"null"},update:{value:"null"}});
  expect((await request(app).get("/api/auth/registration")).body.mode).toBe("closed");
  expect((await request(app).post("/api/auth/signup").send(signupBody())).status).toBe(403);
});

it("rechecks registration policy after password hashing",async()=>{
  let hashing!:()=>void;let resume!:()=>void;
  const entered=new Promise<void>(resolve=>{hashing=resolve;});
  const released=new Promise<void>(resolve=>{resume=resolve;});
  vi.spyOn(passwords,"hashPassword").mockImplementationOnce(async()=>{hashing();await released;return passwordHash;});
  const pending=request(app).post("/api/auth/signup").send(signupBody()).then(r=>r);
  await entered;await policy("closed");resume();
  expect((await pending).status).toBe(403);
  expect(await db.user.count({where:{email:"invited@access.test"}})).toBe(0);
});

it("rechecks invitation revocation after password hashing",async()=>{
  await policy("invite");const link=await invite();
  let hashing!:()=>void;let resume!:()=>void;
  const entered=new Promise<void>(resolve=>{hashing=resolve;});
  const released=new Promise<void>(resolve=>{resume=resolve;});
  vi.spyOn(passwords,"hashPassword").mockImplementationOnce(async()=>{hashing();await released;return passwordHash;});
  const pending=request(app).post("/api/auth/signup").send(signupBody("invited@access.test",link.inviteToken)).then(r=>r);
  await entered;await request(app).post(`/api/admin/invitations/${link.invitation.id}/revoke`).set(auth(admin.token));resume();
  expect((await pending).status).toBe(400);
  expect(await db.user.count({where:{email:"invited@access.test"}})).toBe(0);
});

it("admin session revocation invalidates every existing token without deactivating the user",async()=>{
  const second=signSession({sub:member.id,email:"member@access.test",role:"user"});
  const result=await request(app).post(`/api/admin/users/${member.id}/revoke-sessions`).set(auth(admin.token));
  expect(result.status).toBe(200);
  for(const token of [member.token,second])expect((await request(app).get("/api/account/profile").set(auth(token))).status).toBe(401);
  const fresh=await request(app).post("/api/auth/login").send({email:"member@access.test",password:"password123"});
  expect(fresh.status).toBe(200);
  expect((await request(app).get("/api/account/profile").set(auth(fresh.body.token))).status).toBe(200);
  expect((await db.user.findUniqueOrThrow({where:{id:member.id}})).active).toBe(true);
  expect((await request(app).post(`/api/admin/users/${admin.id}/revoke-sessions`).set(auth(admin.token))).status).toBe(400);
  expect((await request(app).post("/api/admin/users/missing/revoke-sessions").set(auth(admin.token))).status).toBe(404);
});

it("bootstraps a first admin despite closed policy then closes further signups",async()=>{
  await resetDb();
  await db.setting.upsert({where:{key:REGISTRATION_KEY},create:{key:REGISTRATION_KEY,value:JSON.stringify({mode:"closed"})},update:{value:JSON.stringify({mode:"closed"})}});
  expect((await request(app).get("/api/auth/registration")).body).toEqual({mode:"closed",bootstrapAvailable:true});
  const first=await request(app).post("/api/auth/signup").send(signupBody("owner@access.test"));
  expect(first.status).toBe(201);expect(first.body.user.role).toBe("admin");
  expect((await request(app).post("/api/auth/signup").send(signupBody())).status).toBe(403);
});

it("reserves restricted-mode bootstrap for ADMIN_EMAIL when configured",async()=>{
  await resetDb();config.adminEmail="owner@access.test";
  await db.setting.upsert({where:{key:REGISTRATION_KEY},create:{key:REGISTRATION_KEY,value:JSON.stringify({mode:"invite"})},update:{value:JSON.stringify({mode:"invite"})}});
  expect((await request(app).post("/api/auth/signup").send(signupBody("unrelated@access.test"))).status).toBe(403);
  const first=await request(app).post("/api/auth/signup").send(signupBody("owner@access.test"));
  expect(first.status).toBe(201);expect(first.body.user.role).toBe("admin");
});
