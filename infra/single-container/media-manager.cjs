'use strict';
// The helper: the one part of StreamRD that talks to Docker. It starts, stops, updates and removes exactly three containers (Jellyfin,
// Plex and Prowlarr) next to StreamRD, replaces the StreamRD container with a newer image of its own, and restarts it, so the web pages
// can do all of that.
//
// It runs in one of two places, with the same rules:
//   - inside the StreamRD container (--embedded, the default). The container's first program (init.cjs) starts it as root and runs
//     everything else as an unprivileged user, so the helper is the only process that can open Docker's socket. It listens on the
//     container's own loopback address and reads where the container's folders live on the machine from the container itself;
//   - in a container of its own (how installs before v0.24.0 ran it, still supported): HOST_INSTALL_DIR names the install folder and it
//     listens on the internal compose network.
// A third mode, --swap, is the short-lived updater the embedded helper starts to replace the container it lives in.
//
// To keep what it can do small it:
//   - answers only requests carrying MEDIA_MANAGER_TOKEN;
//   - accepts only a server name (jellyfin, plex or prowlarr), a port and an optional Plex claim token; the image, the folders it mounts, the
//     user it runs as and every other setting of the container are fixed here, not chosen by the caller;
//   - never logs or stores the claim token;
//   - updates only the StreamRD container, only to a newer image of the reference that container already uses; the caller chooses
//     nothing. The old container is kept until the new one is healthy and put back if it is not;
//   - restarts only that same container (the Restart button, and applying a staged restore);
//   - sets one thing on a media server after it was made: whether Docker starts it again by itself after the machine restarts;
//   - updates a server it started without being told which image to use: it downloads the image the server's fixed reference points to
//     now and, when that differs from the one running and it was asked to, makes the container again from the same fixed specification
//     (same port, same folders), keeping the old container until the new one runs and putting it back if it does not.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVERS = {
  jellyfin: { image: 'jellyfin/jellyfin', tag: 'latest', port: 8096, internal: 8096 },
  plex: { image: 'plexinc/pms-docker', tag: 'latest', port: 32400, internal: 32400 },
  // Prowlarr finds releases for requests (it keeps the list of indexers). It is a separate program with its own licence and releases,
  // started from a fixed specification like the media servers, but it is given only a folder for its own settings, nothing of the libraries.
  prowlarr: { image: 'lscr.io/linuxserver/prowlarr', tag: 'latest', port: 9696, internal: 9696 },
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

/** The id Docker (or Podman) gave this container, read from the files it mounts into every container (/proc/self/mountinfo). */
function containerIdFrom(mountinfo) {
  const match = /\/([0-9a-f]{64})\/(?:userdata\/)?(?:hostname|hosts|resolv\.conf)\s/.exec(String(mountinfo ?? ''));
  return match ? match[1] : '';
}
/** Where a folder inside a container lives on the machine, from that container's list of mounts. Null when it is not on a mount. */
function hostPath(mounts, target) {
  let best = null;
  for (const mount of mounts || []) {
    const inside = String(mount.Destination || '').replace(/\/+$/, '') || '/';
    if (!mount.Source || !(target === inside || inside === '/' || target.startsWith(`${inside}/`))) continue;
    if (!best || inside.length > best.inside.length) best = { inside, source: String(mount.Source).replace(/\/+$/, '') };
  }
  return best ? best.source + target.slice(best.inside === '/' ? 0 : best.inside.length) : null;
}
// A layout says where things are on the machine: StreamRD's settings folder (the media servers keep theirs inside it, next to the
// libraries StreamRD exports), the downloads, and the Real-Debrid mount when there is one.
/** The install folder's layout, as the helper in a container of its own is told it. */
const fixedLayout = (hostDir, zurg) => ({ settings: `${hostDir}/config`, data: { source: `${hostDir}/data`, target: '/data' }, zurg: zurg ? `${hostDir}/mnt/zurg` : null });
/** The same, read from the StreamRD container's own mounts by the helper that runs inside it. */
function ownLayout(mounts, dirs) {
  const settings = hostPath(mounts, dirs.config), data = hostPath(mounts, dirs.data);
  if (!settings || !data) throw new Error(`StreamRD's folders (${dirs.config}${dirs.config === dirs.data ? '' : ` and ${dirs.data}`}) are not kept on this machine, so a media server cannot be given them. Start StreamRD with a volume for each`);
  const zurg = (mounts || []).some(mount => String(mount.Destination || '').replace(/\/+$/, '') === '/mnt/zurg') ? hostPath(mounts, '/mnt/zurg') : null;
  return { settings, data: { source: data, target: dirs.data }, zurg };
}
// Folders under the settings folder that a media server is given. They must exist, owned by the user the servers run as, before Docker
// mounts them: Docker would otherwise make them as root and the servers could not write.
// The settings folder is written by StreamRD's user and this runs as root, so a folder that is a link (which StreamRD's user could point
// anywhere) is refused rather than followed, and ownership is only ever given to a folder that is really one, never to what a link names.
const FOLDERS = { jellyfin: ['jellyfin/config', 'jellyfin/cache'], plex: ['plex/config', 'plex/transcode'], prowlarr: ['prowlarr/config'], both: ['streamrd/library', 'phosphor/library'] };
function ownFolder(base, relative, uid, gid) {
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    let stat = null;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && !stat.isDirectory()) throw new Error(`${relative} in StreamRD's settings folder is not a plain folder, so it was not given to the media server. Remove it and launch again`);
    if (!stat) { fs.mkdirSync(current); stat = fs.lstatSync(current); }
    if (stat.uid === 0 && uid !== 0 && process.getuid() === 0) fs.lchownSync(current, uid, gid);
  }
}

/** Everything about a container except the port and the claim token is decided here. */
function specFor(name, options, config, layout) {
  const server = SERVERS[name], mounts = [], settings = layout.settings;
  const bind = (source, target, readOnly, propagation) => mounts.push({ Type: 'bind', Source: source, Target: target, ReadOnly: readOnly, ...(propagation ? { BindOptions: { Propagation: propagation } } : {}) });
  if (name === 'jellyfin') { bind(`${settings}/jellyfin/config`, '/config', false); bind(`${settings}/jellyfin/cache`, '/cache', false); }
  else if (name === 'prowlarr') bind(`${settings}/prowlarr/config`, '/config', false);
  else { bind(`${settings}/plex/config`, '/config', false); bind(`${settings}/plex/transcode`, '/transcode', false); }
  if (name !== 'prowlarr') {   // the media servers see the libraries and the downloads (read-only); Prowlarr sees neither
    bind(`${settings}/streamrd/library`, '/library/streamrd', true);
    bind(`${settings}/phosphor/library`, '/library/phosphor', true);
    bind(layout.data.source, layout.data.target, true);
    if (layout.zurg) bind(layout.zurg, '/mnt/zurg', true, 'rslave');
  }
  const env = [`TZ=${config.tz || 'UTC'}`];
  if (name === 'prowlarr') env.push('PUID=1000', 'PGID=1000');
  if (name === 'plex') { env.push('PLEX_UID=1000', 'PLEX_GID=1000'); if (options.claim) env.push(`PLEX_CLAIM=${options.claim}`); }
  const port = `${server.internal}/tcp`, network = layout.network;
  return {
    Image: `${server.image}:${server.tag}`, Env: env, ExposedPorts: { [port]: {} }, ...(name === 'jellyfin' ? { User: '1000:1000' } : {}),
    Labels: { 'streamrd.managed': 'true', 'streamrd.server': name },
    HostConfig: { Mounts: mounts, PortBindings: { [port]: [{ HostPort: String(options.port) }] }, RestartPolicy: { Name: options.autostart === false ? 'no' : 'unless-stopped' }, ...(network ? { NetworkMode: network } : {}) },
    ...(network ? { NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [containerName(name)] } } } } : {}),
  };
}

function createManager(config) {
  const jobs = {}; // in-flight launches: { state: 'pulling' | 'starting' | 'failed', error? }
  const deploy = Object.fromEntries(Object.keys(SERVERS).map(key => [key, []])); // what the manager did for each server, oldest first
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
  // ---- Which container StreamRD is, and where its folders are on the machine.
  // The helper in a container of its own is told both. The embedded helper asks Docker about the container it runs in, once: a
  // container's mounts and name do not change while it lives.
  let me = null;
  async function self() {
    if (me) return me;
    for (const candidate of [config.selfName, config.selfId, config.hostname].filter(Boolean)) {
      const response = await docker('GET', `/containers/${encodeURIComponent(candidate)}/json`);
      if (response.status !== 200 || !response.json?.Id) continue;
      const found = response.json, mounts = found.Mounts || [];
      me = {
        id: found.Id, name: String(found.Name || '').replace(/^\//, '') || found.Id, image: found.Image, mounts,
        network: Object.keys(found.NetworkSettings?.Networks || {}).find(network => !['bridge', 'host', 'none'].includes(network)) || '',
        socket: hostPath(mounts, config.socketPath) || config.socketPath,
        labelOptions: (found.HostConfig?.SecurityOpt || []).filter(option => /^label[=:]/.test(option)),
      };
      return me;
    }
    throw Object.assign(new Error('StreamRD could not find its own container through Docker. Set STREAMRD_CONTAINER to the container\'s name'), { status: 409 });
  }
  const targetName = async () => config.embedded ? (await self()).name : STREAMRD;
  async function layout() {
    if (!config.embedded) return { ...fixedLayout(config.hostDir, config.zurg), network: config.network || '' };
    const own = await self();
    return { ...ownLayout(own.mounts, config.dirs), network: own.network };
  }
  /** The embedded helper shares StreamRD's settings folder, so it makes the folders a server is about to be given, owned by the servers' user. */
  function prepareFolders(name) {
    if (!config.embedded) return;
    for (const folder of [...FOLDERS[name], ...(name === 'prowlarr' ? [] : FOLDERS.both)]) ownFolder(config.dirs.config, folder, config.appUid ?? 1000, config.appGid ?? 1000);
  }

  async function inspect(name) {
    const response = await docker('GET', `/containers/${containerName(name)}/json`);
    if (response.status === 404) return { state: 'absent' };
    if (response.status !== 200) throw new Error(`Docker answered ${response.status}`);
    const bindings = response.json?.HostConfig?.PortBindings?.[`${SERVERS[name].internal}/tcp`];
    // autostart: Docker starts the server again by itself after the machine or Docker restarts, unless it was stopped on purpose.
    // address: where StreamRD reaches the server when no shared network gives it a name (a container started with plain `docker run`).
    const address = Object.values(response.json?.NetworkSettings?.Networks || {}).map(network => network?.IPAddress).find(Boolean);
    return { state: response.json?.State?.Running ? 'running' : 'stopped', port: Number(bindings?.[0]?.HostPort) || SERVERS[name].port, autostart: !['', 'no'].includes(response.json?.HostConfig?.RestartPolicy?.Name ?? 'unless-stopped'), ...(address && response.json?.State?.Running ? { address } : {}) };
  }
  /** Changes whether an existing server comes back by itself after a restart of the machine. Nothing else about the container changes. */
  async function setAutostart(name, enabled) {
    const response = await docker('POST', `/containers/${containerName(name)}/update`, { RestartPolicy: { Name: enabled ? 'unless-stopped' : 'no' } });
    if (response.status === 404) throw Object.assign(new Error('That server has not been launched yet'), { status: 409 });
    if (response.status !== 200) throw new Error(`Docker answered ${response.status}`);
    note(name, enabled ? 'Set to start again by itself after a restart of this machine' : 'Set to stay stopped after a restart of this machine');
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
  /** A container's output, oldest line first. Docker frames each line with an 8 byte header unless the container has a terminal. */
  async function output(container, tail, timestamps) {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ socketPath: config.socketPath, path: `/containers/${container}/logs?stdout=1&stderr=1&timestamps=${timestamps ? 1 : 0}&tail=${tail}`, method: 'GET', headers: { Host: 'docker' } }, reply => {
        const chunks = []; let size = 0; reply.on('data', chunk => { size += chunk.length; if (size <= 1048576) chunks.push(chunk); }); reply.on('end', () => resolve({ status: reply.statusCode, body: Buffer.concat(chunks) }));
      });
      request.on('error', reject); request.end();
    });
    if (response.status !== 200) return [];
    const body = response.body, out = []; let offset = 0;
    const framed = body.length >= 8 && body[0] <= 2 && body[1] === 0 && body[2] === 0 && body[3] === 0;
    if (framed) { while (offset + 8 <= body.length) { const size = body.readUInt32BE(offset + 4); out.push(...body.subarray(offset + 8, offset + 8 + size).toString('utf8').split('\n')); offset += 8 + size; } }
    else out.push(...body.toString('utf8').split('\n'));
    return out.filter(text => text.trim()).slice(-tail);
  }
  /** A media server's own output, with tokens blanked. */
  const containerLog = async (name, tail) => (await output(containerName(name), tail, true)).map(text => redact(text).slice(0, 400)).filter(text => text.trim());
  async function launch(name, options) {
    if (jobs[name] && jobs[name].state !== 'failed') return jobs[name];
    jobs[name] = { state: 'pulling' }; note(name, `Launch requested on port ${options.port}${options.claim ? ' with a claim token' : ''}${options.autostart === false ? ', not started again after a restart of this machine' : ''}`);
    (async () => {
      try {
        await ensureImage(name); jobs[name] = { state: 'starting' }; note(name, 'Starting the container');
        await docker('DELETE', `/containers/${containerName(name)}?force=true`); // recreated each launch; the folders under config/ keep its settings
        const where = await layout(); prepareFolders(name);
        const created = await docker('POST', `/containers/create?name=${containerName(name)}`, specFor(name, options, config, where));
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

  // ---- Updating a server (Jellyfin, Plex, Prowlarr) without waiting for a StreamRD release.
  // updates[name] is the last check or update of each server: { state: 'running' | 'current' | 'available' | 'done' | 'failed', apply, step, error, ... }.
  const updates = {};
  /** What an image says about itself: its id, its version label (when it has one) and when it was built. Null when Docker does not have it. */
  async function imageInfo(reference) {
    const response = await docker('GET', `/images/${reference.startsWith('sha256:') ? reference : encodeURIComponent(reference)}/json`);
    if (response.status !== 200 || !response.json?.Id) return null;
    const version = String(response.json.Config?.Labels?.['org.opencontainers.image.version'] ?? '').trim();
    return { id: response.json.Id, version: /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,59}$/.test(version) ? version : '', created: typeof response.json.Created === 'string' && !Number.isNaN(Date.parse(response.json.Created)) ? response.json.Created : '' };
  }
  const shown = info => info ? { version: info.version, created: info.created } : null;
  async function moduleView(name) {
    const found = await docker('GET', `/containers/${containerName(name)}/json`);
    return { state: 'idle', ...(updates[name] || {}), current: found.status === 200 && found.json?.Image ? shown(await imageInfo(found.json.Image)) : null };
  }
  /**
   * Looks for a newer image of a server and, when asked to, runs the server from it. The answer is what was found: 'current' (the image
   * running is the newest), 'available' (a newer one is on this machine, nothing was changed) or 'updated'.
   */
  async function moduleUpdate(name, apply) {
    const server = SERVERS[name], reference = `${server.image}:${server.tag}`, record = updates[name];
    const say = text => { record.step = text; note(name, text); };
    say(`Checking ${reference} for a newer version`);
    await pull(name, server);
    const found = await docker('GET', `/containers/${containerName(name)}/json`);
    if (found.status !== 200 || !found.json?.Id) throw new Error('The server is no longer there');
    const fresh = await imageInfo(reference);
    if (!fresh) throw new Error('The new image is not available after the download');
    record.current = shown(await imageInfo(found.json.Image));
    if (fresh.id === found.json.Image) { record.available = null; say('Already running the newest version'); return 'current'; }
    record.available = shown(fresh);
    say(`A newer version is available${fresh.version ? ` (${fresh.version})` : ''}`);
    return apply ? replaceServer(name, found.json, fresh, say) : 'available';
  }
  /** Makes the container again from the image its reference now points at. The old one is kept until the new one runs, and put back if it does not. */
  async function replaceServer(name, inspected, fresh, say) {
    const mine = containerName(name), previous = `${mine}-previous`, policy = inspected.HostConfig?.RestartPolicy?.Name ?? 'unless-stopped';
    const bindings = inspected.HostConfig?.PortBindings?.[`${SERVERS[name].internal}/tcp`];
    const options = { port: Number(bindings?.[0]?.HostPort) || SERVERS[name].port, autostart: !['', 'no'].includes(policy), claim: '' };
    const where = await layout(); prepareFolders(name);
    const body = specFor(name, options, config, where);
    jobs[name] = { state: 'starting' };   // until it runs again, the server reads as starting, and nothing else launches it
    try {
      say(`Stopping ${name} to start the new version (it is back in a minute)`);
      await docker('DELETE', `/containers/${previous}?force=true`);
      await docker('POST', `/containers/${mine}/update`, { RestartPolicy: { Name: 'no' } });
      await mustOk('Stopping the server', await docker('POST', `/containers/${mine}/stop?t=30`), [204, 304]);
      await mustOk('Keeping the old container', await docker('POST', `/containers/${mine}/rename?name=${previous}`), [204]);
      const restore = async why => {
        say(`${why}; putting the previous version back`);
        await docker('DELETE', `/containers/${mine}?force=true`);
        await docker('POST', `/containers/${previous}/rename?name=${mine}`);
        await docker('POST', `/containers/${mine}/update`, { RestartPolicy: { Name: policy } });
        await docker('POST', `/containers/${mine}/start`);
      };
      try {
        const created = await docker('POST', `/containers/create?name=${mine}`, body);
        if (created.status !== 201 || !created.json?.Id) throw new Error(`Creating the new container failed (Docker answered ${created.status}${created.json?.message ? `: ${String(created.json.message).slice(0, 160)}` : ''})`);
        await mustOk('Starting the new version', await docker('POST', `/containers/${mine}/start`), [204, 304]);
      } catch (error) { await restore(error.message); throw new Error(`${error.message}. The previous version was restored.`); }
      say('Waiting for the new version to start');
      if (!await waitHealthy(mine)) { await restore('The new version did not start properly'); throw new Error('The new version did not start properly. The previous version was restored; its settings were not touched.'); }
      await docker('DELETE', `/containers/${previous}?force=true`);
      say(`Updated${fresh.version ? ` to ${fresh.version}` : ''}. The previous image is kept on this machine until you prune it.`);
      return 'updated';
    } finally { delete jobs[name]; }
  }
  /** Starts a check (apply false) or an update (apply true) and answers at once; the page reads the outcome with moduleView. */
  async function startModuleUpdate(name, apply) {
    if (jobs[name] && jobs[name].state !== 'failed') throw Object.assign(new Error('That server is being started. Try again when it is running'), { status: 409 });
    if (updates[name]?.state === 'running') return { ...updates[name] };
    const found = await docker('GET', `/containers/${containerName(name)}/json`);
    if (found.status === 404) throw Object.assign(new Error('That server has not been launched yet'), { status: 409 });
    if (found.status !== 200) throw new Error(`Docker answered ${found.status}`);
    if (apply && !found.json?.State?.Running) throw Object.assign(new Error('Start it before updating it'), { status: 409 });
    const record = updates[name] = { state: 'running', apply, step: 'Checking for a newer version', error: '', startedAt: new Date().toISOString(), finishedAt: null, current: null, available: null };
    moduleUpdate(name, apply).then(result => { record.state = result; }, error => {
      record.state = 'failed'; record.error = redact(error && error.message ? error.message : 'The update failed').slice(0, 300); note(name, `Failed: ${record.error}`);
    }).finally(() => { record.finishedAt = new Date().toISOString(); });
    return { ...record };
  }

  // ---- Updating StreamRD itself.
  const STREAMRD = config.streamrdContainer || 'streamrd', HEALTH_WAIT_MS = config.healthWaitMs || 300000, SETTLE_MS = config.settleMs === undefined ? 8000 : config.settleMs;
  const upd = { state: 'idle', log: [], error: '', startedAt: null, finishedAt: null, handed: false };
  const unote = message => { const entry = { time: new Date().toISOString(), message: redact(message).slice(0, 300) }; upd.log.push(entry); if (upd.log.length > LOG_LINES) upd.log.splice(0, upd.log.length - LOG_LINES); if (config.onNote) config.onNote(entry); };
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
  /** Pulls the image StreamRD runs; a newer one is swapped in here, or by the updater when this helper lives in the container to replace. */
  async function doUpdate() {
    const name = await targetName(), current = await docker('GET', `/containers/${name}/json`);
    if (current.status !== 200) throw new Error('The StreamRD container was not found');
    const inspected = current.json, reference = inspected.Config?.Image || '';
    if (!reference || reference.startsWith('sha256:')) throw new Error('StreamRD was not started from a named image, so it cannot be updated from here');
    const [image, tag] = splitReference(reference);
    unote(`Checking ${reference} for a newer version`);
    await pullImage(image, tag, unote);
    const fresh = await docker('GET', `/images/${encodeURIComponent(reference)}/json`);
    if (fresh.status !== 200) throw new Error('The new image is not available after the download');
    if (fresh.json?.Id === inspected.Image) { unote('Already running the newest image'); return 'current'; }
    return config.embedded ? handOver(name) : swap(name, inspected, reference);
  }
  /** Replaces the container with one from the image its reference now points at; the old one comes back if the new one does not start. */
  async function swap(name, inspected, reference) {
    const oldImage = (await docker('GET', `/images/${inspected.Image}/json`)).json?.Config;
    const body = recreateBody(inspected, oldImage, reference), networks = networksOf(inspected), previous = `${name}-previous`;
    unote('Stopping StreamRD (it is back in a minute)');
    await docker('DELETE', `/containers/${previous}?force=true`);
    await mustOk('Stopping StreamRD', await docker('POST', `/containers/${name}/stop?t=30`), [204, 304]);
    await mustOk('Keeping the old container', await docker('POST', `/containers/${name}/rename?name=${previous}`), [204]);
    const restore = async why => {
      unote(`${why}; putting the previous version back`);
      await docker('DELETE', `/containers/${name}?force=true`);
      await docker('POST', `/containers/${previous}/rename?name=${name}`);
      await docker('POST', `/containers/${name}/start`);
    };
    try {
      const [first] = networks;
      const created = await docker('POST', `/containers/create?name=${name}`, { ...body, ...(first ? { NetworkingConfig: { EndpointsConfig: { [first[0]]: first[1] } } } : {}) });
      if (created.status !== 201 || !created.json?.Id) throw new Error(`Creating the new container failed (Docker answered ${created.status})`);
      for (const [network, endpoint] of networks.slice(1)) await docker('POST', `/networks/${encodeURIComponent(network)}/connect`, { Container: created.json.Id, EndpointConfig: endpoint });
      await mustOk('Starting the new version', await docker('POST', `/containers/${name}/start`), [204, 304]);
    } catch (error) { await restore(error.message); throw new Error(`${error.message}. The previous version was restored.`); }
    unote('Waiting for the new version to start');
    if (!await waitHealthy(name)) { await restore('The new version did not become healthy'); throw new Error('The new version did not start properly. The previous version was restored; nothing was lost.'); }
    await docker('DELETE', `/containers/${previous}?force=true`);
    unote('Updated. The previous image is kept on this machine until you prune it.');
    return 'updated';
  }
  // ---- The embedded helper cannot replace the container it runs in: stopping it stops the helper. It starts a short-lived updater
  // instead, from the image this container runs now (so the code that does the swap is the installed version's, not the download's),
  // which gets Docker's socket and nothing else: no network, no folders, a read-only filesystem, no capabilities. The updater keeps
  // its account of the swap as its output; whichever StreamRD container is running afterwards reads it and removes the updater.
  const updaterName = async () => `${await targetName()}-updater`;
  async function handOver(name) {
    const own = await self(), updater = await updaterName();
    unote('Handing over to a short-lived updater: this container is about to be replaced');
    await docker('DELETE', `/containers/${updater}?force=true`);
    const created = await docker('POST', `/containers/create?name=${updater}`, {
      Image: own.image, Entrypoint: ['node', '/opt/single-container/media-manager.cjs'], Cmd: ['--swap'], User: '0:0', WorkingDir: '/',
      Env: [`STREAMRD_CONTAINER=${name}`, `STREAMRD_UPDATE_LOG=${JSON.stringify(upd.log.slice(-40))}`],
      Labels: { 'streamrd.managed': 'true', 'streamrd.role': 'updater' }, Healthcheck: { Test: ['NONE'] },
      HostConfig: { Binds: [`${own.socket}:/var/run/docker.sock`], NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true', ...own.labelOptions], RestartPolicy: { Name: 'no' } },
    });
    if (created.status !== 201) throw new Error(`The updater could not be created (Docker answered ${created.status})`);
    await mustOk('Starting the updater', await docker('POST', `/containers/${updater}/start`), [204, 304]);
    upd.handed = true;
    return 'handed';
  }
  /** What the updater did, read from its container. Null when there is none. */
  async function updaterReport() {
    const name = await updaterName(), found = await docker('GET', `/containers/${name}/json`);
    if (found.status !== 200 || found.json?.Config?.Labels?.['streamrd.role'] !== 'updater') return null;
    const log = []; let result = '', error = '';
    for (const text of await output(name, LOG_LINES, false)) {
      let entry; try { entry = JSON.parse(text); } catch { entry = null; }
      // Anything the updater printed that is not its own account (a crash, a message from Node) is kept as a step, so a failure is never silent.
      if (!entry || typeof entry !== 'object') { log.push({ time: new Date().toISOString(), message: redact(text).slice(0, 300) }); continue; }
      if (typeof entry.time === 'string' && typeof entry.message === 'string') log.push({ time: entry.time.slice(0, 40), message: redact(entry.message).slice(0, 300) });
      if (typeof entry.result === 'string') { result = entry.result; error = typeof entry.error === 'string' ? redact(entry.error).slice(0, 300) : ''; }
    }
    const state = found.json.State || {}, ended = ['exited', 'dead'].includes(state.Status);
    if (ended && !result) error = `The updater stopped before it finished (exit code ${Number.isInteger(state.ExitCode) ? state.ExitCode : 'unknown'}${state.Error ? `: ${redact(state.Error).slice(0, 160)}` : ''})`;
    return { name, ended, result, error, finishedAt: ended && typeof state.FinishedAt === 'string' ? state.FinishedAt : null, log };
  }
  /** How the last update went. The embedded helper may be a new process in a new container: the updater's account is the record. */
  // One reader at a time. Two readers at once (the page, and the server recording the outcome after a start) each read the updater, and the one
  // that read it while it still ran could write "running" after the other had written the final result, and nothing would ever correct it.
  let reading = Promise.resolve();
  function updateView() { const run = reading.then(readUpdate, readUpdate); reading = run.then(() => undefined, () => undefined); return run; }
  async function readUpdate() {
    if (config.embedded && (upd.handed || upd.state === 'idle')) {
      let report = await updaterReport().catch(error => { console.error(`[helper] could not read the updater's account: ${error && error.message}`); return null; });
      // Docker can report a container as ended a moment before its output is all readable; look once more before calling an updater silent.
      if (report && report.ended && !report.result) { await sleep(config.logSettleMs === undefined ? 1500 : config.logSettleMs); report = await updaterReport().catch(() => report); }
      if (report) {
        // What was seen while it ran is kept if the output cannot be read at the end: it says how far it got.
        if (report.log.length || !upd.log.length) upd.log = report.log.slice(-LOG_LINES);
        upd.startedAt = upd.startedAt || upd.log[0]?.time || null;
        if (!report.ended) { upd.state = 'running'; upd.handed = true; }
        else {
          upd.state = report.result === 'updated' ? 'done' : report.result === 'current' ? 'current' : 'failed';
          upd.error = upd.state === 'failed' ? report.error || 'The updater failed' : '';
          upd.finishedAt = report.finishedAt || new Date().toISOString(); upd.handed = false;
          await docker('DELETE', `/containers/${report.name}?force=true`).catch(() => undefined);
        }
      } else if (upd.handed) {
        // Handed over, and the updater is gone without anyone having read its end: say so rather than stay "running" for good.
        upd.state = 'failed'; upd.error = 'The updater is gone and left no account. Check that StreamRD is running the version you expect.'; upd.finishedAt = new Date().toISOString(); upd.handed = false;
      }
    }
    return { state: upd.state, error: upd.error, startedAt: upd.startedAt, finishedAt: upd.finishedAt, log: upd.log.slice(-50) };
  }
  /** The updater's whole job (--swap): replace the named container with the image its reference now points at. */
  async function swapNow() {
    const current = await docker('GET', `/containers/${STREAMRD}/json`);
    if (current.status !== 200) throw new Error('The StreamRD container was not found');
    const inspected = current.json, reference = inspected.Config?.Image || '';
    const fresh = await docker('GET', `/images/${encodeURIComponent(reference)}/json`);
    if (fresh.status !== 200) throw new Error('The new image is not on this machine');
    if (fresh.json?.Id === inspected.Image) { unote('Already running the newest image'); return 'current'; }
    return swap(STREAMRD, inspected, reference);
  }
  /**
   * Restarts the StreamRD container, for the Restart button and for applying a staged restore. The answer goes out first: the caller is
   * inside the container that is about to stop (and so, when embedded, is this helper; Docker finishes a restart it has begun).
   */
  let restarting = false;
  function startRestart() {
    if (restarting || upd.state === 'running') return { restarting: false, reason: upd.state === 'running' ? 'An update is running' : 'A restart is already under way' };
    restarting = true;
    setTimeout(() => { targetName().then(name => docker('POST', `/containers/${name}/restart?t=30`)).catch(() => undefined).finally(() => { restarting = false; }); }, config.restartDelayMs === undefined ? 1000 : config.restartDelayMs);
    return { restarting: true };
  }
  function startUpdate() {
    if (upd.state === 'running') return { state: 'running' };
    Object.assign(upd, { state: 'running', log: [], error: '', startedAt: new Date().toISOString(), finishedAt: null, handed: false });
    doUpdate().then(result => { if (result !== 'handed') upd.state = result === 'current' ? 'current' : 'done'; }, error => { upd.state = 'failed'; upd.error = redact(error.message || 'The update failed'); unote(upd.error); }).finally(() => { if (upd.state !== 'running') upd.finishedAt = new Date().toISOString(); });
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
        if (request.method === 'GET') return send(200, await updateView());
        return send(405, { error: 'Method not allowed' });
      }
      if (url.pathname === '/restart') {
        if (request.method !== 'POST') return send(405, { error: 'Method not allowed' });
        const result = startRestart(); return send(result.restarting ? 202 : 409, result.restarting ? result : { error: result.reason });
      }
      const match = /^\/servers\/([a-z]+)(?:\/(launch|stop|logs|autostart|update))?$/.exec(url.pathname);
      if (request.method === 'GET' && url.pathname === '/status') return send(200, { servers: await status(), ...(config.embedded ? { embedded: true } : {}) });
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
        if (body.autostart !== undefined && typeof body.autostart !== 'boolean') return send(400, { error: 'autostart is true or false' });
        return send(202, await launch(name, { port, claim: body.claim || '', autostart: body.autostart !== false }));
      }
      if (request.method === 'POST' && match[2] === 'autostart') {
        const body = await readBody(request);
        if (typeof body.enabled !== 'boolean') return send(400, { error: 'enabled is true or false' });
        await setAutostart(name, body.enabled); return send(200, { ok: true, autostart: body.enabled });
      }
      if (match[2] === 'update') {
        if (request.method === 'GET') return send(200, await moduleView(name));
        if (request.method === 'POST') {
          const body = await readBody(request);
          if (body.apply !== undefined && typeof body.apply !== 'boolean') return send(400, { error: 'apply is true or false' });
          return send(202, await startModuleUpdate(name, body.apply === true));
        }
        return send(405, { error: 'Method not allowed' });
      }
      if (request.method === 'POST' && match[2] === 'stop') { await stop(name); return send(200, { ok: true }); }
      if (request.method === 'DELETE' && !match[2]) { await remove(name); return send(200, { ok: true }); }
      return send(405, { error: 'Method not allowed' });
    } catch (error) {
      const status = error && typeof error.status === 'number' ? error.status : 502;
      send(status, { error: status === 502 ? 'Docker could not be reached' : error.message });
    }
  });
  return { server, status, update: doUpdate, updateState: () => upd, updateView, swapNow, self };
}

module.exports = { createManager, SERVERS, containerIdFrom, hostPath, ownLayout, fixedLayout };

if (require.main === module) {
  const need = key => { const value = process.env[key]; if (!value) { console.error(`${key} is required`); process.exit(1); } return value; };
  const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock', tz = process.env.TZ || 'UTC';
  const say = message => console.log(JSON.stringify({ level: 'info', message }));
  if (process.argv.includes('--swap')) {
    // The updater. Its output is the record of the swap: one JSON object per line, ending with the result.
    const print = entry => process.stdout.write(`${JSON.stringify(entry)}\n`);
    let earlier = []; try { const value = JSON.parse(process.env.STREAMRD_UPDATE_LOG || '[]'); if (Array.isArray(value)) earlier = value; } catch { /* the swap matters more than what came before it */ }
    for (const entry of earlier) if (entry && typeof entry.time === 'string' && typeof entry.message === 'string') print({ time: entry.time, message: entry.message });
    createManager({ socketPath, token: crypto.randomBytes(32).toString('hex'), streamrdContainer: need('STREAMRD_CONTAINER'), onNote: print }).swapNow().then(
      result => print({ time: new Date().toISOString(), result }),
      error => { const message = error && error.message ? error.message : 'The update failed'; print({ time: new Date().toISOString(), message }); print({ time: new Date().toISOString(), result: 'failed', error: message }); process.exitCode = 1; });
  } else {
    const token = need('MEDIA_MANAGER_TOKEN');
    if (token.length < 32) { console.error('MEDIA_MANAGER_TOKEN must be at least 32 characters'); process.exit(1); }
    if (process.argv.includes('--embedded')) {
      const data = process.env.DATA_DIR || '/data', own = name => { const value = Number.parseInt(process.env[name] ?? '', 10); return Number.isInteger(value) && value >= 0 ? value : 1000; };
      let mountinfo = ''; try { mountinfo = fs.readFileSync('/proc/self/mountinfo', 'utf8'); } catch { /* the hostname is tried next */ }
      const manager = createManager({ embedded: true, socketPath, token, tz, dirs: { config: process.env.CONFIG_DIR || data, data }, appUid: own('APP_UID'), appGid: own('APP_GID'),
        selfName: process.env.STREAMRD_CONTAINER || '', selfId: containerIdFrom(mountinfo), hostname: os.hostname() });
      manager.server.listen(Number(process.env.PORT) || 8099, '127.0.0.1', () => say('Docker helper listening inside the container'));
    } else {
      const hostDir = need('HOST_INSTALL_DIR');
      if (!path.isAbsolute(hostDir) || hostDir.includes('..') || /[\0\n\r]/.test(hostDir)) { console.error('HOST_INSTALL_DIR must be an absolute path'); process.exit(1); }
      const manager = createManager({ socketPath, token, hostDir: hostDir.replace(/\/+$/, ''), network: process.env.DOCKER_NETWORK || '', zurg: process.env.ZURG === '1', tz, streamrdContainer: process.env.STREAMRD_CONTAINER || 'streamrd' });
      manager.server.listen(Number(process.env.PORT) || 8099, '0.0.0.0', () => say('Media manager listening'));
    }
  }
}
