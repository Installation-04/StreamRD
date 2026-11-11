'use strict';
// The media manager: a tiny helper that starts, stops and removes exactly two containers (Jellyfin and Plex) next to StreamRD, and
// replaces the StreamRD container itself with a newer image of its own, so the Setup page can launch a media server and the System page
// can update StreamRD without the StreamRD container ever touching Docker.
//
// It is the only thing in the installation that holds the Docker socket, and it can be declined (install.sh --no-media-manager). To keep what
// it can do small it:
//   - listens only on the internal compose network (no published port) and answers only requests carrying MEDIA_MANAGER_TOKEN;
//   - accepts only a server name (jellyfin or plex), a port and an optional Plex claim token; the image, the folders it mounts, the
//     user it runs as and every other setting of the container are fixed here, not chosen by the caller;
//   - never logs or stores the claim token;
//   - updates only the one container named by STREAMRD_CONTAINER (default streamrd), only to a newer image of the reference that container
//     already uses; the caller chooses nothing. The old container is kept until the new one is healthy and put back if it is not.
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

const SERVERS = {
  jellyfin: { image: 'jellyfin/jellyfin', tag: 'latest', port: 8096, internal: 8096 },
  plex: { image: 'plexinc/pms-docker', tag: 'latest', port: 32400, internal: 32400 },
};
// What the deploy log and a server's own output may show: tokens are blanked before anything leaves the manager.
const redact = text => String(text)
  .replace(/claim-[A-Za-z0-9_-]{4,}/g, 'claim-****')
  .replace(/(X-Plex-Token|X-Emby-Token|api_key|ApiKey|PLEX_CLAIM)(["'=: ]+)[^\s&"']+/gi, '$1$2****')
  .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
const LOG_LINES = 200;
const CLAIM = /^claim-[A-Za-z0-9_-]{1,100}$/;
const containerName = name => `streamrd-${name}`;
const sha = value => crypto.createHash('sha256').update(String(value)).digest();

/** Everything about a container except the port and the claim token is decided here. */
function specFor(name, options, config) {
  const server = SERVERS[name], host = config.hostDir, mounts = [];
  const bind = (source, target, readOnly, propagation) => mounts.push({ Type: 'bind', Source: source, Target: target, ReadOnly: readOnly, ...(propagation ? { BindOptions: { Propagation: propagation } } : {}) });
  if (name === 'jellyfin') { bind(`${host}/config/jellyfin/config`, '/config', false); bind(`${host}/config/jellyfin/cache`, '/cache', false); }
  else { bind(`${host}/config/plex/config`, '/config', false); bind(`${host}/config/plex/transcode`, '/transcode', false); }
  bind(`${host}/config/streamrd/library`, '/library/streamrd', true);
  bind(`${host}/config/phosphor/library`, '/library/phosphor', true);
  bind(`${host}/data`, '/data', true);
  if (config.zurg) bind(`${host}/mnt/zurg`, '/mnt/zurg', true, 'rslave');
  const env = [`TZ=${config.tz || 'UTC'}`];
  if (name === 'plex') { env.push('PLEX_UID=1000', 'PLEX_GID=1000'); if (options.claim) env.push(`PLEX_CLAIM=${options.claim}`); }
  const port = `${server.internal}/tcp`;
  return {
    Image: `${server.image}:${server.tag}`, Env: env, ExposedPorts: { [port]: {} }, ...(name === 'jellyfin' ? { User: '1000:1000' } : {}),
    Labels: { 'streamrd.managed': 'true', 'streamrd.server': name },
    HostConfig: { Mounts: mounts, PortBindings: { [port]: [{ HostPort: String(options.port) }] }, RestartPolicy: { Name: 'unless-stopped' }, ...(config.network ? { NetworkMode: config.network } : {}) },
    ...(config.network ? { NetworkingConfig: { EndpointsConfig: { [config.network]: { Aliases: [containerName(name)] } } } } : {}),
  };
}

function createManager(config) {
  const jobs = {}; // in-flight launches: { state: 'pulling' | 'starting' | 'failed', error? }
  const deploy = { jellyfin: [], plex: [] }; // what the manager did for each server, oldest first
  const note = (name, message) => { const list = deploy[name]; list.push({ time: new Date().toISOString(), message: redact(message).slice(0, 300) }); if (list.length > LOG_LINES) list.splice(0, list.length - LOG_LINES); };
  function docker(method, route, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const request = http.request({ socketPath: config.socketPath, path: route, method, headers: { Host: 'docker', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* a stream of lines, handled by the caller */ }
          resolve({ status: response.statusCode, json, text });
        });
      });
      request.on('error', reject); if (payload) request.write(payload); request.end();
    });
  }
  async function inspect(name) {
    const response = await docker('GET', `/containers/${containerName(name)}/json`);
    if (response.status === 404) return { state: 'absent' };
    if (response.status !== 200) throw new Error(`Docker answered ${response.status}`);
    const bindings = response.json?.HostConfig?.PortBindings?.[`${SERVERS[name].internal}/tcp`];
    return { state: response.json?.State?.Running ? 'running' : 'stopped', port: Number(bindings?.[0]?.HostPort) || SERVERS[name].port };
  }
  /** Pulls an image, reading Docker's progress as it arrives so the deploy log can say how far along it is. */
  function pull(name, server) { return pullImage(server.image, server.tag, message => note(name, message)); }
  function pullImage(image, tag, say) {
    return new Promise((resolve, reject) => {
      const layers = new Map(); let last = 0, buffer = '', failed = false;
      const report = () => {
        let current = 0, total = 0; for (const layer of layers.values()) { current += layer.current; total += layer.total; }
        if (total > 0 && Date.now() - last > 3000) { last = Date.now(); say(`Downloading ${image}: ${Math.min(99, Math.floor(current / total * 100))}% of ${(total / 1048576).toFixed(0)} MB`); }
      };
      const line = text => {
        if (!text.trim()) return; let event; try { event = JSON.parse(text); } catch { return; }
        if (event.error) { failed = true; say('The image could not be downloaded'); return; }
        const detail = event.progressDetail; if (event.id && detail && detail.total) layers.set(event.id, { current: detail.current || 0, total: detail.total });
        report();
      };
      const request = http.request({ socketPath: config.socketPath, path: `/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`, method: 'POST', headers: { Host: 'docker' } }, response => {
        if (response.statusCode !== 200) { response.resume(); return reject(new Error('The image could not be downloaded')); }
        response.setEncoding('utf8');
        response.on('data', chunk => { buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(line); });
        response.on('end', () => { line(buffer); failed ? reject(new Error('The image could not be downloaded')) : resolve(); });
      });
      request.on('error', reject); request.end();
    });
  }
  async function ensureImage(name) {
    const server = SERVERS[name], reference = `${server.image}:${server.tag}`;
    if ((await docker('GET', `/images/${encodeURIComponent(reference)}/json`)).status === 200) { note(name, `Image ${reference} is already on this machine`); return; }
    note(name, `Downloading image ${reference}`); await pull(name, server); note(name, `Downloaded ${reference}`);
  }
  /** The container's own output, last lines first removed: Docker frames each line with an 8 byte header unless the container has a terminal. */
  async function containerLog(name, tail) {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ socketPath: config.socketPath, path: `/containers/${containerName(name)}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`, method: 'GET', headers: { Host: 'docker' } }, reply => {
        const chunks = []; let size = 0; reply.on('data', chunk => { size += chunk.length; if (size <= 1048576) chunks.push(chunk); }); reply.on('end', () => resolve({ status: reply.statusCode, body: Buffer.concat(chunks) }));
      });
      request.on('error', reject); request.end();
    });
    if (response.status !== 200) return [];
    const body = response.body, out = []; let offset = 0;
    const framed = body.length >= 8 && body[0] <= 2 && body[1] === 0 && body[2] === 0 && body[3] === 0;
    if (framed) { while (offset + 8 <= body.length) { const size = body.readUInt32BE(offset + 4); out.push(...body.subarray(offset + 8, offset + 8 + size).toString('utf8').split('\n')); offset += 8 + size; } }
    else out.push(...body.toString('utf8').split('\n'));
    return out.map(text => redact(text).slice(0, 400)).filter(text => text.trim()).slice(-tail);
  }
  async function launch(name, options) {
    if (jobs[name] && jobs[name].state !== 'failed') return jobs[name];
    jobs[name] = { state: 'pulling' }; note(name, `Launch requested on port ${options.port}${options.claim ? ' with a claim token' : ''}`);
    (async () => {
      try {
        await ensureImage(name); jobs[name] = { state: 'starting' }; note(name, 'Starting the container');
        await docker('DELETE', `/containers/${containerName(name)}?force=true`); // recreated each launch; the folders under config/ keep its settings
        const created = await docker('POST', `/containers/create?name=${containerName(name)}`, specFor(name, options, config));
        if (created.status !== 201) throw new Error(`The container could not be created (${created.status}${created.json?.message ? `: ${String(created.json.message).slice(0, 160)}` : ''})`);
        const started = await docker('POST', `/containers/${containerName(name)}/start`);
        if (![204, 304].includes(started.status)) throw new Error(`The container could not be started (${started.status}${started.json?.message ? `: ${String(started.json.message).slice(0, 160)}` : ''})`);
        delete jobs[name]; note(name, `Started. It listens on port ${options.port}`);
      } catch (error) { const message = error instanceof Error ? error.message : 'Launch failed'; jobs[name] = { state: 'failed', error: message }; note(name, `Failed: ${message}`); }
    })();
    return jobs[name];
  }
  async function status() {
    const out = {};
    for (const name of Object.keys(SERVERS)) out[name] = jobs[name] ? { ...jobs[name] } : await inspect(name);
    return out;
  }
  async function stop(name) { delete jobs[name]; note(name, 'Stop requested'); const response = await docker('POST', `/containers/${containerName(name)}/stop`); if (![204, 304, 404].includes(response.status)) throw new Error(`Docker answered ${response.status}`); }
  async function remove(name) { delete jobs[name]; note(name, 'Remove requested'); const response = await docker('DELETE', `/containers/${containerName(name)}?force=true`); if (![204, 404].includes(response.status)) throw new Error(`Docker answered ${response.status}`); }

  // ---- Updating StreamRD itself.
  const STREAMRD = config.streamrdContainer || 'streamrd', HEALTH_WAIT_MS = config.healthWaitMs || 300000, SETTLE_MS = config.settleMs === undefined ? 8000 : config.settleMs;
  const upd = { state: 'idle', log: [], error: '', startedAt: null, finishedAt: null };
  const unote = message => { upd.log.push({ time: new Date().toISOString(), message: redact(message).slice(0, 300) }); if (upd.log.length > LOG_LINES) upd.log.splice(0, upd.log.length - LOG_LINES); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  function splitReference(reference) { const slash = reference.lastIndexOf('/'), colon = reference.lastIndexOf(':'); return colon > slash ? [reference.slice(0, colon), reference.slice(colon + 1)] : [reference, 'latest']; }
  /** The settings of the running container, minus whatever the old image supplied itself, so the new image's own defaults apply. */
  function recreateBody(inspected, oldImage, reference) {
    const c = inspected.Config || {}, base = oldImage || {};
    const labels = Object.fromEntries(Object.entries(c.Labels || {}).filter(([key, value]) => (base.Labels || {})[key] !== value));
    const body = { Image: reference, Env: (c.Env || []).filter(entry => !(base.Env || []).includes(entry)), Labels: labels, HostConfig: inspected.HostConfig };
    if (c.User && c.User !== base.User) body.User = c.User;
    if (!same(c.Cmd, base.Cmd)) body.Cmd = c.Cmd; if (!same(c.Entrypoint, base.Entrypoint)) body.Entrypoint = c.Entrypoint;
    if (!same(c.Healthcheck, base.Healthcheck) && c.Healthcheck) body.Healthcheck = c.Healthcheck;
    if (c.WorkingDir && c.WorkingDir !== base.WorkingDir) body.WorkingDir = c.WorkingDir;
    return body;
  }
  const networksOf = inspected => Object.entries(inspected.NetworkSettings?.Networks || {}).map(([name, value]) => [name, { Aliases: (value.Aliases || []).filter(alias => !/^[0-9a-f]{12}$/.test(alias)) }]);
  async function mustOk(label, response, ok) { if (!ok.includes(response.status)) throw new Error(`${label} failed (Docker answered ${response.status})`); return response; }
  async function waitHealthy(name) {
    const deadline = Date.now() + HEALTH_WAIT_MS; let steadySince = 0;
    while (Date.now() < deadline) {
      const response = await docker('GET', `/containers/${name}/json`), state = response.json?.State;
      if (response.status === 200 && state?.Running) {
        if (state.Health) { if (state.Health.Status === 'healthy') return true; if (state.Health.Status === 'unhealthy') return false; }
        else { steadySince = steadySince || Date.now(); if (Date.now() - steadySince >= SETTLE_MS) return true; }
      } else if (response.status === 200 && !state?.Running && state?.Status === 'exited') return false;
      await sleep(1000);
    }
    return false;
  }
  async function doUpdate() {
    const current = await docker('GET', `/containers/${STREAMRD}/json`);
    if (current.status !== 200) throw new Error('The StreamRD container was not found');
    const inspected = current.json, reference = inspected.Config?.Image || '';
    if (!reference || reference.startsWith('sha256:')) throw new Error('StreamRD was not started from a named image, so it cannot be updated from here');
    const [image, tag] = splitReference(reference);
    unote(`Checking ${reference} for a newer version`);
    await pullImage(image, tag, unote);
    const fresh = await docker('GET', `/images/${encodeURIComponent(reference)}/json`);
    if (fresh.status !== 200) throw new Error('The new image is not available after the download');
    if (fresh.json?.Id === inspected.Image) { unote('Already running the newest image'); return 'current'; }
    const oldImage = (await docker('GET', `/images/${inspected.Image}/json`)).json?.Config;
    const body = recreateBody(inspected, oldImage, reference), networks = networksOf(inspected), previous = `${STREAMRD}-previous`;
    unote('Stopping StreamRD (it is back in a minute)');
    await docker('DELETE', `/containers/${previous}?force=true`);
    await mustOk('Stopping StreamRD', await docker('POST', `/containers/${STREAMRD}/stop?t=30`), [204, 304]);
    await mustOk('Keeping the old container', await docker('POST', `/containers/${STREAMRD}/rename?name=${previous}`), [204]);
    const restore = async why => {
      unote(`${why}; putting the previous version back`);
      await docker('DELETE', `/containers/${STREAMRD}?force=true`);
      await docker('POST', `/containers/${previous}/rename?name=${STREAMRD}`);
      await docker('POST', `/containers/${STREAMRD}/start`);
    };
    try {
      const [first] = networks;
      const created = await docker('POST', `/containers/create?name=${STREAMRD}`, { ...body, ...(first ? { NetworkingConfig: { EndpointsConfig: { [first[0]]: first[1] } } } : {}) });
      if (created.status !== 201 || !created.json?.Id) throw new Error(`Creating the new container failed (Docker answered ${created.status})`);
      for (const [network, endpoint] of networks.slice(1)) await docker('POST', `/networks/${encodeURIComponent(network)}/connect`, { Container: created.json.Id, EndpointConfig: endpoint });
      await mustOk('Starting the new version', await docker('POST', `/containers/${STREAMRD}/start`), [204, 304]);
    } catch (error) { await restore(error.message); throw new Error(`${error.message}. The previous version was restored.`); }
    unote('Waiting for the new version to start');
    if (!await waitHealthy(STREAMRD)) { await restore('The new version did not become healthy'); throw new Error('The new version did not start properly. The previous version was restored; nothing was lost.'); }
    await docker('DELETE', `/containers/${previous}?force=true`);
    unote('Updated. The previous image is kept on this machine until you prune it.');
    return 'updated';
  }
  function startUpdate() {
    if (upd.state === 'running') return { state: 'running' };
    Object.assign(upd, { state: 'running', log: [], error: '', startedAt: new Date().toISOString(), finishedAt: null });
    doUpdate().then(result => { upd.state = result === 'current' ? 'current' : 'done'; }, error => { upd.state = 'failed'; upd.error = redact(error.message || 'The update failed'); unote(upd.error); }).finally(() => { upd.finishedAt = new Date().toISOString(); });
    return { state: 'running' };
  }

  function authorized(request) {
    const header = String(request.headers.authorization ?? ''), token = header.startsWith('Bearer ') ? header.slice(7) : '';
    return token.length > 0 && crypto.timingSafeEqual(sha(token), sha(config.token));
  }
  async function readBody(request) {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 4096) throw Object.assign(new Error('Request too large'), { status: 413 }); chunks.push(chunk); }
    const text = Buffer.concat(chunks).toString('utf8'); if (!text) return {};
    try { const value = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* below */ }
    throw Object.assign(new Error('Send a JSON object'), { status: 400 });
  }
  const server = http.createServer(async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
    try {
      if (!authorized(request)) return send(401, { error: 'Not authorized' });
      const url = new URL(request.url ?? '/', 'http://manager');
      if (url.pathname === '/update') {
        if (request.method === 'POST') return send(202, startUpdate());
        if (request.method === 'GET') return send(200, { state: upd.state, error: upd.error, startedAt: upd.startedAt, finishedAt: upd.finishedAt, log: upd.log.slice(-50) });
        return send(405, { error: 'Method not allowed' });
      }
      const match = /^\/servers\/([a-z]+)(?:\/(launch|stop|logs))?$/.exec(url.pathname);
      if (request.method === 'GET' && url.pathname === '/status') return send(200, { servers: await status() });
      if (!match || !SERVERS[match[1]]) return send(404, { error: 'Unknown server' });
      const name = match[1];
      if (request.method === 'GET' && match[2] === 'logs') {
        const tail = Math.max(1, Math.min(Number(url.searchParams.get('tail')) || 100, LOG_LINES));
        return send(200, { deploy: deploy[name].slice(-tail), container: await containerLog(name, tail) });
      }
      if (request.method === 'POST' && match[2] === 'launch') {
        const body = await readBody(request), port = body.port === undefined ? SERVERS[name].port : body.port;
        if (!Number.isInteger(port) || port < 1024 || port > 65535) return send(400, { error: 'Choose a port between 1024 and 65535' });
        if (body.claim !== undefined && body.claim !== '' && (name !== 'plex' || typeof body.claim !== 'string' || !CLAIM.test(body.claim))) return send(400, { error: 'That is not a Plex claim token (it starts with claim-)' });
        return send(202, await launch(name, { port, claim: body.claim || '' }));
      }
      if (request.method === 'POST' && match[2] === 'stop') { await stop(name); return send(200, { ok: true }); }
      if (request.method === 'DELETE' && !match[2]) { await remove(name); return send(200, { ok: true }); }
      return send(405, { error: 'Method not allowed' });
    } catch (error) {
      const status = error && typeof error.status === 'number' ? error.status : 502;
      send(status, { error: status === 502 ? 'Docker could not be reached' : error.message });
    }
  });
  return { server, specFor: (name, options) => specFor(name, options, config), status, update: doUpdate, updateState: () => upd };
}

module.exports = { createManager, SERVERS };

if (require.main === module) {
  const need = key => { const value = process.env[key]; if (!value) { console.error(`${key} is required`); process.exit(1); } return value; };
  const token = need('MEDIA_MANAGER_TOKEN'), hostDir = need('HOST_INSTALL_DIR');
  if (token.length < 32) { console.error('MEDIA_MANAGER_TOKEN must be at least 32 characters'); process.exit(1); }
  if (!path.isAbsolute(hostDir) || hostDir.includes('..') || /[\0\n\r]/.test(hostDir)) { console.error('HOST_INSTALL_DIR must be an absolute path'); process.exit(1); }
  const manager = createManager({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock', token, hostDir: hostDir.replace(/\/+$/, ''), network: process.env.DOCKER_NETWORK || '', zurg: process.env.ZURG === '1', tz: process.env.TZ || 'UTC', streamrdContainer: process.env.STREAMRD_CONTAINER || 'streamrd' });
  manager.server.listen(Number(process.env.PORT) || 8099, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', message: 'Media manager listening' })));
}
