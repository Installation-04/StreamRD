import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createManager } = require("../../infra/single-container/media-manager.cjs") as { createManager: (config: Record<string, unknown>) => { server: http.Server } };

const TOKEN = "t".repeat(40), HOST = "/srv/streamrd";
interface Fake { logLines: string[]; calls: string[]; created: Record<string, Record<string, unknown>>; running: Set<string>; images: Set<string>; failPull: boolean; close: () => Promise<void>; socketPath: string }
async function fakeDocker(): Promise<Fake> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-docker-")), socketPath = path.join(dir, "docker.sock");
  const fake = { logLines: [] as string[], calls: [] as string[], created: {} as Fake["created"], running: new Set<string>(), images: new Set<string>(), failPull: false } as Fake;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url!, "http://docker"), key = `${request.method} ${url.pathname}`; fake.calls.push(key);
      const reply = (status: number, body?: unknown, raw?: string) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(raw ?? (body === undefined ? "" : JSON.stringify(body))); };
      const name = /^\/containers\/([^/]+)/.exec(url.pathname)?.[1];
      if (request.method === "GET" && url.pathname.startsWith("/images/")) return reply(fake.images.has(decodeURIComponent(url.pathname.slice(8, -5))) ? 200 : 404, {});
      if (request.method === "GET" && url.pathname.endsWith("/logs") && name) {
        const frames = fake.logLines.map(text => { const body = Buffer.from(text + "\n"), header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(body.length, 4); return Buffer.concat([header, body]); });
        response.writeHead(200, { "Content-Type": "application/vnd.docker.multiplexed-stream" }); return response.end(Buffer.concat(frames));
      }
      if (request.method === "POST" && url.pathname === "/images/create") { if (fake.failPull) return reply(200, undefined, '{"status":"Pulling"}\n{"error":"pull access denied"}\n'); fake.images.add(`${url.searchParams.get("fromImage")}:${url.searchParams.get("tag")}`); return reply(200, undefined, '{"status":"Pulling"}\n{"status":"Download complete"}\n'); }
      if (request.method === "POST" && url.pathname === "/containers/create") { fake.created[url.searchParams.get("name")!] = JSON.parse(Buffer.concat(chunks).toString("utf8")); return reply(201, { Id: "abc" }); }
      if (request.method === "POST" && url.pathname.endsWith("/start")) { fake.running.add(name!); return reply(204); }
      if (request.method === "POST" && url.pathname.endsWith("/update") && name) { const spec = fake.created[name]; if (!spec) return reply(404, { message: "no such container" }); (spec.HostConfig as Record<string, unknown>).RestartPolicy = JSON.parse(Buffer.concat(chunks).toString("utf8")).RestartPolicy; return reply(200, { Warnings: [] }); }
      if (request.method === "POST" && url.pathname.endsWith("/restart") && name) return reply(204);
      if (request.method === "POST" && url.pathname.endsWith("/stop")) { fake.running.delete(name!); return reply(fake.created[name!] ? 204 : 404, fake.created[name!] ? undefined : { message: "no such container" }); }
      if (request.method === "DELETE" && name) { const existed = Boolean(fake.created[name]); delete fake.created[name]; fake.running.delete(name); return reply(existed ? 204 : 404, existed ? undefined : { message: "no such container" }); }
      if (request.method === "GET" && url.pathname.endsWith("/json") && name) { const spec = fake.created[name]; return spec ? reply(200, { State: { Running: fake.running.has(name) }, HostConfig: { PortBindings: (spec.HostConfig as { PortBindings: unknown }).PortBindings, RestartPolicy: (spec.HostConfig as { RestartPolicy: unknown }).RestartPolicy } }) : reply(404, { message: "no such container" }); }
      reply(500, { message: `unexpected ${key}` });
    });
  });
  await new Promise<void>(done => server.listen(socketPath, done));
  fake.socketPath = socketPath; fake.close = () => new Promise<void>(done => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); done(); }));
  return fake;
}

let docker: Fake, manager: http.Server, base: string;
async function start(extra: Record<string, unknown> = {}, socketPath?: string) {
  manager = createManager({ socketPath: socketPath ?? docker.socketPath, token: TOKEN, hostDir: HOST, network: "streamrd_default", tz: "UTC", restartDelayMs: 50, ...extra }).server;
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
  expect(await settled("jellyfin")).toEqual({ state: "running", port: 8097, autostart: true });
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

it("starts a server with the machine or not: chosen at launch, changed in place afterwards, and nothing else about the container changes", async () => {
  expect((await call("POST", "/servers/jellyfin/autostart", { enabled: false })).status).toBe(409);   // not launched yet
  await call("POST", "/servers/jellyfin/launch", { port: 8097, autostart: false });
  expect(await settled("jellyfin")).toEqual({ state: "running", port: 8097, autostart: false });
  expect((docker.created["streamrd-jellyfin"].HostConfig as { RestartPolicy: unknown }).RestartPolicy).toEqual({ Name: "no" });
  const before = JSON.stringify({ ...docker.created["streamrd-jellyfin"], HostConfig: { ...(docker.created["streamrd-jellyfin"].HostConfig as object), RestartPolicy: null } });
  const on = await call("POST", "/servers/jellyfin/autostart", { enabled: true }); expect(on.status).toBe(200); expect(await body(on)).toEqual({ ok: true, autostart: true });
  expect((await body(await call("GET", "/status"))).servers.jellyfin).toEqual({ state: "running", port: 8097, autostart: true });
  expect((docker.created["streamrd-jellyfin"].HostConfig as { RestartPolicy: unknown }).RestartPolicy).toEqual({ Name: "unless-stopped" });
  expect(JSON.stringify({ ...docker.created["streamrd-jellyfin"], HostConfig: { ...(docker.created["streamrd-jellyfin"].HostConfig as object), RestartPolicy: null } })).toBe(before);
  expect((await call("POST", "/servers/jellyfin/autostart", { enabled: "yes" })).status).toBe(400);
  expect((await call("POST", "/servers/jellyfin/launch", { port: 8097, autostart: "no" })).status).toBe(400);
  expect((await call("POST", "/servers/emby/autostart", { enabled: true })).status).toBe(404);
  expect((await call("POST", "/servers/jellyfin/autostart", { enabled: true }, null)).status).toBe(401);
  const log = (await body(await call("GET", "/servers/jellyfin/logs"))).deploy.map((entry: { message: string }) => entry.message);
  expect(log).toContain("Set to start again by itself after a restart of this machine");
});

it("restarts the StreamRD container and nothing else, answering before it does", async () => {
  expect((await call("GET", "/restart")).status).toBe(405);
  expect((await call("POST", "/restart", undefined, null)).status).toBe(401);
  const accepted = await call("POST", "/restart"); expect(accepted.status).toBe(202); expect(await body(accepted)).toEqual({ restarting: true });
  expect(docker.calls).not.toContain("POST /containers/streamrd/restart");   // the answer went out first
  expect((await call("POST", "/restart")).status).toBe(409);                 // one at a time
  await new Promise(done => setTimeout(done, 120));
  expect(docker.calls.filter(entry => /\/restart$/.test(entry))).toEqual(["POST /containers/streamrd/restart"]);
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

it("keeps a deploy log of what it did, in order, without ever writing a claim token into it", async () => {
  await call("POST", "/servers/plex/launch", { port: 32400, claim: "claim-supersecret99" }); await settled("plex");
  const log = (await body(await call("GET", "/servers/plex/logs"))).deploy as Array<{ time: string; message: string }>;
  expect(log.map(entry => entry.message)).toEqual(["Launch requested on port 32400 with a claim token", "Downloading image plexinc/pms-docker:latest", "Downloaded plexinc/pms-docker:latest", "Starting the container", "Started. It listens on port 32400"]);
  expect(log.every(entry => /^\d{4}-\d\d-\d\dT/.test(entry.time))).toBe(true); expect(JSON.stringify(log)).not.toContain("supersecret");
  await call("POST", "/servers/plex/stop"); await call("DELETE", "/servers/plex");
  expect((await body(await call("GET", "/servers/plex/logs"))).deploy.slice(-2).map((entry: { message: string }) => entry.message)).toEqual(["Stop requested", "Remove requested"]);
  expect((await body(await call("GET", "/servers/jellyfin/logs"))).deploy).toEqual([]); // each server has its own log
});

it("reports a failed launch and an image that was already there in the deploy log", async () => {
  docker.images.add("jellyfin/jellyfin:latest"); await call("POST", "/servers/jellyfin/launch", {}); await settled("jellyfin");
  expect((await body(await call("GET", "/servers/jellyfin/logs"))).deploy.map((entry: { message: string }) => entry.message)).toContain("Image jellyfin/jellyfin:latest is already on this machine");
  docker.failPull = true; docker.images.clear(); await call("POST", "/servers/plex/launch", {}); await settled("plex");
  const messages = (await body(await call("GET", "/servers/plex/logs"))).deploy.map((entry: { message: string }) => entry.message);
  expect(messages).toContain("Failed: The image could not be downloaded");
});

it("shows the container's own output, unframed, trimmed to the tail, with tokens and colours removed", async () => {
  docker.logLines = ["2026-11-10T12:00:00Z Starting Plex Media Server", "\u001b[32m2026-11-10T12:00:01Z listening\u001b[0m", "2026-11-10T12:00:02Z PLEX_CLAIM=claim-supersecret99 accepted", "2026-11-10T12:00:03Z GET /library/sections?X-Plex-Token=abcd1234efgh", "2026-11-10T12:00:04Z request api_key=jf-secret-key-5678 ok", "", ...Array.from({ length: 300 }, (_, index) => `line ${index}`)];
  await call("POST", "/servers/plex/launch", {}); await settled("plex");
  const all = (await body(await call("GET", "/servers/plex/logs?tail=200"))).container as string[];
  expect(all).toHaveLength(200); expect(all.at(-1)).toBe("line 299");
  const few = (await body(await call("GET", "/servers/plex/logs?tail=3"))).container as string[]; expect(few).toEqual(["line 297", "line 298", "line 299"]);
  docker.logLines = docker.logLines.slice(0, 6);
  const small = (await body(await call("GET", "/servers/plex/logs"))).container as string[]; const text = small.join("\n");
  expect(small[0]).toContain("Starting Plex Media Server"); expect(text).toContain("listening"); expect(text).not.toMatch(/\u001b|supersecret|abcd1234efgh|jf-secret-key/);
  expect(text).toContain("PLEX_CLAIM=****"); expect(text).toContain("X-Plex-Token=****"); expect(text).toContain("api_key=****");
  expect(small.every(line => line.trim().length > 0)).toBe(true);
});

it("serves logs only to the caller with the secret, and only for the two servers", async () => {
  expect((await call("GET", "/servers/plex/logs", undefined, null)).status).toBe(401);
  expect((await call("GET", "/servers/portainer/logs")).status).toBe(404);
  expect((await call("POST", "/servers/plex/logs")).status).toBe(405);
  expect((await call("GET", "/servers/plex/logs?tail=-5")).status).toBe(200); // a bad tail is clamped, never an error
});
