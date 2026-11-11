import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createManager } = require("../../infra/single-container/media-manager.cjs") as { createManager: (config: Record<string, unknown>) => { server: http.Server; update: () => Promise<string>; updateState: () => { state: string; error: string; log: Array<{ message: string }> } } };

const TOKEN = "u".repeat(40), REF = "ghcr.io/installation-04/streamrd:latest";
interface Box { name: string; id: string; image: string; running: boolean; spec: Record<string, any>; alive: boolean }
/** A Docker engine that keeps state: containers, their names, images and what a pull brings. */
async function engine(opts: { failStart?: boolean; failCreate?: boolean; unchanged?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-update-")), socketPath = path.join(dir, "docker.sock");
  const boxes: Box[] = [], calls: string[] = [], images: Record<string, string> = { [REF]: "sha256:old" };
  let serial = 0; const known = new Set(["sha256:old", "sha256:new"]);
  boxes.push({ name: "streamrd", id: "old-container-id", image: "sha256:old", running: true, alive: true, spec: {
    Config: { Image: REF, Env: ["PATH=/usr/bin", "NODE_VERSION=24", "ADMIN_EMAIL=me@example.invalid", "CONFIG_DIR=/config"], Labels: { "com.docker.compose.service": "streamrd", "org.opencontainers.image.version": "0.21.0" }, Cmd: ["node", "start.cjs"], Entrypoint: ["tini", "--"], Healthcheck: { Test: ["CMD", "true"] } },
    HostConfig: { Binds: ["/srv/streamrd/config:/config", "/srv/streamrd/data:/data"], PortBindings: { "8080/tcp": [{ HostPort: "8080" }] }, RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "streamrd_default" },
    NetworkSettings: { Networks: { streamrd_default: { Aliases: ["streamrd", "abcdef012345"] }, extra_net: { Aliases: ["streamrd"] } } } } });
  const find = (name: string) => boxes.find(box => box.alive && box.name === name);
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url!, "http://docker"), key = `${request.method} ${url.pathname}`; calls.push(key);
      const reply = (status: number, body?: unknown, raw?: string) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(raw ?? (body === undefined ? "" : JSON.stringify(body))); };
      const body = () => { try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; } };
      const named = /^\/containers\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname);
      if (request.method === "GET" && url.pathname.startsWith("/images/")) { const ref = decodeURIComponent(url.pathname.slice(8, -5)); if (images[ref]) return reply(200, { Id: images[ref], Config: ref === REF || images[ref] === "sha256:old" ? { Env: ["PATH=/usr/bin", "NODE_VERSION=24"], Labels: { "org.opencontainers.image.version": "0.21.0" }, Cmd: ["node", "start.cjs"], Entrypoint: ["tini", "--"], Healthcheck: { Test: ["CMD", "true"] } } : {} }); return known.has(ref) ? reply(200, { Id: ref, Config: { Env: ["PATH=/usr/bin", "NODE_VERSION=24"], Labels: { "org.opencontainers.image.version": "0.21.0" }, Cmd: ["node", "start.cjs"], Entrypoint: ["tini", "--"], Healthcheck: { Test: ["CMD", "true"] } } }) : reply(404, {}); }
      if (request.method === "POST" && url.pathname === "/images/create") { response.writeHead(200); response.write('{"status":"Pulling"}\n'); if (!opts.unchanged) images[REF] = "sha256:new"; return response.end('{"status":"Downloaded"}\n'); }
      if (request.method === "POST" && url.pathname === "/containers/create") {
        if (opts.failCreate) return reply(500, { message: "boom" });
        const name = url.searchParams.get("name")!; if (find(name)) return reply(409, { message: "name in use" });
        const spec = body(); boxes.push({ name, id: `new-container-${++serial}`, image: images[spec.Image], running: false, alive: true, spec }); return reply(201, { Id: `new-container-${serial}` });
      }
      if (request.method === "POST" && /^\/networks\/[^/]+\/connect$/.test(url.pathname)) return reply(200, {});
      if (named) {
        const box = find(named[1]);
        if (request.method === "GET" && named[2] === "json") return box ? reply(200, { Id: box.id, Image: box.image, Config: box.spec.Config ?? { Image: box.spec.Image }, HostConfig: box.spec.HostConfig, NetworkSettings: box.spec.NetworkSettings, State: opts.failStart && box.id.startsWith("new-") ? { Running: false, Status: "exited" } : box.running ? { Running: true, Status: "running" } : { Running: false, Status: "created" } }) : reply(404, {});
        if (request.method === "POST" && named[2] === "stop") { if (!box) return reply(404, {}); box.running = false; return reply(204); }
        if (request.method === "POST" && named[2] === "rename") { if (!box) return reply(404, {}); box.name = url.searchParams.get("name")!; return reply(204); }
        if (request.method === "POST" && named[2] === "start") { if (!box) return reply(404, {}); box.running = true; return reply(204); }
        if (request.method === "DELETE" && !named[2]) { if (!box) return reply(404, {}); box.alive = false; box.running = false; return reply(204); }
      }
      reply(500, { message: `unexpected ${key}` });
    });
  });
  await new Promise<void>(done => server.listen(socketPath, done));
  return { boxes, calls, images, find, socketPath, close: () => new Promise<void>(done => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); done(); })) };
}
let docker: Awaited<ReturnType<typeof engine>>, manager: ReturnType<typeof createManager>, listener: http.Server, base = "";
async function start(opts: Parameters<typeof engine>[0] = {}) {
  docker = await engine(opts);
  manager = createManager({ socketPath: docker.socketPath, token: TOKEN, hostDir: "/srv/streamrd", network: "streamrd_default", tz: "UTC", streamrdContainer: "streamrd", settleMs: 0, healthWaitMs: 3000 });
  listener = manager.server; await new Promise<void>(done => listener.listen(0, "127.0.0.1", done)); base = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
}
afterEach(async () => { await new Promise(done => listener?.close(done)); await docker?.close(); });
const call = (method: string, route: string, token: string | null = TOKEN) => fetch(base + route, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
async function finished() { for (let i = 0; i < 60; i++) { const state = (await (await call("GET", "/update")).json() as { state: string }).state; if (state !== "running") return state; await new Promise(done => setTimeout(done, 100)); } throw new Error("update did not finish"); }
beforeEach(() => undefined);

it("replaces the StreamRD container with the new image, keeping its settings, and removes the old one once the new one is healthy", async () => {
  await start();
  expect((await call("POST", "/update", null)).status).toBe(401); expect((await call("POST", "/update", "wrong")).status).toBe(401);
  const started = await call("POST", "/update"); expect(started.status).toBe(202);
  expect(await finished()).toBe("done");
  const fresh = docker.find("streamrd")!; expect(fresh.id).toMatch(/^new-container/); expect(fresh.running).toBe(true); expect(fresh.image).toBe("sha256:new");
  expect(docker.find("streamrd-previous")).toBeUndefined();
  const spec = fresh.spec;
  expect(spec.Image).toBe(REF); expect(spec.HostConfig.Binds).toEqual(["/srv/streamrd/config:/config", "/srv/streamrd/data:/data"]); expect(spec.HostConfig.PortBindings["8080/tcp"][0].HostPort).toBe("8080"); expect(spec.HostConfig.RestartPolicy.Name).toBe("unless-stopped");
  expect(spec.Env).toEqual(["ADMIN_EMAIL=me@example.invalid", "CONFIG_DIR=/config"]);          // what the old image supplied itself is left to the new image
  expect(spec.Labels).toEqual({ "com.docker.compose.service": "streamrd" });
  expect(spec.Cmd).toBeUndefined(); expect(spec.Entrypoint).toBeUndefined(); expect(spec.Healthcheck).toBeUndefined();
  expect(spec.NetworkingConfig.EndpointsConfig).toEqual({ streamrd_default: { Aliases: ["streamrd"] } });
  expect(docker.calls).toContain("POST /networks/extra_net/connect");
  const state = (await (await call("GET", "/update")).json()) as { log: Array<{ message: string }> }; expect(state.log.map(line => line.message).join(" ")).toMatch(/Updated/);
});

it("does nothing when StreamRD already runs the newest image", async () => {
  await start({ unchanged: true });
  await call("POST", "/update"); expect(await finished()).toBe("current");
  expect(docker.find("streamrd")!.id).toBe("old-container-id"); expect(docker.find("streamrd")!.running).toBe(true); expect(docker.calls.some(entry => entry.includes("/stop"))).toBe(false);
});

it("puts the previous version back when the new one does not start properly", async () => {
  await start({ failStart: true });
  await call("POST", "/update"); expect(await finished()).toBe("failed");
  const back = docker.find("streamrd")!; expect(back.id).toBe("old-container-id"); expect(back.running).toBe(true);
  expect(docker.boxes.filter(box => box.alive)).toHaveLength(1);
  const state = (await (await call("GET", "/update")).json()) as { error: string }; expect(state.error).toMatch(/previous version was restored/);
});

it("puts the previous version back when the new container cannot be created", async () => {
  await start({ failCreate: true });
  await call("POST", "/update"); expect(await finished()).toBe("failed");
  expect(docker.find("streamrd")!.id).toBe("old-container-id"); expect(docker.find("streamrd")!.running).toBe(true);
});

it("answers a second request while an update runs without starting another, and refuses other methods", async () => {
  await start();
  const first = await call("POST", "/update"), second = await call("POST", "/update");
  expect(first.status).toBe(202); expect(second.status).toBe(202);
  await finished(); expect(docker.calls.filter(entry => entry === "POST /containers/create")).toHaveLength(1);
  expect((await call("DELETE", "/update")).status).toBe(405);
});
