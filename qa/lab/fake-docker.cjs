// Lab only. A stand-in for the Docker API on a unix socket, so the real media manager (infra/single-container/media-manager.cjs) can run in
// the lab: pulling an image takes a few seconds and reports progress, containers can be made, started, stopped, removed, restarted and
// have their restart policy changed and be renamed, and a started server "prints" a few lines. A reference's first pull brings one image,
// its second a newer one, and the later ones the same newer one again, so a server can be seen to find an update and then to be up to date.
// No container is ever created.
const fs = require("node:fs"), http = require("node:http");
const socketPath = process.env.LAB_DOCKER_SOCKET, pullSeconds = Number(process.env.LAB_PULL_SECONDS || 6);
const images = new Map(), pulls = new Map(), known = new Set(), containers = new Map();   // reference -> image id; pulls of each reference; every image id; name -> { spec, running, startedAt, image }
// StreamRD's own container, as Docker would describe it to the helper that runs inside it: its name, the folders it keeps on the machine
// (so the helper can tell a media server where they are) and the network it is on.
const lab = process.env.LAB_DIR_ON_HOST || require("node:path").dirname(socketPath);
containers.set("streamrd", { running: true, startedAt: Date.now(), spec: { Image: "ghcr.io/lab/streamrd:latest" }, own: true,
  mounts: [{ Type: "bind", Source: lab, Destination: lab }, { Type: "bind", Source: `${lab}/data`, Destination: `${lab}/data` }, { Type: "bind", Source: "/var/run/docker.sock", Destination: socketPath }], networks: { streamrd_default: { Aliases: ["streamrd"], IPAddress: "172.20.0.2" } } });
const frame = text => { const body = Buffer.from(text + "\n"), header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(body.length, 4); return Buffer.concat([header, body]); };
fs.rmSync(socketPath, { force: true });
http.createServer((request, response) => {
  const chunks = []; request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    const url = new URL(request.url, "http://docker"), name = /^\/containers\/([^/]+)/.exec(url.pathname)?.[1], body = () => JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const reply = (status, json) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(json === undefined ? "" : JSON.stringify(json)); };
    if (request.method === "GET" && url.pathname.startsWith("/images/")) {
      const key = decodeURIComponent(url.pathname.slice(8, -5)), id = images.get(key) || (known.has(key) ? key : "");
      return id ? reply(200, { Id: id, Created: "2026-11-01T10:00:00Z", Config: { Labels: { "org.opencontainers.image.version": `${id.endsWith("2") ? 2 : 1}.0.0` } } }) : reply(404, { message: "no such image" });
    }
    if (request.method === "POST" && url.pathname === "/images/create") {
      const reference = `${url.searchParams.get("fromImage")}:${url.searchParams.get("tag")}`, layers = ["a1b2c3", "d4e5f6", "0718aa"];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write(JSON.stringify({ status: `Pulling from ${url.searchParams.get("fromImage")}` }) + "\n");
      let step = 0; const total = pullSeconds * 2;
      const timer = setInterval(() => {
        step += 1; const layer = layers[step % layers.length], percent = Math.min(100, Math.round(step / total * 100));
        response.write(JSON.stringify({ status: percent < 100 ? "Downloading" : "Pull complete", id: layer, progressDetail: { current: percent * 1000000, total: 100000000 } }) + "\n");
        if (step >= total) { clearInterval(timer); const count = Math.min(2, (pulls.get(reference) || 0) + 1); pulls.set(reference, count); images.set(reference, `sha256:lab${count}`); known.add(`sha256:lab${count}`); response.end(JSON.stringify({ status: `Status: Downloaded newer image for ${reference}` }) + "\n"); }
      }, 500);
      return;
    }
    if (request.method === "POST" && url.pathname === "/containers/create") { { const spec = body(); containers.set(url.searchParams.get("name"), { spec, running: false, startedAt: 0, image: images.get(spec.Image) || "sha256:lab1" }); } return reply(201, { Id: "lab" + containers.size }); }
    const one = name && containers.get(name);
    if (request.method === "GET" && url.pathname.endsWith("/logs") && name) {
      response.writeHead(200, { "Content-Type": "application/vnd.docker.multiplexed-stream" });
      const lines = one?.running ? [`${new Date(one.startedAt).toISOString()} [lab] ${name} is starting`, `${new Date(one.startedAt + 1000).toISOString()} [lab] libraries mapped: /library/streamrd /library/phosphor /data`, `${new Date(one.startedAt + 2000).toISOString()} [lab] listening`] : [];
      return response.end(Buffer.concat(lines.map(frame)));
    }
    if (request.method === "GET" && url.pathname.endsWith("/json") && name) return one ? reply(200, { Id: one.own ? "lab0streamrd" : `lab-${name}`, Name: `/${name}`, Image: one.image || "sha256:lab0", State: { Running: one.running }, Config: { Image: one.spec.Image }, Mounts: one.mounts || [], NetworkSettings: { Networks: one.networks || { streamrd_default: { IPAddress: "172.20.0.9" } } }, HostConfig: { PortBindings: one.spec.HostConfig?.PortBindings, RestartPolicy: one.spec.HostConfig?.RestartPolicy } }) : reply(404, { message: "no such container" });
    if (request.method === "POST" && name && !one && !url.pathname.endsWith("/restart")) return reply(404, { message: "no such container" });
    if (request.method === "POST" && url.pathname.endsWith("/start")) { one.running = true; one.startedAt = Date.now(); return reply(204); }
    if (request.method === "POST" && url.pathname.endsWith("/stop")) { one.running = false; return reply(204); }
    if (request.method === "POST" && url.pathname.endsWith("/rename")) { containers.delete(name); containers.set(url.searchParams.get("name"), one); return reply(204); }
    if (request.method === "POST" && url.pathname.endsWith("/update")) { one.spec.HostConfig = { ...one.spec.HostConfig, RestartPolicy: body().RestartPolicy }; return reply(200, { Warnings: [] }); }
    if (request.method === "POST" && url.pathname.endsWith("/restart")) { fs.appendFileSync(`${socketPath}.restarts`, `${new Date().toISOString()} ${name}\n`); return reply(204); }
    if (request.method === "DELETE" && name) { const existed = containers.delete(name); return reply(existed ? 204 : 404, existed ? undefined : { message: "no such container" }); }
    reply(500, { message: `lab: unplanned Docker call ${request.method} ${url.pathname}` });
  });
}).listen(socketPath, () => console.log(`lab docker on ${socketPath}`));
