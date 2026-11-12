import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { dockerEngine, Engine } from "./docker-engine";
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const INFRA = path.resolve(__dirname, "../../infra/single-container");
const { decide } = require(path.join(INFRA, "init.cjs")) as { decide: (input: { env: Record<string, string | undefined>; uid: number; socket: { uid: number; gid: number; mode: number } | null }) => { mode: string; reason?: string; shared?: boolean } };

// The container's first program: what it decides about Docker, and (where the tests run as root) that it really keeps the helper as
// root and everything else as user 1000.
const socket = (uid: number, gid: number, mode: number) => ({ uid, gid, mode: 0o140000 | mode });

it("turns Docker control on only for a container that starts as root with Docker's socket, and says why otherwise", () => {
  expect(decide({ env: {}, uid: 0, socket: socket(0, 999, 0o660) })).toEqual({ mode: "embedded", shared: false });
  expect(decide({ env: {}, uid: 0, socket: null })).toEqual({ mode: "off", reason: "no-socket" });
  expect(decide({ env: {}, uid: 1000, socket: socket(0, 999, 0o660) })).toEqual({ mode: "off", reason: "not-root" });
  expect(decide({ env: {}, uid: 1000, socket: null })).toEqual({ mode: "off", reason: "no-socket" });
  for (const value of ["false", "0", "off", "no", " FALSE "]) expect(decide({ env: { DOCKER_CONTROL: value }, uid: 0, socket: socket(0, 0, 0o660) }), value).toEqual({ mode: "off", reason: "disabled" });
  expect(decide({ env: { DOCKER_CONTROL: "true" }, uid: 0, socket: socket(0, 0, 0o660) }).mode).toBe("embedded");
  // A helper in a container of its own, as installs before v0.24.0 have it, is left in charge.
  expect(decide({ env: { MEDIA_MANAGER_URL: "http://media-manager:8099", MEDIA_MANAGER_TOKEN: "t".repeat(48) }, uid: 0, socket: socket(0, 0, 0o660) })).toEqual({ mode: "external" });
  expect(decide({ env: { MEDIA_MANAGER_URL: "http://media-manager:8099", MEDIA_MANAGER_TOKEN: "t".repeat(48) }, uid: 1000, socket: null })).toEqual({ mode: "external" });
  expect(decide({ env: { MEDIA_MANAGER_URL: "http://media-manager:8099" }, uid: 1000, socket: null }).mode).toBe("off");
});

it("notices when the user StreamRD runs as could open Docker's socket itself", () => {
  expect(decide({ env: {}, uid: 0, socket: socket(0, 0, 0o660) }).shared).toBe(false);       // root only
  expect(decide({ env: {}, uid: 0, socket: socket(0, 999, 0o660) }).shared).toBe(false);     // root and the docker group
  expect(decide({ env: {}, uid: 0, socket: socket(0, 1000, 0o660) }).shared).toBe(true);     // the docker group has StreamRD's group number
  expect(decide({ env: {}, uid: 0, socket: socket(0, 1000, 0o600) }).shared).toBe(false);    // ... but the group may not use it
  expect(decide({ env: {}, uid: 0, socket: socket(0, 0, 0o666) }).shared).toBe(true);        // open to everyone
  expect(decide({ env: {}, uid: 0, socket: socket(1000, 0, 0o600) }).shared).toBe(true);     // owned by StreamRD's user
});

// ---- the real thing, as root
const asUser = (script: string) => spawnSync(process.execPath, ["-e", script], { uid: 1000, gid: 1000 }).status === 0;
const canRun = process.getuid?.() === 0 && asUser("process.exit(0)");
const STUB = `// Stands in for StreamRD: says who it runs as and what it can reach, then waits to be stopped.
const net = require('node:net');
(async () => {
  const env = process.env, url = env.MEDIA_MANAGER_URL || '';
  const ask = async token => { try { return (await fetch(url + '/status', { headers: token ? { Authorization: 'Bearer ' + token } : {} })).status; } catch { return 0; } };
  let withToken = 0; for (let i = 0; url && i < 200 && withToken !== 200; i++) { withToken = await ask(env.MEDIA_MANAGER_TOKEN); if (withToken !== 200) await new Promise(done => setTimeout(done, 50)); }
  const opened = await new Promise(resolve => { const socket = net.connect(env.DOCKER_SOCKET); socket.once('connect', () => { socket.destroy(); resolve('opened'); }); socket.once('error', error => resolve(error.code)); });
  let writable = true; try { require('node:fs').writeFileSync(env.CONFIG_DIR + '/probe', 'x'); } catch { writable = false; }
  console.log('REPORT ' + JSON.stringify({ uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), state: env.DOCKER_CONTROL_STATE, shared: env.DOCKER_CONTROL_SHARED || '', url, token: (env.MEDIA_MANAGER_TOKEN || '').length, home: env.HOME, withToken, withoutToken: url ? await ask('') : 0, socket: opened, writable, secret: env.STREAMRD_JWT_SECRET }));
  process.on('SIGTERM', () => process.exit(0)); setInterval(() => undefined, 1000);
})();
`;
let docker: Engine | undefined, running: ChildProcess | undefined, work = "";
afterEach(async () => { if (running && running.exitCode === null) { running.kill("SIGKILL"); await new Promise(done => running!.once("exit", done)); } running = undefined; await docker?.close(); docker = undefined; if (work) fs.rmSync(work, { recursive: true, force: true }); });
async function freePort() { return new Promise<number>(resolve => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); }); }); }
/** Lays out the container's programs with a stand-in for StreamRD, and starts the first program as the container would. */
async function boot(options: { socketMode?: number; withSocket?: boolean; uid?: number; env?: Record<string, string> } = {}) {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "init-")); fs.chmodSync(work, 0o755);
  for (const file of ["init.cjs", "media-manager.cjs"]) fs.copyFileSync(path.join(INFRA, file), path.join(work, file));
  fs.writeFileSync(path.join(work, "start.cjs"), STUB);
  fs.mkdirSync(path.join(work, "config")); fs.mkdirSync(path.join(work, "data"));
  docker = await dockerEngine(); fs.chmodSync(path.dirname(docker.socketPath), 0o755);
  if (options.socketMode !== undefined) fs.chmodSync(docker.socketPath, options.socketMode);
  const port = await freePort(), output: string[] = [];
  running = spawn(process.execPath, [path.join(work, "init.cjs")], { ...(options.uid ? { uid: options.uid, gid: options.uid } : {}), stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", DOCKER_SOCKET: options.withSocket === false ? path.join(work, "no.sock") : docker.socketPath, CONFIG_DIR: path.join(work, "config"), DATA_DIR: path.join(work, "data"), HELPER_PORT: String(port), STREAMRD_JWT_SECRET: "app-secret-not-for-the-helper", ...options.env } });
  running.stdout!.on("data", chunk => output.push(...chunk.toString().split("\n").filter(Boolean))); running.stderr!.on("data", chunk => output.push(...chunk.toString().split("\n").filter(Boolean)));
  for (let i = 0; i < 400 && !output.some(line => line.startsWith("REPORT ")); i++) await new Promise(done => setTimeout(done, 50));
  const line = output.find(entry => entry.startsWith("REPORT "));
  if (!line) throw new Error(`StreamRD's stand-in never reported:\n${output.join("\n")}`);
  return { report: JSON.parse(line.slice(7)), output, port, pid: running.pid! };
}
const processes = (parent: number) => fs.readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
  try { const status = fs.readFileSync(`/proc/${name}/status`, "utf8"); if (Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]) !== parent) return []; return [{ pid: Number(name), uid: Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]), command: fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").join(" "), environ: fs.readFileSync(`/proc/${name}/environ`, "utf8") }]; } catch { return []; } });
const stopped = (child: ChildProcess) => new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));

it.skipIf(!canRun)("as root with the socket: keeps the helper as root and runs StreamRD as user 1000, who can ask the helper but cannot open Docker", async () => {
  const { report, port, pid } = await boot();
  expect(report).toMatchObject({ uid: 1000, gid: 1000, groups: [1000], state: "embedded", shared: "", url: `http://127.0.0.1:${port}`, token: 64, home: "/home/node", secret: "app-secret-not-for-the-helper" });
  expect(report.withToken).toBe(200); expect(report.withoutToken).toBe(401);   // the helper answers StreamRD, and only with the secret
  expect(report.socket).toBe("EACCES");                                        // StreamRD's user cannot talk to Docker itself
  expect(report.writable).toBe(true); expect(fs.statSync(path.join(work, "config")).uid).toBe(1000);   // an empty root-owned folder was handed over
  const children = processes(pid), helper = children.find(child => child.command.includes("media-manager.cjs --embedded"))!, app = children.find(child => child.command.includes("start.cjs"))!;
  expect(helper.uid).toBe(0); expect(app.uid).toBe(1000); expect(children).toHaveLength(2);
  expect(helper.environ).not.toContain("app-secret-not-for-the-helper");       // the helper is given none of StreamRD's secrets
  expect(asUser(`require('node:fs').readFileSync('/proc/${helper.pid}/environ')`)).toBe(false);   // and StreamRD's user cannot read the helper's
  expect(asUser(`process.kill(${helper.pid}, 'SIGTERM')`)).toBe(false);                            // nor stop it
  const exit = stopped(running!); running!.kill("SIGTERM");
  expect(await exit).toBe(0);                                                  // a stop reaches StreamRD, and its exit code is the container's
  await new Promise(done => setTimeout(done, 300));
  // The helper was told to stop too. (Outside a container nothing may collect what is left of it, so "ended" is what is checked.)
  const left = (() => { try { return /^State:\s+(\S)/m.exec(fs.readFileSync(`/proc/${helper.pid}/status`, "utf8"))?.[1] ?? "gone"; } catch { return "gone"; } })();
  expect(["gone", "Z"]).toContain(left);
}, 30_000);

it.skipIf(!canRun)("as root without the socket, or switched off: nothing runs as root but the first program, and StreamRD is told why", async () => {
  const { report, pid } = await boot({ withSocket: false });
  expect(report).toMatchObject({ uid: 1000, state: "no-socket", url: "", token: 0 });
  expect(processes(pid).map(child => child.uid)).toEqual([1000]);
  running!.kill("SIGKILL"); await stopped(running!); await docker!.close(); docker = undefined; fs.rmSync(work, { recursive: true, force: true });
  const off = await boot({ env: { DOCKER_CONTROL: "false" } });
  expect(off.report).toMatchObject({ uid: 1000, state: "disabled", url: "" }); expect(processes(off.pid).map(child => child.uid)).toEqual([1000]);
}, 30_000);

it.skipIf(!canRun)("warns when StreamRD's user can open the socket too, and still works", async () => {
  const { report, output } = await boot({ socketMode: 0o666 });
  expect(report).toMatchObject({ uid: 1000, state: "embedded", shared: "1", socket: "opened", withToken: 200 });
  expect(output.join("\n")).toMatch(/Warning: on this machine Docker's socket can be opened by user 1000/);
}, 30_000);

it.skipIf(!canRun)("started as an ordinary user, as the image is by default: runs StreamRD itself, with no helper, and says what would turn it on", async () => {
  const { report, output, pid } = await boot({ uid: 1000 });
  expect(report).toMatchObject({ uid: 1000, state: "not-root", url: "", token: 0, socket: "EACCES" });
  expect(processes(pid)).toEqual([]);   // StreamRD is the first program itself
  expect(output.join("\n")).toMatch(/does not start as root.*user "0:0"/);
  const none = (running!.kill("SIGKILL"), await stopped(running!), await docker!.close(), docker = undefined, fs.rmSync(work, { recursive: true, force: true }), await boot({ uid: 1000, withSocket: false }));
  expect(none.report).toMatchObject({ uid: 1000, state: "no-socket" }); expect(none.output.join("\n")).not.toMatch(/root/);
}, 30_000);

it.skipIf(!canRun)("ends with StreamRD's exit code when StreamRD stops by itself, and starts the helper again if it dies", async () => {
  const { pid } = await boot();
  const helper = processes(pid).find(child => child.command.includes("--embedded"))!;
  process.kill(helper.pid, "SIGKILL");
  let again: ReturnType<typeof processes>[number] | undefined;
  for (let i = 0; i < 200 && !again; i++) { await new Promise(done => setTimeout(done, 50)); again = processes(pid).find(child => child.command.includes("--embedded") && child.pid !== helper.pid); }
  expect(again?.uid).toBe(0);   // StreamRD kept running; the helper came back
  const app = processes(pid).find(child => child.command.includes("start.cjs"))!, exit = stopped(running!);
  process.kill(app.pid, "SIGKILL");
  expect(await exit).toBe(1);
}, 30_000);
