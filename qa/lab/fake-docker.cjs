// Lab only. A stand-in for the Docker API on a unix socket, so the real media manager (infra/single-container/media-manager.cjs) can run in
// the lab: pulling an image takes a few seconds and reports progress, containers can be made, started, stopped, removed, restarted and
// have their restart policy changed, and a started server "prints" a few lines. No container is ever created.
const fs = require("node:fs"), http = require("node:http");
const socketPath = process.env.LAB_DOCKER_SOCKET, pullSeconds = Number(process.env.LAB_PULL_SECONDS || 6);
const images = new Set(), containers = new Map();   // name -> { spec, running, startedAt }
const frame = text => { const body = Buffer.from(text + "\n"), header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(body.length, 4); return Buffer.concat([header, body]); };
fs.rmSync(socketPath, { force: true });
http.createServer((request, response) => {
  const chunks = []; request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    const url = new URL(request.url, "http://docker"), name = /^\/containers\/([^/]+)/.exec(url.pathname)?.[1], body = () => JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const reply = (status, json) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(json === undefined ? "" : JSON.stringify(json)); };
    if (request.method === "GET" && url.pathname.startsWith("/images/")) return reply(images.has(decodeURIComponent(url.pathname.slice(8, -5))) ? 200 : 404, { Id: "sha256:lab" });
    if (request.method === "POST" && url.pathname === "/images/create") {
      const reference = `${url.searchParams.get("fromImage")}:${url.searchParams.get("tag")}`, layers = ["a1b2c3", "d4e5f6", "0718aa"];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write(JSON.stringify({ status: `Pulling from ${url.searchParams.get("fromImage")}` }) + "\n");
      let step = 0; const total = pullSeconds * 2;
      const timer = setInterval(() => {
        step += 1; const layer = layers[step % layers.length], percent = Math.min(100, Math.round(step / total * 100));
        response.write(JSON.stringify({ status: percent < 100 ? "Downloading" : "Pull complete", id: layer, progressDetail: { current: percent * 1000000, total: 100000000 } }) + "\n");
        if (step >= total) { clearInterval(timer); images.add(reference); response.end(JSON.stringify({ status: `Status: Downloaded newer image for ${reference}` }) + "\n"); }
      }, 500);
      return;
    }
    if (request.method === "POST" && url.pathname === "/containers/create") { containers.set(url.searchParams.get("name"), { spec: body(), running: false, startedAt: 0 }); return reply(201, { Id: "lab" + containers.size }); }
    const one = name && containers.get(name);
    if (request.method === "GET" && url.pathname.endsWith("/logs") && name) {
      response.writeHead(200, { "Content-Type": "application/vnd.docker.multiplexed-stream" });
      const lines = one?.running ? [`${new Date(one.startedAt).toISOString()} [lab] ${name} is starting`, `${new Date(one.startedAt + 1000).toISOString()} [lab] libraries mapped: /library/streamrd /library/phosphor /data`, `${new Date(one.startedAt + 2000).toISOString()} [lab] listening`] : [];
      return response.end(Buffer.concat(lines.map(frame)));
    }
    if (request.method === "GET" && url.pathname.endsWith("/json") && name) return one ? reply(200, { Name: `/${name}`, State: { Running: one.running }, Config: { Image: one.spec.Image }, HostConfig: { PortBindings: one.spec.HostConfig?.PortBindings, RestartPolicy: one.spec.HostConfig?.RestartPolicy } }) : reply(404, { message: "no such container" });
    if (request.method === "POST" && name && !one && !url.pathname.endsWith("/restart")) return reply(404, { message: "no such container" });
    if (request.method === "POST" && url.pathname.endsWith("/start")) { one.running = true; one.startedAt = Date.now(); return reply(204); }
    if (request.method === "POST" && url.pathname.endsWith("/stop")) { one.running = false; return reply(204); }
    if (request.method === "POST" && url.pathname.endsWith("/update")) { one.spec.HostConfig = { ...one.spec.HostConfig, RestartPolicy: body().RestartPolicy }; return reply(200, { Warnings: [] }); }
    if (request.method === "POST" && url.pathname.endsWith("/restart")) { fs.appendFileSync(`${socketPath}.restarts`, `${new Date().toISOString()} ${name}\n`); return reply(204); }
    if (request.method === "DELETE" && name) { const existed = containers.delete(name); return reply(existed ? 204 : 404, existed ? undefined : { message: "no such container" }); }
    reply(500, { message: `lab: unplanned Docker call ${request.method} ${url.pathname}` });
  });
}).listen(socketPath, () => console.log(`lab docker on ${socketPath}`));
