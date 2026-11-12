import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * A stand-in for the Docker engine that keeps state (containers, their names, images, what a pull brings) and, like the real one,
 * runs what it is asked to start when that is StreamRD's updater: the updater's own program is started as a process against this
 * same engine, so a test of an update exercises the code that runs in the short-lived updater container, not a description of it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const HELPER = path.resolve(__dirname, "../../infra/single-container/media-manager.cjs");
export const SELF_ID = "5f2c".repeat(16), REF = "ghcr.io/installation-04/streamrd:latest";
export interface Box { id: string; name: string; image: string; running: boolean; alive: boolean; status: string; exitCode: number; finishedAt: string; spec: any; output: string[] }
export interface EngineOptions { unchanged?: boolean; failStart?: boolean; failPull?: boolean; mounts?: Array<Record<string, unknown>>; networks?: Record<string, unknown>; name?: string; securityOpt?: string[] }
const IMAGE_DEFAULTS = { Env: ["PATH=/usr/bin", "NODE_VERSION=24"], Labels: { "org.opencontainers.image.version": "0.24.0" }, Cmd: ["node", "/opt/single-container/init.cjs"], Entrypoint: ["/usr/bin/tini", "--"], User: "node", Healthcheck: { Test: ["CMD", "node", "/opt/single-container/health.cjs"] } };

export async function dockerEngine(opts: EngineOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-engine-")), socketPath = path.join(dir, "docker.sock");
  const boxes: Box[] = [], calls: string[] = [], images: Record<string, string> = { [REF]: "sha256:old" }, restarts: string[] = [];
  // Every image id this engine has had (an image whose tag moved is still there, untagged, as in Docker); what the next pull of a
  // reference brings (for a reference that is not StreamRD's own, the same image as before unless a test says otherwise); the version
  // label an image carries; the images a container cannot start from.
  const failPullFor: string[] = [], seen = new Set<string>(["sha256:old"]), nextPull: Record<string, string[]> = {}, versions: Record<string, string> = {}, failImages = new Set<string>();
  const name = opts.name ?? "streamrd";
  const mounts = opts.mounts ?? [
    { Type: "bind", Source: "/home/owner/streamrd/config", Destination: "/config" }, { Type: "bind", Source: "/home/owner/streamrd/data", Destination: "/data" },
    { Type: "bind", Source: "/var/run/docker.sock", Destination: socketPath },
  ];
  boxes.push({ id: SELF_ID, name, image: "sha256:old", running: true, alive: true, status: "running", exitCode: 0, finishedAt: "0001-01-01T00:00:00Z", output: [], spec: {
    Image: REF, User: "0:0", Env: [...IMAGE_DEFAULTS.Env, "CONFIG_DIR=/config", "TZ=Europe/Paris"], Cmd: IMAGE_DEFAULTS.Cmd, Entrypoint: IMAGE_DEFAULTS.Entrypoint, Healthcheck: IMAGE_DEFAULTS.Healthcheck,
    Labels: { ...IMAGE_DEFAULTS.Labels, "com.docker.compose.service": "streamrd" }, Mounts: mounts,
    HostConfig: { Binds: ["/home/owner/streamrd/config:/config", "/home/owner/streamrd/data:/data", "/var/run/docker.sock:/var/run/docker.sock"], PortBindings: { "8080/tcp": [{ HostPort: "8080" }] }, RestartPolicy: { Name: "unless-stopped" }, SecurityOpt: opts.securityOpt ?? ["no-new-privileges:true"] },
    Networks: opts.networks ?? { streamrd_default: { Aliases: ["streamrd", SELF_ID.slice(0, 12)], IPAddress: "172.20.0.2" } } } });
  let serial = 0;
  // A container is found by its name, its id, or the start of its id (which is also its default hostname).
  const find = (key: string) => boxes.find(box => box.alive && (box.name === key || box.id === key || (key.length >= 12 && box.id.startsWith(key))));
  const describe = (box: Box) => {
    const spec = box.spec, derived = [...(spec.HostConfig?.Binds ?? []).map((bind: string) => { const [source, destination] = bind.split(":"); return { Type: "bind", Source: source, Destination: destination }; }), ...(spec.HostConfig?.Mounts ?? []).map((mount: any) => ({ Type: mount.Type, Source: mount.Source, Destination: mount.Target }))];
    return { Id: box.id, Name: `/${box.name}`, Image: box.image,
      Config: { Image: spec.Image, Env: spec.Env ?? [], Labels: spec.Labels ?? {}, User: spec.User ?? "", Cmd: spec.Cmd, Entrypoint: spec.Entrypoint, Healthcheck: spec.Healthcheck, Hostname: box.id.slice(0, 12) },
      HostConfig: spec.HostConfig ?? {}, Mounts: spec.Mounts ?? derived,
      NetworkSettings: { Networks: spec.Networks ?? Object.fromEntries(Object.entries(spec.NetworkingConfig?.EndpointsConfig ?? { bridge: {} }).map(([network, endpoint], index) => [network, { ...(endpoint as object), IPAddress: `172.17.0.${10 + index}` }])) },
      State: { Running: box.running, Status: box.status, ExitCode: box.exitCode, FinishedAt: box.finishedAt, ...(box.running && spec.Healthcheck?.Test?.[0] !== "NONE" ? { Health: { Status: "healthy" } } : {}) } };
  };
  /** What Docker does when the updater container starts: run its program. Here that is a process, talking to this engine. */
  const runUpdater = (box: Box) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", DOCKER_SOCKET: socketPath };
    for (const entry of box.spec.Env ?? []) { const at = String(entry).indexOf("="); env[String(entry).slice(0, at)] = String(entry).slice(at + 1); }
    const child = spawn(process.execPath, [HELPER, ...(box.spec.Cmd ?? [])], { env, stdio: ["ignore", "pipe", "pipe"] });
    let pending = "";
    child.stdout.on("data", chunk => { pending += chunk.toString(); const lines = pending.split("\n"); pending = lines.pop() ?? ""; box.output.push(...lines.filter(Boolean)); });
    child.stderr.on("data", chunk => box.output.push(...chunk.toString().split("\n").filter(Boolean)));
    child.once("exit", code => { if (pending) box.output.push(pending); box.running = false; box.status = "exited"; box.exitCode = code ?? 1; box.finishedAt = new Date().toISOString(); });
  };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url!, "http://docker"), key = `${request.method} ${url.pathname}`; calls.push(key);
      const reply = (status: number, body?: unknown, raw?: string) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(raw ?? (body === undefined ? "" : JSON.stringify(body))); };
      const body = () => { try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; } };
      if (request.method === "GET" && url.pathname.startsWith("/images/")) {
        const reference = decodeURIComponent(url.pathname.slice(8, -5)), id = images[reference] ?? (seen.has(reference) ? reference : "");
        return id ? reply(200, { Id: id, Created: "2026-11-01T10:00:00.000000000Z", Config: { ...IMAGE_DEFAULTS, Labels: versions[id] ? { "org.opencontainers.image.version": versions[id] } : IMAGE_DEFAULTS.Labels } }) : reply(404, { message: "no such image" });
      }
      if (request.method === "POST" && url.pathname === "/images/create") {
        const reference = `${url.searchParams.get("fromImage")}:${url.searchParams.get("tag")}`;
        if (opts.failPull || failPullFor.includes(reference)) return reply(200, undefined, '{"status":"Pulling"}\n{"error":"pull access denied"}\n');
        images[reference] = nextPull[reference]?.shift() ?? images[reference] ?? (reference === REF ? (opts.unchanged ? "sha256:old" : "sha256:new") : `sha256:${reference}`);
        if (reference === REF) images[reference] = opts.unchanged ? "sha256:old" : "sha256:new";
        seen.add(images[reference]);
        return reply(200, undefined, '{"status":"Pulling"}\n{"status":"Downloading","id":"layer","progressDetail":{"current":50,"total":100}}\n{"status":"Downloaded"}\n');
      }
      if (request.method === "POST" && url.pathname === "/containers/create") {
        const wanted = url.searchParams.get("name")!; if (find(wanted)) return reply(409, { message: "name in use" });
        const spec = body(), image = images[spec.Image] ?? spec.Image;
        boxes.push({ id: `${(++serial).toString(16).padStart(4, "0")}${"ab".repeat(30)}`, name: wanted, image, running: false, alive: true, status: "created", exitCode: 0, finishedAt: "0001-01-01T00:00:00Z", spec, output: [] });
        return reply(201, { Id: boxes.at(-1)!.id });
      }
      if (request.method === "POST" && /^\/networks\/[^/]+\/connect$/.test(url.pathname)) return reply(200, {});
      const named = /^\/containers\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname);
      if (!named) return reply(500, { message: `unexpected ${key}` });
      const box = find(decodeURIComponent(named[1]));
      if (!box) return reply(404, { message: "no such container" });
      if (request.method === "GET" && named[2] === "json") return reply(200, describe(box));
      if (request.method === "GET" && named[2] === "logs") {
        const frames = box.output.map(text => { const line = Buffer.from(`${text}\n`), header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(line.length, 4); return Buffer.concat([header, line]); });
        response.writeHead(200, { "Content-Type": "application/vnd.docker.multiplexed-stream" }); return response.end(Buffer.concat(frames));
      }
      if (request.method === "POST" && named[2] === "start") {
        if ((opts.failStart && box.name === name && box.id !== SELF_ID) || failImages.has(box.image)) { box.status = "exited"; box.exitCode = 1; return reply(204); }
        box.running = true; box.status = "running";
        if (box.spec.Labels?.["streamrd.role"] === "updater") runUpdater(box);
        return reply(204);
      }
      if (request.method === "POST" && named[2] === "stop") { box.running = false; box.status = "exited"; return reply(204); }
      if (request.method === "POST" && named[2] === "rename") { box.name = url.searchParams.get("name")!; return reply(204); }
      if (request.method === "POST" && named[2] === "restart") { restarts.push(box.name); return reply(204); }
      if (request.method === "POST" && named[2] === "update") { box.spec.HostConfig = { ...box.spec.HostConfig, RestartPolicy: body().RestartPolicy }; return reply(200, { Warnings: [] }); }
      if (request.method === "DELETE" && !named[2]) { box.alive = false; box.running = false; return reply(204); }
      reply(500, { message: `unexpected ${key}` });
    });
  });
  await new Promise<void>(done => server.listen(socketPath, done));
  return { boxes, calls, images, restarts, find, socketPath, name, nextPull, versions, failImages, set failPullFor(references: string[]) { failPullFor.splice(0, failPullFor.length, ...references); },
    close: () => new Promise<void>(done => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); done(); })) };
}
export type Engine = Awaited<ReturnType<typeof dockerEngine>>;
