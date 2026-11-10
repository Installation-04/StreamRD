'use strict';
// The media manager: a tiny helper that starts, stops and removes exactly two containers (Jellyfin and Plex) next to StreamRD,
// so the Setup page can launch a media server without the StreamRD container itself ever touching Docker.
//
// It is the only thing in the installation that holds the Docker socket, and it is opt-in (install.sh --media-manager). To keep what
// it can do small it:
//   - listens only on the internal compose network (no published port) and answers only requests carrying MEDIA_MANAGER_TOKEN;
//   - accepts only a server name (jellyfin or plex), a port and an optional Plex claim token; the image, the folders it mounts, the
//     user it runs as and every other setting of the container are fixed here, not chosen by the caller;
//   - never logs or stores the claim token.
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

const SERVERS = {
  jellyfin: { image: 'jellyfin/jellyfin', tag: 'latest', port: 8096, internal: 8096 },
  plex: { image: 'plexinc/pms-docker', tag: 'latest', port: 32400, internal: 32400 },
};
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
  async function ensureImage(name) {
    const server = SERVERS[name], reference = `${server.image}:${server.tag}`;
    if ((await docker('GET', `/images/${encodeURIComponent(reference)}/json`)).status === 200) return;
    const pulled = await docker('POST', `/images/create?fromImage=${encodeURIComponent(server.image)}&tag=${encodeURIComponent(server.tag)}`);
    const failed = pulled.status !== 200 || pulled.text.split('\n').some(line => { try { return Boolean(JSON.parse(line).error); } catch { return false; } });
    if (failed) throw new Error('The image could not be downloaded');
  }
  async function launch(name, options) {
    if (jobs[name] && jobs[name].state !== 'failed') return jobs[name];
    jobs[name] = { state: 'pulling' };
    (async () => {
      try {
        await ensureImage(name); jobs[name] = { state: 'starting' };
        await docker('DELETE', `/containers/${containerName(name)}?force=true`); // recreated each launch; the folders under config/ keep its settings
        const created = await docker('POST', `/containers/create?name=${containerName(name)}`, specFor(name, options, config));
        if (created.status !== 201) throw new Error(`The container could not be created (${created.status}${created.json?.message ? `: ${String(created.json.message).slice(0, 160)}` : ''})`);
        const started = await docker('POST', `/containers/${containerName(name)}/start`);
        if (![204, 304].includes(started.status)) throw new Error(`The container could not be started (${started.status}${started.json?.message ? `: ${String(started.json.message).slice(0, 160)}` : ''})`);
        delete jobs[name];
      } catch (error) { jobs[name] = { state: 'failed', error: error instanceof Error ? error.message : 'Launch failed' }; }
    })();
    return jobs[name];
  }
  async function status() {
    const out = {};
    for (const name of Object.keys(SERVERS)) out[name] = jobs[name] ? { ...jobs[name] } : await inspect(name);
    return out;
  }
  async function stop(name) { delete jobs[name]; const response = await docker('POST', `/containers/${containerName(name)}/stop`); if (![204, 304, 404].includes(response.status)) throw new Error(`Docker answered ${response.status}`); }
  async function remove(name) { delete jobs[name]; const response = await docker('DELETE', `/containers/${containerName(name)}?force=true`); if (![204, 404].includes(response.status)) throw new Error(`Docker answered ${response.status}`); }

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
      const url = new URL(request.url ?? '/', 'http://manager'), match = /^\/servers\/([a-z]+)(?:\/(launch|stop))?$/.exec(url.pathname);
      if (request.method === 'GET' && url.pathname === '/status') return send(200, { servers: await status() });
      if (!match || !SERVERS[match[1]]) return send(404, { error: 'Unknown server' });
      const name = match[1];
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
  return { server, specFor: (name, options) => specFor(name, options, config), status };
}

module.exports = { createManager, SERVERS };

if (require.main === module) {
  const need = key => { const value = process.env[key]; if (!value) { console.error(`${key} is required`); process.exit(1); } return value; };
  const token = need('MEDIA_MANAGER_TOKEN'), hostDir = need('HOST_INSTALL_DIR');
  if (token.length < 32) { console.error('MEDIA_MANAGER_TOKEN must be at least 32 characters'); process.exit(1); }
  if (!path.isAbsolute(hostDir) || hostDir.includes('..') || /[\0\n\r]/.test(hostDir)) { console.error('HOST_INSTALL_DIR must be an absolute path'); process.exit(1); }
  const manager = createManager({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock', token, hostDir: hostDir.replace(/\/+$/, ''), network: process.env.DOCKER_NETWORK || '', zurg: process.env.ZURG === '1', tz: process.env.TZ || 'UTC' });
  manager.server.listen(Number(process.env.PORT) || 8099, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', message: 'Media manager listening' })));
}
