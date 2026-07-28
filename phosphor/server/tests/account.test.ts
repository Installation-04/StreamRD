import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { app, auth, resetDb, signup } from "./helpers";

describe("saved searches", () => {
  beforeAll(async () => {
    await resetDb();
    await signup("bootstrap-admin"); // consume the first-user-is-admin slot
  });

  it("supports adding, listing, and removing saved searches, scoped to the owning account", async () => {
    const user = await signup("saved");
    const other = await signup("saved-other");

    const empty = await request(app).get("/api/account/saved-searches").set(auth(user.token));
    expect(empty.status).toBe(200);
    expect(empty.body.savedSearches).toEqual([]);

    const created = await request(app)
      .post("/api/account/saved-searches")
      .set(auth(user.token))
      .send({ name: "New releases", query: "1080p", minSeeders: 5, sort: "date" });
    expect(created.status).toBe(201);
    expect(created.body.savedSearch.name).toBe("New releases");
    expect(created.body.savedSearch.query).toBe("1080p");
    const id = created.body.savedSearch.id;

    const list = await request(app).get("/api/account/saved-searches").set(auth(user.token));
    expect(list.body.savedSearches).toHaveLength(1);

    // Another account cannot see or delete someone else's saved search.
    const otherList = await request(app).get("/api/account/saved-searches").set(auth(other.token));
    expect(otherList.body.savedSearches).toEqual([]);
    const otherDelete = await request(app)
      .delete(`/api/account/saved-searches/${id}`)
      .set(auth(other.token));
    expect(otherDelete.status).toBe(200); // no-op delete, not a leak
    const stillThere = await request(app).get("/api/account/saved-searches").set(auth(user.token));
    expect(stillThere.body.savedSearches).toHaveLength(1);

    const del = await request(app)
      .delete(`/api/account/saved-searches/${id}`)
      .set(auth(user.token));
    expect(del.status).toBe(200);
    const afterDelete = await request(app).get("/api/account/saved-searches").set(auth(user.token));
    expect(afterDelete.body.savedSearches).toEqual([]);
  });

  it("rejects invalid saved-search payloads and caps at 20 per account", async () => {
    const user = await signup("saved-cap");
    const bad = await request(app)
      .post("/api/account/saved-searches")
      .set(auth(user.token))
      .send({ name: "", query: "x" });
    expect(bad.status).toBe(400);

    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .post("/api/account/saved-searches")
        .set(auth(user.token))
        .send({ name: `Search ${i}`, query: "x" });
      expect(res.status).toBe(201);
    }
    const overflow = await request(app)
      .post("/api/account/saved-searches")
      .set(auth(user.token))
      .send({ name: "One too many", query: "x" });
    expect(overflow.status).toBe(409);
  });
});
