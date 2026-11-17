import http from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";

// The container's service supervisor (infra/single-container/supervisor.cjs), run here against small real programs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createSupervisor } = require("../../infra/single-container/supervisor.cjs") as { createSupervisor: (options?: Record<string, unknown>) => Supervisor };
interface Supervisor { register(d: Record<string, unknown>): void; order(names: string[]): string[]; start(n: string): Promise<void>; stop(n: string): Promise<void>; restart(n: string): Promise<void>; stopAll(): Promise<void>; status(): Record<string, { state: string; restarts: number; error?: string }>; logs(n: string, tail?: number): Array<{ text: string; stream: string; time: string }> }

const made: Supervisor[] = [];
const make = (options: Record<string, unknown> = {}) => { const supervisor = createSupervisor({ readyMs: 5000, readyEveryMs: 40, graceMs: 800, ...options }); made.push(supervisor); return supervisor; };
afterEach(async () => { for (const supervisor of made.splice(0)) await supervisor.stopAll(); });
const node = (code: string) => ({ command: process.execPath, args: ["-e", code] });
const idle = (extra = "") => node(`${extra};setInterval(()=>{},1000)`);

it("starts what a service depends on first, and stops what depends on it first", async () => {
  const supervisor = make();
  for (const [name, dependsOn] of [["db", []], ["app", ["db"]], ["ui", ["app"]]] as Array<[string, string[]]>) supervisor.register({ name, dependsOn, ...idle(`console.log('up ${name}')`) });
  expect(supervisor.order(["ui"])).toEqual(["db", "app", "ui"]);
  await supervisor.start("ui");
  expect(Object.values(supervisor.status()).map(entry => entry.state)).toEqual(["running", "running", "running"]);
  const when = (name: string, what: string) => supervisor.logs(name).find(line => line.text.includes(what))!.time;
  expect(when("db", "running") <= when("app", "starting")).toBe(true);   // the database was up before the app was begun
  await supervisor.stop("db");   // stopping the database takes its dependents down first
  for (const name of ["db", "app", "ui"]) expect(supervisor.status()[name].state).toBe("stopped");
  expect(when("ui", "stopping") <= when("app", "stopping") && when("app", "stopping") <= when("db", "stopping")).toBe(true);
});

it("refuses a missing dependency or a cycle before starting anything", async () => {
  const supervisor = make();
  supervisor.register({ name: "a", dependsOn: ["ghost"], ...idle() });
  await expect(supervisor.start("a")).rejects.toThrow(/needs ghost, which is not set up/);
  supervisor.register({ name: "x", dependsOn: ["y"], ...idle() }); supervisor.register({ name: "y", dependsOn: ["x"], ...idle() });
  await expect(supervisor.start("x")).rejects.toThrow(/wait on each other: x → y → x/);
  expect(supervisor.status().x.state).toBe("stopped");
});

it("waits for a program to answer before it counts as running, and reports one that never does", async () => {
  const server = http.createServer((_request, response) => response.end("ok")); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  try {
    const supervisor = make({ readyMs: 700 });
    supervisor.register({ name: "answers", ...idle(), ready: { url: `http://127.0.0.1:${port}/` } });
    supervisor.register({ name: "silent", ...idle(), ready: { port: 1 }, restart: "never" });
    await supervisor.start("answers"); expect(supervisor.status().answers.state).toBe("running");
    await expect(supervisor.start("silent")).rejects.toThrow(/did not become ready/);
  } finally { server.close(); }
});

it("restarts a program that stops by itself, then gives up and says why", async () => {
  const supervisor = make({ readyMs: 4000 });
  supervisor.register({ name: "flaky", ...node("console.log('boom');process.exit(3)"), maxRestarts: 2, backoffMs: 20 });
  await expect(supervisor.start("flaky")).rejects.toThrow(/stopped while starting: exited \(3\)/);
  expect(supervisor.status().flaky).toMatchObject({ state: "failed", restarts: 2 });
  expect(supervisor.logs("flaky").filter(line => line.text.includes("boom"))).toHaveLength(3);   // the first run and two restarts
});

it("does not restart a program that was stopped on purpose", async () => {
  const supervisor = make();
  supervisor.register({ name: "steady", ...idle() }); await supervisor.start("steady");
  await supervisor.stop("steady"); await new Promise(done => setTimeout(done, 200));
  expect(supervisor.status().steady).toMatchObject({ state: "stopped", restarts: 0 });
});

it("never shows a secret in the logs, and names the program that could not start", async () => {
  const supervisor = make();
  supervisor.register({ name: "keyed", ...idle("console.log('token=SUPER-SECRET-VALUE-123')"), secrets: ["SUPER-SECRET-VALUE-123"] }); await supervisor.start("keyed");
  const text = JSON.stringify(supervisor.logs("keyed")); expect(text).not.toContain("SUPER-SECRET"); expect(text).toContain("token=[hidden]");
  supervisor.register({ name: "missing", command: "/no/such/program", label: "Missing", restart: "never" });
  await expect(supervisor.start("missing")).rejects.toThrow(/Missing (could not start|stopped while starting)/);
});

it("kills a program that ignores the request to stop, and keeps only the last lines of its log", async () => {
  const supervisor = make({ graceMs: 200, logLimit: 5 });
  supervisor.register({ name: "stubborn", ...node("process.on('SIGTERM',()=>{});for(let i=0;i<20;i++)console.log('line '+i);setInterval(()=>{},1000)") });
  await supervisor.start("stubborn"); await new Promise(done => setTimeout(done, 200));
  await supervisor.stop("stubborn"); expect(supervisor.status().stubborn.state).toBe("stopped");
  expect(supervisor.logs("stubborn", 100)).toHaveLength(5);
});

it("refuses a service with a bad name or no command, and one that is running being redefined", async () => {
  const supervisor = make();
  expect(() => supervisor.register({ name: "Bad Name", command: "x" })).toThrow(/lower-case/);
  expect(() => supervisor.register({ name: "ok", command: "" })).toThrow(/no command/);
  supervisor.register({ name: "live", ...idle() }); await supervisor.start("live");
  expect(() => supervisor.register({ name: "live", ...idle() })).toThrow(/running; stop it/);
});
