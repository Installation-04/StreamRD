import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createManager } = require("../../infra/single-container/media-manager.cjs") as { createManager: (config: Record<string, unknown>) => { server: http.Server } };

const TOKEN = "t".repeat(40), HOST = "/srv/streamrd";
interface Fake { calls: string[]; created: Record<string, Record<string, unknown>>; running: Set<string>; images: Set<string>; failPull: boolean; close: () => Promise<void>; socketPath: string }
async function fakeDocker(): Promise<Fake> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-docker-")), socketPath = path.join(dir, "docker.sock");
  const fake = { calls: [] as string[], created: {} as Fake["created"], running: new Set<string>(), images: new Set<string>(), failPull: false } as Fake;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url!, "http://docker"), key = `${request.method} ${url.pathname}`; fake.calls.push(key);
      const reply = (status: number, body?: unknown, raw?: string) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(raw ?? (body === undefined ? "" : JSON.stringify(body))); };
      const name = /^\/containers\/([^/]+)/.exec(url.pathname)?.[1];
      if (request.method === "GET" && url.pathname.startsWith("/images/")) return reply(fake.images.has(decodeURIComponent(url.pathname.slice(8, -5))) ? 200 : 404, {});
      if (request.method === "POST" && url.pathname === "/images/create") { if (fake.failPull) return reply(200, undefined, '{"status":"Pulling"}\n{"error":"pull access denied"}\n'); fake.images.add(`${url.searchParams.get("fromImage")}:${url.searchParams.get("tag")}`); return reply(200, undefined, '{"status":"Pulling"}\n{"status":"Download complete"}\n'); }
      if (request.method === "POST" && url.pathname === "/containers/create") { fake.created[url.searchParams.get("name")!] = JSON.parse(Buffer.concat(chunks).toString("utf8")); return reply(201, { Id: "abc" }); }
      if (request.method === "POST" && url.pathname.endsWith("/start")) { fake.running.add(name!); return reply(204); }
      if (request.method === "POST" && url.pathname.endsWith("/stop")) { fake.running.delete(name!); return reply(fake.created[name!] ? 204 : 404, fake.created[name!] ? undefined : { message: "no such container" }); }
      if (request.method === "DELETE" && name) { const existed = Boolean(fake.created[name]); delete fake.created[name]; fake.running.delete(name); return reply(existed ? 204 : 404, existed ? undefined : { message: "no such container" }); }
      if (request.method === "GET" && url.pathname.endsWith("/json") && name) { const spec = fake.created[name]; return spec ? reply(200, { State: { Running: fake.running.has(name) }, HostConfig: { PortBindings: (spec.HostConfig as { PortBindings: unknown }).PortBindings } }) : reply(404, { message: "no such container" }); }
      reply(500, { message: `unexpected ${key}` });
    });
  });
  await new Promise<void>(done => server.listen(socketPath, done));
  fake.socketPath = socketPath; fake.close = () => new Promise<void>(done => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); done(); }));
  return fake;
}

let docker: Fake, manager: http.Server, base: string;
async function start(extra: Record<string, unknown> = {}, socketPath?: string) {
  manager = createManager({ socketPath: socketPath ?? docker.socketPath, token: TOKEN, hostDir: HOST, network: "streamrd_default", tz: "UTC", ...extra }).server;
  await new Promise<void>(done => manager.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(manager.address() as { port: number }).port}`;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (response: Response): Promise<any> => response.json();
const call = (method: string, route: string, body?: unknown, token: string | null = TOKEN) => fetch(base + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
const settled = async (name: string) => { for (let i = 0; i < 100; i++) { const state = (await body(await call("GET", "/status"))).servers[name]; if (!["pulling", "starting"].includes(state.state)) return state; await new Promise(done => setTimeout(done, 10)); } throw new Error("never settled"); };

beforeEach(async () => { docker = await fakeDocker(); await start(); });
afterEach(async () => { await new Promise<void>(done => manager.close(() => done())); await docker.close(); });

it("answers only requests that carry the shared secret", async () => {
  expect((await call("GET", "/status", undefined, null)).status).toBe(401);
  expect((await call("GET", "/status", undefined, "x".repeat(40))).status).toBe(401);
  expect((await call("GET", "/status", undefined, "")).status).toBe(401);
  const ok = await call("GET", "/status"); expect(ok.status).toBe(200); expect((await body(ok)).servers).toEqual({ jellyfin: { state: "absent" }, plex: { state: "absent" } });
});

it("launches Jellyfin from a fixed specification: its image, folders, user and network are not the caller's to choose", async () => {
  const response = await call("POST", "/servers/jellyfin/launch", { port: 8097 }); expect(response.status).toBe(202);
  expect(await settled("jellyfin")).toEqual({ state: "running", port: 8097 });
  const spec = docker.created["streamrd-jellyfin"] as { Image: string; User: string; Env: string[]; Labels: Record<string, string>; HostConfig: Record<string, unknown>; NetworkingConfig: unknown };
  expect(spec).toMatchObject({ Image: "jellyfin/jellyfin:latest", User: "1000:1000", Env: ["TZ=UTC"], Labels: { "streamrd.managed": "true", "streamrd.server": "jellyfin" } });
  expect(spec.HostConfig).toMatchObject({ PortBindings: { "8096/tcp": [{ HostPort: "8097" }] }, RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "streamrd_default" });
  expect(spec.HostConfig.Mounts).toEqual([
    { Type: "bind", Source: `${HOST}/config/jellyfin/config`, Target: "/config", ReadOnly: false }, { Type: "bind", Source: `${HOST}/config/jellyfin/cache`, Target: "/cache", ReadOnly: false },
    { Type: "bind", Source: `${HOST}/config/streamrd/library`, Target: "/library/streamrd", ReadOnly: true }, { Type: "bind", Source: `${HOST}/config/phosphor/library`, Target: "/library/phosphor", ReadOnly: true }, { Type: "bind", Source: `${HOST}/data`, Target: "/data", ReadOnly: true },
  ]);
  expect(JSON.stringify(spec)).not.toMatch(/Privileged|docker\.sock|"NetworkMode":"host"|CapAdd|PidMode/);
  expect(docker.calls).toContain("POST /images/create"); // the image was missing, so it was pulled first
});

it("passes a Plex claim token to the container once, and never repeats it", async () => {
  const response = await call("POST", "/servers/plex/launch", { port: 32401, claim: "claim-AbC_123-xyz" }); expect(response.status).toBe(202);
  expect(JSON.stringify(await body(response))).not.toContain("claim-");
  expect(await settled("plex")).toMatchObject({ state: "running", port: 32401 });
  expect((docker.created["streamrd-plex"] as { Env: string[] }).Env).toEqual(["TZ=UTC", "PLEX_UID=1000", "PLEX_GID=1000", "PLEX_CLAIM=claim-AbC_123-xyz"]);
  expect(JSON.stringify(await body(await call("GET", "/status")))).not.toContain("claim-");
  await call("POST", "/servers/plex/launch", { port: 32401 }); await settled("plex");
  expect((docker.created["streamrd-plex"] as { Env: string[] }).Env).not.toContain("PLEX_CLAIM=claim-AbC_123-xyz"); // recreated without it
});

it("refuses anything outside the two servers, a valid port and a real claim token", async () => {
  expect((await call("POST", "/servers/portainer/launch", {})).status).toBe(404);
  expect((await call("POST", "/servers/..%2Fplex/launch", {})).status).toBe(404);
  for (const port of [80, 1023, 65536, "8096", 8096.5, null]) expect((await call("POST", "/servers/jellyfin/launch", { port })).status, String(port)).toBe(400);
  for (const claim of ["token", "claim-", "claim-a b", `claim-${"x".repeat(200)}`, 5]) expect((await call("POST", "/servers/plex/launch", { claim })).status, String(claim)).toBe(400);
  expect((await call("POST", "/servers/jellyfin/launch", { claim: "claim-abc" })).status).toBe(400);
  expect((await call("POST", "/servers/plex/launch", "not json")).status).toBe(400);
  expect((await call("POST", "/servers/plex/launch", { port: 32400, junk: "x".repeat(5000) })).status).toBe(413);
  expect((await call("PUT", "/servers/plex")).status).toBe(405);
  expect(docker.calls.filter(line => line.includes("/containers/create"))).toEqual([]);
});

it("adds the Real-Debrid mount only when Zurg is on, and stops and removes only its own containers", async () => {
  await new Promise<void>(done => manager.close(() => done())); await start({ zurg: true });
  await call("POST", "/servers/plex/launch", {}); await settled("plex");
  expect(((docker.created["streamrd-plex"].HostConfig as { Mounts: unknown[] }).Mounts)).toContainEqual({ Type: "bind", Source: `${HOST}/mnt/zurg`, Target: "/mnt/zurg", ReadOnly: true, BindOptions: { Propagation: "rslave" } });
  expect((await call("POST", "/servers/plex/stop")).status).toBe(200); expect((await body(await call("GET", "/status"))).servers.plex.state).toBe("stopped");
  expect((await call("DELETE", "/servers/plex")).status).toBe(200); expect((await body(await call("GET", "/status"))).servers.plex.state).toBe("absent");
  expect((await call("DELETE", "/servers/plex")).status).toBe(200); // already gone is fine
  expect(docker.calls.filter(line => /\/containers\/(?!create)/.test(line)).every(line => line.includes("streamrd-plex") || line.includes("streamrd-jellyfin"))).toBe(true);
});

it("reports a failed download or an unreachable Docker plainly, without internals", async () => {
  docker.failPull = true;
  await call("POST", "/servers/jellyfin/launch", {});
  expect(await settled("jellyfin")).toEqual({ state: "failed", error: "The image could not be downloaded" });
  const missing = path.join(os.tmpdir(), "no-such-docker.sock");
  await new Promise<void>(done => manager.close(() => done())); await start({}, missing);
  const response = await call("GET", "/status"); expect(response.status).toBe(502); expect(await body(response)).toEqual({ error: "Docker could not be reached" });
});
