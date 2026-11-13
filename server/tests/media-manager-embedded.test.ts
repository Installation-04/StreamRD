import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { dockerEngine, Engine, EngineOptions, HELPER, REF, SELF_ID } from "./docker-engine";
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
const { createManager, containerIdFrom, hostPath, SERVERS } = require(HELPER) as {
  createManager: (config: Record<string, unknown>) => { server: http.Server }; containerIdFrom: (text: string) => string; SERVERS: Record<string, Record<string, unknown>>;
  hostPath: (mounts: Array<Record<string, unknown>>, target: string) => string | null };

// The helper as it runs inside the StreamRD container: it is told nothing about the machine and finds out from Docker which container
// it is in, where that container's folders live, and which network it is on.
const TOKEN = "e".repeat(40);
let docker: Engine, listeners: http.Server[] = [], folders = "";
async function helper(extra: Record<string, unknown> = {}) {
  const manager = createManager({ embedded: true, socketPath: docker.socketPath, token: TOKEN, tz: "Europe/Paris", dirs: { config: path.join(folders, "config"), data: path.join(folders, "data") },
    appUid: process.getuid!(), appGid: process.getgid!(), selfId: SELF_ID, hostname: SELF_ID.slice(0, 12), restartDelayMs: 20, ...extra }).server;
  await new Promise<void>(done => manager.listen(0, "127.0.0.1", done)); listeners.push(manager);
  const base = `http://127.0.0.1:${(manager.address() as { port: number }).port}`;
  const call = (method: string, route: string, body?: unknown, token: string | null = TOKEN) => fetch(base + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (method: string, route: string, body?: unknown): Promise<any> => (await call(method, route, body)).json();
  const settled = async (name: string) => { for (let i = 0; i < 200; i++) { const state = (await json("GET", "/status")).servers[name]; if (!["pulling", "starting"].includes(state.state)) return state; await new Promise(done => setTimeout(done, 10)); } throw new Error("never settled"); };
  const updated = async () => { for (let i = 0; i < 300; i++) { const view = await json("GET", "/update"); if (view.state !== "running") return view; await new Promise(done => setTimeout(done, 50)); } throw new Error("the update did not finish"); };
  const checked = async (name: string) => { for (let i = 0; i < 300; i++) { const view = await json("GET", `/servers/${name}/update`); if (view.state !== "running") return view; await new Promise(done => setTimeout(done, 20)); } throw new Error("the check did not finish"); };
  return { call, json, settled, updated, checked };
}
// The container's folders as the helper sees them. Docker reports where they are on the machine; the stand-in says /home/owner/streamrd.
async function start(opts: EngineOptions = {}) {
  folders = fs.mkdtempSync(path.join(os.tmpdir(), "streamrd-folders-")); fs.mkdirSync(path.join(folders, "config")); fs.mkdirSync(path.join(folders, "data"));
  const inside = (mount: Record<string, unknown>) => ({ ...mount, Destination: String(mount.Destination).replace(/^\/(config|data)\b/, (_all, which) => path.join(folders, which)) });
  docker = await dockerEngine({ ...opts, ...(opts.mounts ? { mounts: opts.mounts.map(inside) } : {}) });
  if (!opts.mounts) { const own = docker.find(docker.name)!; own.spec.Mounts = own.spec.Mounts.map(inside); }
}
afterEach(async () => { await Promise.all(listeners.map(listener => new Promise(done => listener.close(done)))); listeners = []; await docker?.close(); if (folders) fs.rmSync(folders, { recursive: true, force: true }); });
const mountsOf = (name: string) => (docker.find(name)!.spec.HostConfig.Mounts as Array<Record<string, unknown>>);

it("reads this container's id from the files Docker and Podman mount into every container", () => {
  const id = "0123456789abcdef".repeat(4);
  expect(containerIdFrom(`1203 1183 259:2 /var/lib/docker/containers/${id}/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/root rw\n1204 1183 259:2 /var/lib/docker/containers/${id}/hostname /etc/hostname rw - ext4 /dev/root rw`)).toBe(id);
  expect(containerIdFrom(`812 800 0:45 /containers/storage/overlay-containers/${id}/userdata/hostname /etc/hostname rw,nosuid - tmpfs tmpfs rw`)).toBe(id);
  expect(containerIdFrom("22 1 8:1 / / rw - ext4 /dev/sda1 rw\n30 22 0:5 / /proc rw - proc proc rw")).toBe("");   // not in a container
  expect(containerIdFrom(undefined as unknown as string)).toBe("");
});

it("works out where a folder inside the container lives on the machine, by its closest mount", () => {
  const mounts = [{ Source: "/home/owner/streamrd/config/", Destination: "/config" }, { Source: "/var/lib/docker/volumes/media/_data", Destination: "/data/" }, { Source: "/mnt/big", Destination: "/data/downloads" }];
  expect(hostPath(mounts, "/config")).toBe("/home/owner/streamrd/config");
  expect(hostPath(mounts, "/config/jellyfin/config")).toBe("/home/owner/streamrd/config/jellyfin/config");
  expect(hostPath(mounts, "/data")).toBe("/var/lib/docker/volumes/media/_data");
  expect(hostPath(mounts, "/data/downloads/film.mkv")).toBe("/mnt/big/film.mkv");            // the closest mount wins
  expect(hostPath(mounts, "/configuration")).toBeNull(); expect(hostPath(mounts, "/opt")).toBeNull(); expect(hostPath([], "/config")).toBeNull();
  expect(hostPath([{ Source: "/", Destination: "/" }], "/srv/x")).toBe("/srv/x");
});

it("finds its own container and gives a media server that container's folders, network and time zone, from a fixed specification", async () => {
  await start(); const { json, settled, call } = await helper();
  expect(await json("GET", "/status")).toEqual({ servers: Object.fromEntries(Object.keys(SERVERS).map(name => [name, { state: "absent" }])), embedded: true });
  expect((await call("POST", "/servers/jellyfin/launch", { port: 8097 })).status).toBe(202);
  expect(await settled("jellyfin")).toEqual({ state: "running", port: 8097, autostart: true, address: "172.17.0.10" });
  const spec = docker.find("streamrd-jellyfin")!.spec;
  expect(spec).toMatchObject({ Image: "jellyfin/jellyfin:latest", User: "1000:1000", Env: ["TZ=Europe/Paris"], Labels: { "streamrd.managed": "true", "streamrd.server": "jellyfin" } });
  expect(spec.HostConfig).toMatchObject({ PortBindings: { "8096/tcp": [{ HostPort: "8097" }] }, RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "streamrd_default" });
  expect(spec.NetworkingConfig).toEqual({ EndpointsConfig: { streamrd_default: { Aliases: ["streamrd-jellyfin"] } } });
  expect(mountsOf("streamrd-jellyfin")).toEqual([   // where the folders are on the machine, not where they are in this container
    { Type: "bind", Source: "/home/owner/streamrd/config/jellyfin/config", Target: "/config", ReadOnly: false }, { Type: "bind", Source: "/home/owner/streamrd/config/jellyfin/cache", Target: "/cache", ReadOnly: false },
    { Type: "bind", Source: "/home/owner/streamrd/config/streamrd/library", Target: "/library/streamrd", ReadOnly: true }, { Type: "bind", Source: "/home/owner/streamrd/config/phosphor/library", Target: "/library/phosphor", ReadOnly: true },
    { Type: "bind", Source: "/home/owner/streamrd/data", Target: path.join(folders, "data"), ReadOnly: true },
  ]);
  expect(JSON.stringify(spec)).not.toMatch(/Privileged|docker\.sock|"NetworkMode":"host"|CapAdd|PidMode/);
  // The folders the server is given exist before Docker mounts them (Docker would make them as root).
  for (const folder of ["jellyfin/config", "jellyfin/cache", "streamrd/library", "phosphor/library", "streamrd/library/Movies", "streamrd/library/TV Shows", "phosphor/library/Movies", "phosphor/library/TV Shows"]) expect(fs.statSync(path.join(folders, "config", folder)).isDirectory(), folder).toBe(true);   // Movies and TV Shows exist before anything is exported
  expect(fs.existsSync(path.join(folders, "config", "plex"))).toBe(false);
  expect(docker.calls.filter(entry => entry.startsWith("GET /containers/") && entry.includes(SELF_ID))).toHaveLength(1);   // it asked about itself once
});

it("keeps the final result of an update when it is read by two readers at once, one of whom read the updater while it still ran", async () => {
  await start(); const { json } = await helper({ logSettleMs: 20 });
  const box = { id: "c".repeat(64), name: "streamrd-updater", image: "sha256:x", running: true, alive: true, status: "running", exitCode: 0, finishedAt: "0001-01-01T00:00:00Z", output: ['{"time":"2026-11-12T10:00:00Z","message":"Waiting for the new version to start"}'], spec: { Labels: { "streamrd.role": "updater" } } };
  docker.boxes.push(box);
  const first = json("GET", "/update");   // reads it while it runs
  setTimeout(() => { box.running = false; box.status = "exited"; box.exitCode = 1; box.finishedAt = "2026-11-12T10:00:05Z"; box.output.push('{"time":"2026-11-12T10:00:05Z","result":"failed","error":"The new version did not start properly. The previous version was restored; nothing was lost."}'); }, 2);
  const [a, b, c] = await Promise.all([first, json("GET", "/update"), json("GET", "/update")]);
  for (const view of [a, b, c]) expect(["running", "failed"]).toContain(view.state);
  const later = await json("GET", "/update");
  expect(later).toMatchObject({ state: "failed", error: expect.stringMatching(/previous version was restored/) });   // never "running" once it has ended
  expect((await json("GET", "/update")).state).toBe("failed");
  expect(docker.find("streamrd-updater")).toBeUndefined();
  // An updater that vanished before anyone read its end is reported, not waited for for ever.
  docker.boxes.push({ ...box, id: "b".repeat(64), alive: true, running: true, status: "running", output: [], finishedAt: "0001-01-01T00:00:00Z" });
  const gone = await helper({ logSettleMs: 20 }); expect((await gone.json("GET", "/update")).state).toBe("running");
  docker.find("streamrd-updater")!.alive = false;
  expect(await gone.json("GET", "/update")).toMatchObject({ state: "failed", error: expect.stringMatching(/updater is gone/) });
});

it("starts Prowlarr from a fixed specification that gives it its own settings folder and nothing of the libraries or downloads", async () => {
  await start(); const { call, settled, json } = await helper();
  expect((await call("POST", "/servers/prowlarr/launch", {})).status).toBe(202);
  expect(await settled("prowlarr")).toMatchObject({ state: "running", port: 9696, autostart: true });
  const spec = docker.find("streamrd-prowlarr")!.spec;
  expect(spec).toMatchObject({ Image: "lscr.io/linuxserver/prowlarr:latest", Env: ["TZ=Europe/Paris", "PUID=1000", "PGID=1000"], Labels: { "streamrd.managed": "true", "streamrd.server": "prowlarr" } });
  expect(spec.User).toBeUndefined();   // the image drops to PUID itself
  expect(spec.HostConfig).toMatchObject({ PortBindings: { "9696/tcp": [{ HostPort: "9696" }] }, RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "streamrd_default" });
  expect(mountsOf("streamrd-prowlarr")).toEqual([{ Type: "bind", Source: "/home/owner/streamrd/config/prowlarr/config", Target: "/config", ReadOnly: false }]);
  expect(JSON.stringify(spec)).not.toMatch(/Privileged|docker\.sock|library|"\/data"/);
  expect(fs.statSync(path.join(folders, "config", "prowlarr", "config")).isDirectory()).toBe(true);
  expect(fs.existsSync(path.join(folders, "config", "jellyfin"))).toBe(false);   // nothing is made for the others
  expect((await json("GET", "/servers/prowlarr/logs")).deploy.map((entry: { message: string }) => entry.message)).toContain("Started. It listens on port 9696");
});

// What each add-on is made of, written down: the catalog is the only place that decides it, so this is what a reviewer checks.
const ADDONS: Array<[string, { image: string; port: number; env: string[]; user?: string; init?: boolean; folders: Array<[string, string]>; data?: boolean; published?: boolean }]> = [
  ["sonarr", { image: "lscr.io/linuxserver/sonarr", port: 8989, env: ["PUID=1000", "PGID=1000"], folders: [["sonarr/config", "/config"]], data: true }],
  ["radarr", { image: "lscr.io/linuxserver/radarr", port: 7878, env: ["PUID=1000", "PGID=1000"], folders: [["radarr/config", "/config"]], data: true }],
  ["lidarr", { image: "lscr.io/linuxserver/lidarr", port: 8686, env: ["PUID=1000", "PGID=1000"], folders: [["lidarr/config", "/config"]], data: true }],
  ["bazarr", { image: "lscr.io/linuxserver/bazarr", port: 6767, env: ["PUID=1000", "PGID=1000"], folders: [["bazarr/config", "/config"]], data: true }],
  ["seerr", { image: "ghcr.io/seerr-team/seerr", port: 5055, env: [], user: "1000:1000", init: true, folders: [["seerr/config", "/app/config"]] }],
  ["tautulli", { image: "lscr.io/linuxserver/tautulli", port: 8181, env: ["PUID=1000", "PGID=1000"], folders: [["tautulli/config", "/config"]] }],
  ["flaresolverr", { image: "ghcr.io/flaresolverr/flaresolverr", port: 8191, env: ["LOG_LEVEL=info"], folders: [], published: false }],
  ["maintainerr", { image: "ghcr.io/maintainerr/maintainerr", port: 6246, env: [], user: "1000:1000", folders: [["maintainerr/data", "/opt/data"]] }],
];
it.each(ADDONS)("starts %s from a fixed specification: its own folder, StreamRD's data folder only where it writes, a port only where it has a page", async (name, want) => {
  await start(); const { call, settled, json } = await helper();
  expect((await call("POST", `/servers/${name}/launch`, { port: want.port + 1, autostart: false })).status).toBe(202);
  expect(await settled(name)).toMatchObject({ state: "running", autostart: false, ...(want.published === false ? {} : { port: want.port + 1 }) });
  const spec = docker.find(`streamrd-${name}`)!.spec;
  expect(spec).toMatchObject({ Image: `${want.image}:latest`, Env: ["TZ=Europe/Paris", ...want.env], Labels: { "streamrd.managed": "true", "streamrd.server": name } });
  expect(spec.User).toBe(want.user);
  expect(spec.HostConfig.Init).toBe(want.init);
  expect(spec.HostConfig.RestartPolicy).toEqual({ Name: "no" });
  if (want.published === false) expect(spec.HostConfig.PortBindings).toBeUndefined();   // reached by name from the other containers only
  else expect(spec.HostConfig.PortBindings).toEqual({ [`${want.port}/tcp`]: [{ HostPort: String(want.port + 1) }] });
  expect(spec.NetworkingConfig).toEqual({ EndpointsConfig: { streamrd_default: { Aliases: [`streamrd-${name}`] } } });
  expect(mountsOf(`streamrd-${name}`)).toEqual([
    ...want.folders.map(([folder, target]) => ({ Type: "bind", Source: `/home/owner/streamrd/config/${folder}`, Target: target, ReadOnly: false })),
    ...(want.data ? [{ Type: "bind", Source: "/home/owner/streamrd/data", Target: path.join(folders, "data"), ReadOnly: false }] : []),
  ]);
  expect(JSON.stringify(spec)).not.toMatch(/Privileged|docker\.sock|library|CapAdd|PidMode|"NetworkMode":"host"/);
  for (const [folder] of want.folders) expect(fs.statSync(path.join(folders, "config", folder)).isDirectory(), folder).toBe(true);
  for (const other of ["jellyfin", "plex", "streamrd", "phosphor"]) expect(fs.existsSync(path.join(folders, "config", other)), other).toBe(false);   // nothing is made for the others
  expect((await json("GET", `/servers/${name}/logs`)).deploy.map((entry: { message: string }) => entry.message)).toContain(want.published === false ? "Started. Only StreamRD and the other containers can reach it, by name" : `Started. It listens on port ${want.port + 1}`);
  expect((await call("POST", "/servers/nothing/launch", {})).status).toBe(404);
});

const PROWLARR = "lscr.io/linuxserver/prowlarr:latest";

it("looks for a newer image of a server, says what it found, and changes nothing until it is asked to update", async () => {
  await start(); const { call, json, settled, checked } = await helper();
  await call("POST", "/servers/prowlarr/launch", { port: 9697 }); expect(await settled("prowlarr")).toMatchObject({ state: "running", port: 9697 });
  docker.versions[`sha256:${PROWLARR}`] = "1.30.0";
  expect(await json("GET", "/servers/prowlarr/update")).toMatchObject({ state: "idle", current: { version: "1.30.0", created: expect.any(String) } });
  const first = docker.find("streamrd-prowlarr")!.id;

  expect((await call("POST", "/servers/prowlarr/update", {})).status).toBe(202);
  expect(await checked("prowlarr")).toMatchObject({ state: "current", available: null, current: { version: "1.30.0" }, error: "" });   // the image it runs is the newest

  docker.versions["sha256:newer"] = "1.31.0"; docker.nextPull[PROWLARR] = ["sha256:newer"];
  expect((await call("POST", "/servers/prowlarr/update", { apply: false })).status).toBe(202);
  expect(await checked("prowlarr")).toMatchObject({ state: "available", current: { version: "1.30.0" }, available: { version: "1.31.0" } });
  const same = docker.find("streamrd-prowlarr")!;
  expect(same.id).toBe(first); expect(same.running).toBe(true); expect(same.image).toBe(`sha256:${PROWLARR}`);   // a check changes nothing
  expect(docker.calls).not.toContain("POST /containers/streamrd-prowlarr/stop");
  const log = (await json("GET", "/servers/prowlarr/logs")).deploy.map((entry: { message: string }) => entry.message);
  expect(log).toEqual(expect.arrayContaining([`Checking ${PROWLARR} for a newer version`, "Already running the newest version", "A newer version is available (1.31.0)"]));
});

it("makes the container again from the newer image with the same port, folders and policy, and removes the old one once the new one runs", async () => {
  await start(); const { call, json, settled, checked } = await helper();
  await call("POST", "/servers/jellyfin/launch", { port: 8097, autostart: false }); expect(await settled("jellyfin")).toMatchObject({ state: "running", port: 8097, autostart: false });
  const before = docker.find("streamrd-jellyfin")!, oldSpec = before.spec, oldImage = before.image;
  const jellyfin = "jellyfin/jellyfin:latest"; docker.versions["sha256:newer"] = "10.11.0"; docker.nextPull[jellyfin] = ["sha256:newer"];

  expect((await call("POST", "/servers/jellyfin/update", { apply: true })).status).toBe(202);
  expect(await checked("jellyfin")).toMatchObject({ state: "updated", error: "", available: { version: "10.11.0" } });
  const now = docker.find("streamrd-jellyfin")!;
  expect(now.id).not.toBe(before.id); expect(now.image).toBe("sha256:newer"); expect(now.running).toBe(true);
  expect(oldImage).not.toBe("sha256:newer");
  expect(now.spec.HostConfig).toMatchObject({ PortBindings: { "8096/tcp": [{ HostPort: "8097" }] }, RestartPolicy: { Name: "no" }, NetworkMode: "streamrd_default" });   // port and policy as they were
  expect(now.spec.Mounts).toEqual(oldSpec.Mounts); expect(now.spec.Env).toEqual(oldSpec.Env); expect(now.spec.Image).toBe(jellyfin); expect(now.spec.User).toBe("1000:1000");
  expect(docker.find("streamrd-jellyfin-previous")).toBeUndefined(); expect(before.alive).toBe(false);   // the old container is gone, its settings folders are not touched
  expect(await settled("jellyfin")).toEqual({ state: "running", port: 8097, autostart: false, address: expect.any(String) });
  expect(await json("GET", "/servers/jellyfin/update")).toMatchObject({ state: "updated", current: { version: "10.11.0" } });
  const log = (await json("GET", "/servers/jellyfin/logs")).deploy.map((entry: { message: string }) => entry.message);
  expect(log.some((line: string) => /^Stopping jellyfin to start the new version/.test(line))).toBe(true);
  expect(log).toContain("Updated to 10.11.0. The previous image is kept on this machine until you prune it.");
  expect(fs.existsSync(path.join(folders, "config", "jellyfin", "config"))).toBe(true);
});

it("puts the previous version back, still running and set as before, when the new one does not start", async () => {
  await start(); const { call, json, settled, checked } = await helper();
  await call("POST", "/servers/prowlarr/launch", { port: 9697, autostart: false }); await settled("prowlarr");
  const before = docker.find("streamrd-prowlarr")!;
  docker.nextPull[PROWLARR] = ["sha256:broken"]; docker.failImages.add("sha256:broken");

  await call("POST", "/servers/prowlarr/update", { apply: true });
  const result = await checked("prowlarr");
  expect(result).toMatchObject({ state: "failed", error: expect.stringMatching(/new version did not start properly\. The previous version was restored/) });
  const back = docker.find("streamrd-prowlarr")!;
  expect(back.id).toBe(before.id); expect(back.running).toBe(true); expect(back.image).toBe(`sha256:${PROWLARR}`);
  expect(back.spec.HostConfig.RestartPolicy).toEqual({ Name: "no" });   // the policy the server had is set again
  expect(docker.find("streamrd-prowlarr-previous")).toBeUndefined();
  expect(await settled("prowlarr")).toMatchObject({ state: "running", port: 9697 });
  expect((await json("GET", "/servers/prowlarr/logs")).deploy.map((entry: { message: string }) => entry.message).some((line: string) => /putting the previous version back/.test(line))).toBe(true);
  // and a later update, with a working image, goes through
  docker.nextPull[PROWLARR] = ["sha256:fixed"]; await call("POST", "/servers/prowlarr/update", { apply: true });
  expect(await checked("prowlarr")).toMatchObject({ state: "updated" }); expect(docker.find("streamrd-prowlarr")!.image).toBe("sha256:fixed");
});

it("says plainly when a server cannot be checked or updated, and when the download fails, and leaves a server that is running alone", async () => {
  await start(); const { call, json, settled, checked } = await helper();
  const absent = await call("POST", "/servers/plex/update", {}); expect(absent.status).toBe(409); expect((await absent.json() as { error: string }).error).toMatch(/not been launched/);
  expect((await call("POST", "/servers/nothing/update", {})).status).toBe(404);
  expect((await call("POST", "/servers/plex/update", {}, null)).status).toBe(401);
  expect((await call("POST", "/servers/plex/update", { apply: "yes" })).status).toBe(400);
  expect((await call("PUT", "/servers/plex/update", {})).status).toBe(405);

  await call("POST", "/servers/plex/launch", {}); await settled("plex"); await call("POST", "/servers/plex/stop");
  const stopped = await call("POST", "/servers/plex/update", { apply: true }); expect(stopped.status).toBe(409); expect((await stopped.json() as { error: string }).error).toMatch(/Start it before updating/);
  expect((await call("POST", "/servers/plex/update", { apply: false })).status).toBe(202);   // a stopped server can still be checked
  expect(await checked("plex")).toMatchObject({ state: "current" });

  await call("POST", "/servers/prowlarr/launch", {}); await settled("prowlarr");
  const keep = docker.find("streamrd-prowlarr")!.id;
  docker.nextPull[PROWLARR] = ["sha256:newer"]; docker.failPullFor = [PROWLARR];
  await call("POST", "/servers/prowlarr/update", { apply: true });
  expect(await checked("prowlarr")).toMatchObject({ state: "failed", error: "The image could not be downloaded" });
  expect(docker.find("streamrd-prowlarr")!.id).toBe(keep); expect(docker.find("streamrd-prowlarr")!.running).toBe(true);   // untouched
  expect((await json("GET", "/status")).servers.prowlarr).toMatchObject({ state: "running" });
});

it("refuses a settings folder that has been made a link, instead of giving ownership of whatever it points at", async () => {
  await start(); const { call, settled } = await helper();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-")); fs.mkdirSync(path.join(folders, "config", "jellyfin"));
  fs.symlinkSync(elsewhere, path.join(folders, "config", "jellyfin", "config"));   // what a compromised StreamRD could leave behind
  try {
    await call("POST", "/servers/jellyfin/launch", {});
    expect(await settled("jellyfin")).toEqual({ state: "failed", error: expect.stringMatching(/jellyfin\/config in StreamRD's settings folder is not a plain folder/) });
    expect(fs.readdirSync(elsewhere)).toEqual([]);   // nothing was made in, or given away from, the place the link names
    expect(docker.find("streamrd-jellyfin")).toBeUndefined();
    fs.unlinkSync(path.join(folders, "config", "jellyfin", "config")); fs.writeFileSync(path.join(folders, "config", "plex"), "a file");
    await call("POST", "/servers/plex/launch", {}); expect(await settled("plex")).toMatchObject({ state: "failed", error: expect.stringMatching(/not a plain folder/) });
    fs.unlinkSync(path.join(folders, "config", "plex"));
    await call("POST", "/servers/plex/launch", {}); expect(await settled("plex")).toMatchObject({ state: "running" });   // and it works again once they are removed
  } finally { fs.rmSync(elsewhere, { recursive: true, force: true }); }
});

it("copes with named volumes, the single-volume layout, a Real-Debrid mount, and a container on Docker's default network", async () => {
  await start({ networks: { bridge: { IPAddress: "172.17.0.2" } }, mounts: [
    { Type: "volume", Name: "streamrd-data", Source: "/var/lib/docker/volumes/streamrd-data/_data", Destination: "/data" },
    { Type: "bind", Source: "/srv/streamrd/mnt/zurg", Destination: "/mnt/zurg" }, { Type: "bind", Source: "/run/user/1000/docker.sock", Destination: "/var/run/docker.sock" }] });
  const single = path.join(folders, "data");   // everything under one volume: how the image runs when CONFIG_DIR is not set
  const { call, settled } = await helper({ dirs: { config: single, data: single } });
  await call("POST", "/servers/plex/launch", {}); expect(await settled("plex")).toMatchObject({ state: "running", port: 32400 });
  const spec = docker.find("streamrd-plex")!.spec, volume = "/var/lib/docker/volumes/streamrd-data/_data";
  expect(mountsOf("streamrd-plex")).toEqual([
    { Type: "bind", Source: `${volume}/plex/config`, Target: "/config", ReadOnly: false }, { Type: "bind", Source: `${volume}/plex/transcode`, Target: "/transcode", ReadOnly: false },
    { Type: "bind", Source: `${volume}/streamrd/library`, Target: "/library/streamrd", ReadOnly: true }, { Type: "bind", Source: `${volume}/phosphor/library`, Target: "/library/phosphor", ReadOnly: true },
    { Type: "bind", Source: volume, Target: single, ReadOnly: true },
    { Type: "bind", Source: "/srv/streamrd/mnt/zurg", Target: "/mnt/zurg", ReadOnly: true, BindOptions: { Propagation: "rslave" } },
  ]);
  expect(spec.HostConfig.NetworkMode).toBeUndefined(); expect(spec.NetworkingConfig).toBeUndefined();   // no named network to share: StreamRD is told the server's address instead
  expect(fs.statSync(path.join(single, "plex", "transcode")).isDirectory()).toBe(true);
});

it("says plainly when it cannot find its container or its folders, and still answers", async () => {
  await start({ mounts: [{ Type: "bind", Source: "/home/owner/streamrd/data", Destination: "/data" }] });   // nothing kept for /config
  const lost = await helper({ selfId: "", hostname: "some-other-name" });
  expect((await lost.json("GET", "/status")).servers.plex).toEqual({ state: "absent" });
  await lost.call("POST", "/servers/plex/launch", {});
  expect(await lost.settled("plex")).toEqual({ state: "failed", error: expect.stringMatching(/could not find its own container.*STREAMRD_CONTAINER/) });
  const restart = await lost.call("POST", "/restart"); expect(restart.status).toBe(202); await new Promise(done => setTimeout(done, 80)); expect(docker.restarts).toEqual([]);
  const found = await helper();
  await found.call("POST", "/servers/plex/launch", {});
  expect(await found.settled("plex")).toEqual({ state: "failed", error: expect.stringMatching(/are not kept on this machine.*volume/) });
  expect(docker.find("streamrd-plex")).toBeUndefined();
});

it("finds itself by host name or by a name it is given, and restarts the container it is in, whatever that is called", async () => {
  await start({ name: "media-box" });
  const byHostname = await helper({ selfId: "" });
  expect((await byHostname.call("POST", "/restart")).status).toBe(202); await new Promise(done => setTimeout(done, 80));
  expect(docker.restarts).toEqual(["media-box"]);
  const byName = await helper({ selfId: "", hostname: "renamed-host", selfName: "media-box" });
  expect((await byName.call("POST", "/restart")).status).toBe(202); await new Promise(done => setTimeout(done, 80));
  expect(docker.restarts).toEqual(["media-box", "media-box"]);
  expect(docker.calls.filter(entry => /\/restart$/.test(entry)).every(entry => entry === `POST /containers/media-box/restart`)).toBe(true);
});

it("updates the container it lives in by handing the swap to a short-lived updater that gets Docker's socket and nothing else", async () => {
  await start(); const first = await helper();
  expect((await first.call("POST", "/update", undefined, null)).status).toBe(401);
  expect((await first.call("POST", "/update")).status).toBe(202);
  for (let i = 0; i < 200 && !docker.boxes.some(box => box.name === "streamrd-updater"); i++) await new Promise(done => setTimeout(done, 10));
  const updater = docker.boxes.find(box => box.name === "streamrd-updater")!.spec;
  expect(updater).toMatchObject({ Image: "sha256:old", Entrypoint: ["node", "/opt/single-container/media-manager.cjs"], Cmd: ["--swap"], User: "0:0", Labels: { "streamrd.role": "updater" }, Healthcheck: { Test: ["NONE"] } });
  expect(updater.HostConfig).toEqual({ Binds: ["/var/run/docker.sock:/var/run/docker.sock"], NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], RestartPolicy: { Name: "no" } });
  expect(updater.Env.map((entry: string) => entry.split("=")[0])).toEqual(["STREAMRD_CONTAINER", "STREAMRD_UPDATE_LOG"]); expect(JSON.stringify(updater)).not.toContain(TOKEN);
  // Docker runs the updater; StreamRD's container is replaced under the helper. A new helper, in the new container, tells how it went.
  for (let i = 0; i < 300 && docker.boxes.find(box => box.name === "streamrd-updater")!.status !== "exited"; i++) await new Promise(done => setTimeout(done, 50));
  const fresh = docker.find("streamrd")!; expect(fresh.id).not.toBe(SELF_ID); expect(fresh.running).toBe(true); expect(fresh.image).toBe("sha256:new");
  expect(docker.find("streamrd-previous")).toBeUndefined(); expect(docker.find(SELF_ID)).toBeUndefined();
  expect(fresh.spec).toMatchObject({ Image: REF, User: "0:0", Env: ["CONFIG_DIR=/config", "TZ=Europe/Paris"], Labels: { "com.docker.compose.service": "streamrd" } });   // still root at start, still its own settings
  expect(fresh.spec.HostConfig.Binds).toEqual(["/home/owner/streamrd/config:/config", "/home/owner/streamrd/data:/data", "/var/run/docker.sock:/var/run/docker.sock"]);
  expect(fresh.spec.Cmd).toBeUndefined(); expect(fresh.spec.Entrypoint).toBeUndefined(); expect(fresh.spec.Healthcheck).toBeUndefined();   // the new image's own
  const second = await helper({ selfId: fresh.id, hostname: fresh.id.slice(0, 12) });
  const view = await second.updated();
  expect(view.state).toBe("done"); expect(view.error).toBe(""); expect(view.finishedAt).toMatch(/^\d{4}-/);
  const story = view.log.map((line: { message: string }) => line.message);
  expect(story[0]).toBe(`Checking ${REF} for a newer version`);   // what the old helper did is part of the record
  expect(story).toEqual(expect.arrayContaining(["Handing over to a short-lived updater: this container is about to be replaced", "Stopping StreamRD (it is back in a minute)", "Waiting for the new version to start"]));
  expect(story.at(-1)).toMatch(/^Updated\./);
  expect(docker.find("streamrd-updater")).toBeUndefined();   // read once, then removed
  expect((await second.json("GET", "/update")).state).toBe("done");   // and remembered
}, 30_000);

it("puts the previous version back when the new one does not start, and the container that is running again says so", async () => {
  await start({ failStart: true }); const first = await helper();
  await first.call("POST", "/update");
  const view = await first.updated();
  expect(view.state).toBe("failed"); expect(view.error).toMatch(/previous version was restored/);
  const back = docker.find("streamrd")!; expect(back.id).toBe(SELF_ID); expect(back.running).toBe(true);
  expect(docker.boxes.filter(box => box.alive).map(box => box.name)).toEqual(["streamrd"]);   // no new container, no updater, no "-previous" left
  expect(view.log.map((line: { message: string }) => line.message).join(" | ")).toMatch(/did not become healthy; putting the previous version back/);
}, 30_000);

it("does not start an updater when the newest image is already running, or when the download fails", async () => {
  await start({ unchanged: true }); const current = await helper();
  await current.call("POST", "/update"); expect((await current.updated()).state).toBe("current");
  expect(docker.calls).not.toContain("POST /containers/create"); expect(docker.find("streamrd")!.id).toBe(SELF_ID);
  await docker.close(); await start({ failPull: true }); const failing = await helper();
  await failing.call("POST", "/update"); const view = await failing.updated();
  expect(view.state).toBe("failed"); expect(view.error).toBe("The image could not be downloaded"); expect(docker.calls).not.toContain("POST /containers/create");
});

it("reports an update still being finished when the new container's helper is asked early, and ignores a container that is not its updater", async () => {
  await start(); const { json } = await helper();
  expect((await json("GET", "/update")).state).toBe("idle");
  docker.boxes.push({ id: "f".repeat(64), name: "streamrd-updater", image: "sha256:x", running: false, alive: true, status: "exited", exitCode: 0, finishedAt: "2026-11-12T10:00:00Z", output: ['{"time":"t","result":"updated"}'], spec: { Labels: {} } });
  expect((await json("GET", "/update")).state).toBe("idle");   // someone else's container with that name proves nothing
  const impostor = docker.find("streamrd-updater")!; impostor.spec.Labels = { "streamrd.role": "updater" }; impostor.status = "running"; impostor.running = true;
  impostor.output = ['{"time":"2026-11-12T09:59:00Z","message":"Stopping StreamRD (it is back in a minute)"}', "not json", '{"time":"2026-11-12T09:59:30Z","message":"Waiting for the new version to start"}'];
  const during = await json("GET", "/update");
  expect(during.state).toBe("running"); expect(during.log.map((line: { message: string }) => line.message)).toEqual(["Stopping StreamRD (it is back in a minute)", "not json", "Waiting for the new version to start"]);   // what it printed besides its own account is kept: a crash is never silent
  expect(docker.find("streamrd-updater")).toBeDefined();   // not removed while it works
  impostor.running = false; impostor.status = "exited"; impostor.exitCode = 1; impostor.output.push('{"time":"2026-11-12T10:00:00Z","result":"failed","error":"The new version did not start properly. The previous version was restored; nothing was lost."}');
  const after = await json("GET", "/update");
  expect(after).toMatchObject({ state: "failed", error: "The new version did not start properly. The previous version was restored; nothing was lost.", finishedAt: "2026-11-12T10:00:00Z" });
  expect(docker.find("streamrd-updater")).toBeUndefined();
  // Docker can say a container has ended a moment before its output can all be read: the account is looked for once more.
  docker.boxes.push({ id: "d".repeat(64), name: "streamrd-updater", image: "sha256:x", running: false, alive: true, status: "exited", exitCode: 0, finishedAt: "2026-11-12T11:05:00Z", output: [], spec: { Labels: { "streamrd.role": "updater" } } });
  setTimeout(() => docker.boxes.find(box => box.id === "d".repeat(64))!.output.push('{"time":"2026-11-12T11:04:59Z","message":"Updated. The previous image is kept on this machine until you prune it."}', '{"time":"2026-11-12T11:05:00Z","result":"updated"}'), 200);
  const slow = await (await helper({ logSettleMs: 600 })).json("GET", "/update");
  expect(slow).toMatchObject({ state: "done", error: "" }); expect(slow.log.map((line: { message: string }) => line.message)).toEqual(["Updated. The previous image is kept on this machine until you prune it."]);
  expect(docker.find("streamrd-updater")).toBeUndefined();
  // An updater that ended without a result says how it ended.
  docker.boxes.push({ id: "e".repeat(64), name: "streamrd-updater", image: "sha256:x", running: false, alive: true, status: "exited", exitCode: 137, finishedAt: "2026-11-12T11:00:00Z", output: ["Error: connect EACCES /var/run/docker.sock"], spec: { Labels: { "streamrd.role": "updater" } } });
  const crashed = await (await helper({ logSettleMs: 10 })).json("GET", "/update");
  expect(crashed).toMatchObject({ state: "failed", error: "The updater stopped before it finished (exit code 137)" }); expect(crashed.log.map((line: { message: string }) => line.message)).toEqual(["Error: connect EACCES /var/run/docker.sock"]);
});
