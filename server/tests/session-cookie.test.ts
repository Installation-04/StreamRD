import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import { app, auth, resetDb, signup } from "./helpers";
import { config } from "../src/config";
import { SESSION_COOKIE } from "../src/auth/cookie";

const originalOrigins = config.corsOrigins;
beforeEach(async () => { await resetDb(); });
afterEach(() => { config.corsOrigins = originalOrigins; delete process.env.TRUST_PROXY; });

async function cookieLogin() {
  const user = await signup("cookie");
  const response = await request(app).post("/api/auth/login").set("X-Session", "cookie").send({ email: user.email, password: "password123" });
  const header = (response.headers["set-cookie"] as unknown as string[] | undefined)?.find(value => value.startsWith(`${SESSION_COOKIE}=`));
  return { user, response, header, cookie: header ? header.split(";")[0] : "" };
}
const changeSettings = (cookie: string) => request(app).put("/api/account/debrid").set("Cookie", cookie).send({ autoImportLibrary: true });

it("issues an HttpOnly cookie and no token in the body when a cookie session is requested", async () => {
  const { response, header } = await cookieLogin();
  expect(response.status).toBe(200);
  expect(response.body.token).toBeUndefined(); expect(response.body.user.email).toBeTruthy();
  expect(header).toMatch(/HttpOnly/i); expect(header).toMatch(/SameSite=Lax/i); expect(header).toMatch(/Path=\//); expect(header).not.toMatch(/Secure/i);
  expect(header).toMatch(/Max-Age=\d+|Expires=/i);
});
it("keeps returning the token, and no cookie, to clients that do not ask for a cookie session", async () => {
  const user = await signup("bearer");
  const response = await request(app).post("/api/auth/login").send({ email: user.email, password: "password123" });
  expect(response.body.token).toBeTypeOf("string");
  expect(response.headers["set-cookie"]).toBeUndefined();
});
it("marks the cookie Secure behind a trusted HTTPS proxy only", async () => {
  const user = await signup("secure");
  const send = () => request(app).post("/api/auth/login").set("X-Session", "cookie").set("X-Forwarded-Proto", "https").send({ email: user.email, password: "password123" });
  expect(String((await send()).headers["set-cookie"])).not.toMatch(/Secure/i);
  process.env.TRUST_PROXY = "true";
  expect(String((await send()).headers["set-cookie"])).toMatch(/Secure/i);
});
it("authenticates requests from the cookie and ends the session on logout", async () => {
  const { cookie } = await cookieLogin();
  expect((await request(app).get("/api/account/profile").set("Cookie", cookie)).status).toBe(200);
  const out = await request(app).post("/api/auth/logout").set("Cookie", cookie).set("Origin", "http://localhost:80").set("Host", "localhost:80");
  expect(out.status).toBe(200);
  expect(String(out.headers["set-cookie"])).toMatch(new RegExp(`${SESSION_COOKIE}=;`));
  expect((await request(app).get("/api/account/profile").set("Cookie", cookie)).status).toBe(401);
});
it("rotates the cookie when the password changes without exposing the new token", async () => {
  const { user, cookie } = await cookieLogin();
  const changed = await request(app).post("/api/account/change-password").set("Cookie", cookie).set("X-Session", "cookie").send({ currentPassword: "password123", newPassword: "another-password-456" });
  expect(changed.status).toBe(200); expect(changed.body.token).toBeUndefined();
  const fresh = String(changed.headers["set-cookie"]).split(";")[0];
  expect(fresh).not.toBe(cookie);
  expect((await request(app).get("/api/account/profile").set("Cookie", fresh)).status).toBe(200);
  expect((await request(app).get("/api/account/profile").set("Cookie", cookie)).status).toBe(401);
  expect(user.email).toBeTruthy();
});
it("blocks cookie-authenticated changes that are not from this site, but never Bearer requests or reads", async () => {
  const { user, cookie } = await cookieLogin();
  config.corsOrigins = "";
  const attempt = (headers: Record<string, string>) => { const r = changeSettings(cookie).set("Host", "app.test:8080"); for (const [k, v] of Object.entries(headers)) r.set(k, v); return r; };
  expect((await attempt({ "Sec-Fetch-Site": "cross-site", Origin: "http://evil.test" })).status).toBe(403);
  expect((await attempt({ Origin: "http://evil.test" })).status).toBe(403);
  expect((await attempt({ Origin: "http://other.app.test:9000", "Sec-Fetch-Site": "same-site" })).status).toBe(403);
  expect((await attempt({ Origin: "http://app.test:8080", "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
  expect((await attempt({})).status).toBe(200); // no browser headers: not a browser attack
  expect((await request(app).get("/api/account/profile").set("Cookie", cookie).set("Sec-Fetch-Site", "cross-site").set("Origin", "http://evil.test")).status).toBe(200);
  expect((await request(app).put("/api/account/debrid").set(auth(user.token)).set("Sec-Fetch-Site", "cross-site").set("Origin", "http://evil.test").send({ autoImportLibrary: true })).status).toBe(200);
});
it("honours listed origins, legacy same-site setups and a trusted forwarded host", async () => {
  const { cookie } = await cookieLogin();
  const from = (origin: string, site: string, host = "api.test:47821") => changeSettings(cookie).set("Host", host).set("Origin", origin).set("Sec-Fetch-Site", site);
  config.corsOrigins = "http://web.test:3000, http://other.test";
  expect((await from("http://web.test:3000", "same-site")).status).toBe(200);
  expect((await from("http://nope.test:3000", "same-site")).status).toBe(403);
  config.corsOrigins = "*";
  expect((await from("http://api.test:3000", "same-site")).status).toBe(200);
  expect((await from("http://evil.test", "cross-site")).status).toBe(403);
  config.corsOrigins = "";
  expect((await changeSettings(cookie).set("Host", "internal:8080").set("X-Forwarded-Host", "public.test").set("Origin", "http://public.test").set("Sec-Fetch-Site", "same-origin")).status).toBe(403);
  process.env.TRUST_PROXY = "true";
  expect((await changeSettings(cookie).set("Host", "internal:8080").set("X-Forwarded-Host", "public.test").set("Origin", "http://public.test").set("Sec-Fetch-Site", "same-origin")).status).toBe(200);
});
