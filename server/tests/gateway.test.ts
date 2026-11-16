import http from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";

// The container's front door (infra/single-container/gateway.cjs), run here against stand-in programs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createGateway } = require("../../infra/single-container/gateway.cjs") as { createGateway: (config: Record<string, unknown>) => http.Server };

const open: http.Server[] = [];
afterEach(async () => { for (const server of open.splice(0)) { server.closeAllConnections?.(); await new Promise(done => server.close(done)); } });
const listen = (server: http.Server) => new Promise<number>(done => { open.push(server); server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port)); });
const freePort = async () => { const probe = http.createServer(); const port = await listen(probe); await new Promise(done => probe.close(done)); open.pop(); return port; };
const get = (port: number, path: string) => new Promise<{ status: number; body: string; ended: boolean }>(done => {
  const request = http.get({ host: "127.0.0.1", port, path }, response => {
    let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; });
    response.on("end", () => done({ status: response.statusCode ?? 0, body, ended: true })); response.on("aborted", () => done({ status: response.statusCode ?? 0, body, ended: false })); response.on("error", () => done({ status: response.statusCode ?? 0, body, ended: false }));
  });
  request.on("error", () => done({ status: 0, body: "", ended: false }));
});
const gateway = async (api: http.Server, extra: Record<string, unknown> = {}) => {
  const apiPort = await listen(api), port = await freePort();
  const server = createGateway({ port, webPort: apiPort, apiPort, health: async () => true, host: "127.0.0.1", ...extra }); open.push(server);
  await new Promise(done => server.once("listening", done));
  return port;
};

it("does not cut a long answer that goes quiet after it has begun (a video the browser has buffered ahead)", async () => {
  const api = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "video/mp4" }); response.write("first;");
    setTimeout(() => { response.write("second;"); setTimeout(() => response.end("last"), 400); }, 400);   // quiet for far longer than the wait below
  });
  const port = await gateway(api, { waitMs: 150, streamWaitMs: 150 });
  const answer = await get(port, "/api/stream/abc");
  expect(answer).toEqual({ status: 200, body: "first;second;last", ended: true });
});

it("gives up on a program that does not start answering, with a plain error", async () => {
  const api = http.createServer(() => { /* never answers */ });
  const port = await gateway(api, { waitMs: 150, streamWaitMs: 150 });
  const answer = await get(port, "/api/health");
  expect(answer.status).toBe(503); expect(answer.body).toContain("Service is starting or unavailable");
});

it("waits longer for the first bytes of a converted video than for other answers", async () => {
  const api = http.createServer((request, response) => setTimeout(() => { response.writeHead(200); response.end(request.url); }, 400));
  const port = await gateway(api, { waitMs: 150, streamWaitMs: 2000 });
  expect((await get(port, "/api/other")).status).toBe(503);
  expect(await get(port, "/api/stream/abc")).toEqual({ status: 200, body: "/api/stream/abc", ended: true });
});

it("answers /healthz for the container and sends the rest to the web app", async () => {
  const api = http.createServer((request, response) => { response.writeHead(200); response.end(`seen ${request.url}`); });
  const port = await gateway(api);
  expect(JSON.parse((await get(port, "/healthz")).body)).toEqual({ ok: true });
  expect((await get(port, "/login")).body).toBe("seen /login");
});

it("start.cjs still defines what its front door is given to answer /healthz (health, and the check it calls)", async () => {
  const fs = await import("node:fs"), path = await import("node:path");
  const source = fs.readFileSync(path.resolve(__dirname, "../../infra/single-container/start.cjs"), "utf8");
  for (const name of ["health", "check"]) expect(source, `${name}() is missing from start.cjs`).toMatch(new RegExp(`(?:async )?function ${name}\\(`));
  expect(source).toContain("createGateway({ port, webPort, apiPort, health })");
});
