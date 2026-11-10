import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { adminAndUser, app, auth, resetDb, TestUser } from "./helpers";

/**
 * v0.18.0 retired the curated catalogue and members' own imports. These tests pin the promises made in the release notes:
 * the doors answer "gone" or "forbidden", and nothing stored was deleted.
 */
describe("retired catalogue and member imports (v0.18.0)", () => {
  let admin: TestUser;
  let member: TestUser;
  let titleId: string;

  beforeAll(async () => {
    await resetDb();
    ({ admin, user: member } = await adminAndUser());
    titleId = (await db.title.create({ data: { name: "Kept title", year: 2020, sources: JSON.stringify([{ kind: "link", url: "https://example.invalid/a.mkv" }]) } })).id;
    await db.favorite.create({ data: { userId: member.id, titleId } });
    await db.profile.create({ data: { userId: member.id, name: "Kids" } });
    await db.accountMedia.create({ data: { userId: member.id, provider: "realdebrid", providerRef: "member-import", credentialFingerprint: "x", name: "Member import", phase: "finished", progress: 100 } });
  });

  const retired = [
    ["get", "/api/catalog/rows"], ["get", "/api/catalog/search?q=kept"], ["get", "/api/catalog/browse"], ["get", "/api/catalog/title/x"],
    ["post", "/api/play"], ["put", "/api/play/progress"], ["get", "/api/play/continue"],
    ["get", "/api/account/favorites"], ["post", "/api/account/favorites/x"], ["get", "/api/account/profiles"], ["post", "/api/account/profiles"],
    ["get", "/api/account/continue-watching"], ["get", "/api/admin/catalog"], ["post", "/api/admin/catalog/create"],
  ] as const;

  it.each(retired)("%s %s answers 410 Gone", async (method, path) => {
    const res = await request(app)[method](path).set(auth(admin.token)).send({});
    expect(res.status).toBe(410);
    expect(res.body.retired).toBe(true);
  });

  it("deletes nothing: titles, favourites, profiles and personal imports are all still stored", async () => {
    expect(await db.title.count({ where: { id: titleId } })).toBe(1);
    expect(await db.favorite.count()).toBe(1);
    expect(await db.profile.count()).toBe(1);
    expect(await db.accountMedia.count({ where: { userId: member.id } })).toBe(1);
  });

  it("keeps the rest of the account API working", async () => {
    expect((await request(app).get("/api/account/profile").set(auth(member.token))).status).toBe(200);
    expect((await request(app).get("/api/home").set(auth(member.token))).status).toBe(200);
  });

  it("closes the personal-import API to members and leaves it to the administrator", async () => {
    for (const [method, path] of [["get", "/api/account/library"], ["get", "/api/account/library/scans"], ["post", "/api/account/library/scan"], ["post", "/api/account/library/cleanup"]] as const) {
      const res = await request(app)[method](path).set(auth(member.token)).send({});
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect((await request(app).get("/api/account/library").set(auth(admin.token))).status).toBe(200);
  });

  it("never lists a member's earlier import to anyone", async () => {
    const res = await request(app).get("/api/account/library").set(auth(admin.token));
    expect(JSON.stringify(res.body)).not.toContain("Member import");
  });

  it("does not queue scans for members even with a saved key and auto-import on", async () => {
    await db.debridConfig.upsert({ where: { userId: member.id }, create: { userId: member.id, primaryProvider: "realdebrid", realDebridToken: "member-key", autoImportLibrary: true }, update: { realDebridToken: "member-key", autoImportLibrary: true } });
    const { syncAccountLibraryConfiguration } = await import("../src/account-library");
    expect((await syncAccountLibraryConfiguration(member.id)).queued).toBe(0);
    expect(await db.accountScan.count({ where: { userId: member.id } })).toBe(0);
  });
});
