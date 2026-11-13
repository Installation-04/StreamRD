const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
// DATA_DIR holds downloads and media. CONFIG_DIR holds databases, secrets and the download client's settings;
// when it is not set (the original layout) everything lives under DATA_DIR, so existing volumes keep working.
const root = process.env.DATA_DIR || '/data';
const configRoot = process.env.CONFIG_DIR || root;
const qbitEnabled = process.env.ENABLE_QBITTORRENT !== 'false';
// Phosphor is off unless it is asked for (ENABLE_PHOSPHOR=true). One exception keeps an installation that was already running it
// working: with the setting absent, a configuration folder that already holds Phosphor's data means it was in use, so it stays on.
const phosphorSetting = (process.env.ENABLE_PHOSPHOR || '').trim().toLowerCase();
const phosphorEnabled = phosphorSetting
  ? phosphorSetting !== 'false'
  : fs.existsSync(path.join(configRoot, 'phosphor'));
const children = new Map();
const gateways = [];
let stopping = false;
function secret(name, supplied) {
  const file = path.join(configRoot, 'secrets', name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error('Secret files must not be symlinks');
  if (supplied) fs.writeFileSync(file, supplied, { mode: 0o600 });
  else if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  fs.chmodSync(file, 0o600);
  const value = fs.readFileSync(file, 'utf8').trim();
  if (value.length < (name.endsWith('-jwt') ? 32 : 16)) throw Error('Stored secret is too short');
  return value;
}
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  gateways.forEach(server => server.close());
  children.forEach(child => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const timeout = setTimeout(() => { children.forEach(child => { if (child.exitCode === null) child.kill('SIGKILL'); }); process.exit(code); }, 12000);
  timeout.unref();
  const done = () => { if ([...children.values()].every(child => child.exitCode !== null || child.signalCode !== null)) process.exit(code); };
  children.forEach(child => child.once('exit', done));
  done();
}
// The address and secret of the Docker helper are for the API processes only: the download client and the web pages never get them.
const HELPER_ONLY = ['MEDIA_MANAGER_URL', 'MEDIA_MANAGER_TOKEN'];
function launch(name, executable, args, cwd, environment = {}) {
  const inherited = { ...process.env };
  if (!name.endsWith('-api')) for (const key of HELPER_ONLY) delete inherited[key];
  const child = spawn(executable, args, { cwd, env: { ...inherited, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.set(name, child);
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    let pending = '';
    stream.on('data', chunk => {
      pending += chunk.toString();
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) if (!/temporary password/i.test(line)) output.write(`[${name}] ${line}\n`);
    });
  }
  child.once('error', () => { console.error(`${name} could not start`); shutdown(1); });
  child.once('exit', (code, signal) => { if (!stopping) { console.error(`${name} exited (${code ?? signal}); shutting down the container`); shutdown(1); } });
  return child;
}
async function migrate(cwd, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/prepare-db.cjs'], { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
    const key = cwd + '-migration'; children.set(key, child);
    child.once('error', reject); child.once('exit', code => { children.delete(key); code === 0 ? resolve() : reject(Error('Database preparation failed; services were not started')); });
  });
}
function ini(section, key, value, text) {
  const lines = text.split('\n');
  let start = lines.indexOf(`[${section}]`);
  if (start < 0) { lines.push(`[${section}]`, `${key}=${value}`); return lines.join('\n'); }
  let end = start + 1; while (end < lines.length && !/^\[/.test(lines[end])) end++;
  const at = lines.findIndex((line, index) => index > start && index < end && line.startsWith(key + '='));
  if (at < 0) lines.splice(end, 0, `${key}=${value}`); else lines[at] = `${key}=${value}`;
  return lines.join('\n');
}
function prepareQbit(accessHost = '') {
  const password = secret('qbittorrent-password', process.env.QBIT_PASSWORD);
  const username = process.env.QBIT_USERNAME || 'admin';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) throw Error('Invalid QBIT_USERNAME');
  const directory = path.join(configRoot, 'qbittorrent', 'qBittorrent', 'config');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'qBittorrent.conf');
  let config = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '[LegalNotice]\nAccepted=true\n[BitTorrent]\nSession\\DefaultSavePath=' + path.join(root, 'downloads') + '/\nSession\\Port=6881\n[Preferences]\nDownloads\\SavePath=' + path.join(root, 'downloads') + '/\nConnection\\PortRangeMin=6881\n';
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  // Qt treats unquoted semicolons as INI comments; keep the whole host list.
  for (const [key, value] of Object.entries({ 'WebUI\\Address': accessHost ? '0.0.0.0' : '127.0.0.1', 'WebUI\\Port': '8082', 'WebUI\\Username': username, 'WebUI\\Password_PBKDF2': `"@ByteArray(${salt.toString('base64')}:${hash.toString('base64')})"`, 'WebUI\\LocalHostAuth': 'true', 'WebUI\\AuthSubnetWhitelistEnabled': 'false', 'WebUI\\HostHeaderValidation': 'true', 'WebUI\\ServerDomains': '"127.0.0.1;localhost' + (accessHost ? ';' + accessHost : '') + '"' })) config = ini('Preferences', key, value, config);
  fs.writeFileSync(file, config, { mode: 0o600 }); fs.chmodSync(file, 0o600);
  return ['--profile=' + path.join(configRoot, 'qbittorrent'), '--webui-port=8082'];
}
function proxy(port, webPort, apiPort) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
      const ok = await health(); res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok })); return;
    }
    const target = req.url === '/api' || req.url.startsWith('/api/') ? apiPort : webPort;
    const upstream = http.request({ host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: { ...req.headers, host: req.headers.host || `127.0.0.1:${target}`, 'x-forwarded-host': req.headers.host || '', 'x-forwarded-proto': process.env.TRUST_PROXY === 'true' && /^(https|http)$/.test(req.headers['x-forwarded-proto'] || '') ? req.headers['x-forwarded-proto'] : req.socket.encrypted ? 'https' : 'http' } }, response => {
      res.writeHead(response.statusCode, { 'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'same-origin', ...response.headers }); response.pipe(res);
      response.on('error', () => res.destroy());
    });
    upstream.setTimeout(30000, () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Service is starting or unavailable' })); });
    req.on('aborted', () => upstream.destroy()); res.on('close', () => { if (!res.writableFinished) upstream.destroy(); }); req.pipe(upstream);
  });
  server.listen(port, '0.0.0.0'); gateways.push(server);
}
async function check(url) { try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); await response.body?.cancel(); return response.ok; } catch { return false; } }
async function health() {
  const endpoints = ['http://127.0.0.1:47821/api/health', 'http://127.0.0.1:3000/login', ...(phosphorEnabled ? ['http://127.0.0.1:61337/api/health', 'http://127.0.0.1:3100/login'] : [])];
  if (!(await Promise.all(endpoints.map(check))).every(Boolean)) return false;
  if (qbitEnabled) return new Promise(resolve => { const socket = net.connect(8082, '127.0.0.1'); socket.setTimeout(2000); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(false); }); });
  return true;
}
async function main() {
  fs.mkdirSync(path.join(root, 'downloads'), { recursive: true });
  const products = ['streamrd', ...(phosphorEnabled ? ['phosphor'] : [])];
  const environments = {};
  for (const product of products) {
    const directory = path.join(configRoot, product); fs.mkdirSync(directory, { recursive: true });
    environments[product] = { BUNDLED_QBIT_HOST: '', BUNDLED_QBIT_ACCESS_ACTIVE: 'false', NODE_ENV: 'production', PORT: product === 'streamrd' ? '47821' : '61337', DATABASE_URL: 'file:' + path.join(directory, product + '.db'), JWT_SECRET: secret(product + '-jwt', process.env[product.toUpperCase() + '_JWT_SECRET']), MEDIA_SOURCE_ROOT: process.env.MEDIA_SOURCE_ROOT || path.join(root, 'downloads'), MEDIA_LIBRARY_ROOT: path.join(directory, 'library'), ADMIN_EMAIL: process.env[product.toUpperCase() + '_ADMIN_EMAIL'] || process.env.ADMIN_EMAIL || '', CORS_ORIGINS: process.env.CORS_ORIGINS || '', DATA_ENCRYPTION_KEY: secret(product + '-data-key', process.env[product.toUpperCase() + '_DATA_KEY']), TMDB_DEFAULT_API_KEY: process.env.TMDB_DEFAULT_API_KEY || '' };
    await migrate('/opt/' + product + '/server', environments[product]);
  }
  let accessHost = '';
  if (qbitEnabled) {
    const policy = require('/opt/streamrd/server/dist/src/bundled-qbit.js');
    let peer = '';
    if (process.env.DOCKER_CONTROL_STATE === 'embedded' && process.env.MEDIA_MANAGER_URL && process.env.MEDIA_MANAGER_TOKEN) {
      try {
        const response = await fetch(process.env.MEDIA_MANAGER_URL + '/peer', { headers: { Authorization: `Bearer ${process.env.MEDIA_MANAGER_TOKEN}` }, signal: AbortSignal.timeout(3000), redirect: 'error' });
        const body = response.ok ? await response.json() : {};
        if (typeof body.host === 'string' && policy.validPeerHost(body.host)) peer = body.host;
      } catch { /* An unavailable helper leaves the client local. */ }
    }
    environments.streamrd.BUNDLED_QBIT_HOST = peer;
    const { PrismaClient } = require('/opt/streamrd/server/node_modules/@prisma/client');
    const client = new PrismaClient({ datasources: { db: { url: environments.streamrd.DATABASE_URL } } });
    try { accessHost = await policy.approvedBundledHost(client, peer); } finally { await client.$disconnect(); }
    environments.streamrd.BUNDLED_QBIT_ACCESS_ACTIVE = accessHost ? 'true' : 'false';
    launch('qbittorrent', 'qbittorrent-nox', prepareQbit(accessHost), configRoot);
  }
  for (const product of products) {
    launch(product + '-api', process.execPath, ['dist/src/index.js'], '/opt/' + product + '/server', environments[product]);
    launch(product + '-web', process.execPath, ['server.js'], '/opt/' + product + '/web', { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', PORT: product === 'streamrd' ? '3000' : '3100', HOSTNAME: '127.0.0.1' });
  }
  proxy(8080, 3000, 47821); if (phosphorEnabled) proxy(8081, 3100, 61337);
  console.log('StreamRD is available on :8080' + (phosphorEnabled ? '; Phosphor on :8081' : '') + '. Settings and generated credentials persist under ' + configRoot + (configRoot === root ? '' : '; downloads under ' + root) + '.');
}
process.on('SIGTERM', () => shutdown(0)); process.on('SIGINT', () => shutdown(0));
main().catch(error => { console.error(error.message); shutdown(1); });
