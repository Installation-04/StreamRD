'use strict';
// The service supervisor: runs programs inside the StreamRD container as ordinary processes (no Docker socket needed),
// in the order their dependencies need, with health waits, restarts and logs that never show a secret.
// It knows nothing about any one program: a service is described by a plain object (see register()).
const { spawn: realSpawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');

const STATES = ['stopped', 'starting', 'running', 'failed', 'stopping'];
const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createSupervisor(options = {}) {
  const spawn = options.spawn || realSpawn;
  const logLimit = options.logLimit || 500;
  const graceMs = options.graceMs ?? 10_000;           // how long a stopping program gets before it is killed
  const readyMs = options.readyMs ?? 60_000;           // how long to wait for a program to say it is up
  const readyEveryMs = options.readyEveryMs ?? 250;
  const settleMs = options.settleMs ?? 400;             // a program with no way to ask it counts as up once it has stayed up this long
  const services = new Map();                           // name -> definition
  const live = new Map();                               // name -> runtime record

  function redactor(secrets) {
    const list = [...new Set(secrets.filter(value => typeof value === 'string' && value.length >= 6))].sort((a, b) => b.length - a.length);
    return text => { let out = String(text); for (const secret of list) out = out.split(secret).join('[hidden]'); return out; };
  }
  function check(definition) {
    if (!definition || typeof definition !== 'object') throw Object.assign(new Error('A service needs a definition'), { status: 400 });
    if (!NAME.test(definition.name || '')) throw Object.assign(new Error('A service name is lower-case letters, digits and dashes'), { status: 400 });
    if (typeof definition.command !== 'string' || !definition.command) throw Object.assign(new Error(`${definition.name} has no command`), { status: 400 });
    if (definition.args !== undefined && !(Array.isArray(definition.args) && definition.args.every(arg => typeof arg === 'string'))) throw Object.assign(new Error(`${definition.name}: args must be a list of text`), { status: 400 });
    if (definition.dependsOn !== undefined && !(Array.isArray(definition.dependsOn) && definition.dependsOn.every(dep => NAME.test(dep)))) throw Object.assign(new Error(`${definition.name}: dependsOn must be a list of service names`), { status: 400 });
  }
  function register(definition) {
    check(definition);
    if (live.get(definition.name) && !['stopped', 'failed'].includes(live.get(definition.name).state)) throw Object.assign(new Error(`${definition.name} is running; stop it before changing it`), { status: 409 });
    services.set(definition.name, { restart: 'on-failure', maxRestarts: 5, backoffMs: 1000, ...definition, args: definition.args || [], dependsOn: definition.dependsOn || [], secrets: definition.secrets || [] });
    if (!live.has(definition.name)) live.set(definition.name, { state: 'stopped', logs: [], restarts: 0, since: Date.now(), child: null, wanted: false });
  }
  function record(name) { const found = live.get(name); if (!found) throw Object.assign(new Error(`Unknown service ${name}`), { status: 404 }); return found; }

  /** The services to start for `names`, dependencies first. A cycle or a missing dependency is refused before anything starts. */
  function order(names) {
    const out = [], mark = new Map();
    const visit = (name, trail) => {
      if (!services.has(name)) throw Object.assign(new Error(`${trail[trail.length - 1] || name} needs ${name}, which is not set up`), { status: 409 });
      if (mark.get(name) === 'done') return;
      if (mark.get(name) === 'busy') throw Object.assign(new Error(`These services wait on each other: ${[...trail, name].join(' → ')}`), { status: 409 });
      mark.set(name, 'busy');
      for (const dep of services.get(name).dependsOn) visit(dep, [...trail, name]);
      mark.set(name, 'done'); out.push(name);
    };
    for (const name of names) visit(name, []);
    return out;
  }
  const dependentsOf = name => [...services.values()].filter(other => other.dependsOn.includes(name)).map(other => other.name);

  function log(name, line, stream = 'out') {
    const entry = record(name), redact = redactor([...(services.get(name).secrets || [])]);
    entry.logs.push({ time: new Date().toISOString(), stream, text: redact(line).slice(0, 600) });
    if (entry.logs.length > logLimit) entry.logs.splice(0, entry.logs.length - logLimit);
  }
  function note(name, text) { log(name, `[supervisor] ${text}`, 'note'); }

  function ready(definition) {
    const probe = definition.ready;
    if (!probe) return Promise.resolve(true);
    if (probe.url) return new Promise(resolve => { const request = http.get(probe.url, { timeout: 1500 }, response => { response.resume(); resolve(response.statusCode < 500); }); request.on('timeout', () => { request.destroy(); resolve(false); }); request.on('error', () => resolve(false)); });
    if (probe.port) return new Promise(resolve => { const socket = net.connect({ host: probe.host || '127.0.0.1', port: probe.port, timeout: 1500 }); socket.on('connect', () => { socket.destroy(); resolve(true); }); socket.on('timeout', () => { socket.destroy(); resolve(false); }); socket.on('error', () => resolve(false)); });
    return Promise.resolve(true);
  }

  function begin(name) {
    const definition = services.get(name), entry = record(name);
    entry.state = 'starting'; entry.since = Date.now(); entry.error = undefined; entry.wanted = true;
    note(name, `starting ${definition.command}`);
    let child;
    try { child = spawn(definition.command, definition.args, { cwd: definition.cwd, env: { ...process.env, ...(definition.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { entry.state = 'failed'; entry.error = redactor(definition.secrets)(error.message); note(name, `could not start: ${entry.error}`); return null; }
    entry.child = child;
    for (const [stream, label] of [[child.stdout, 'out'], [child.stderr, 'err']]) {
      if (!stream) continue; let pending = '';
      stream.on('data', chunk => { pending += chunk.toString(); const lines = pending.split('\n'); pending = lines.pop(); for (const line of lines) if (line.trim()) log(name, line, label); });
      stream.on('end', () => { if (pending.trim()) log(name, pending, label); });
    }
    // A program that cannot be started at all reports an error and never an exit, so both lead to the same place.
    child.once('error', error => { entry.error = redactor(definition.secrets)(error.message); if (child.pid === undefined) ended('could not start'); });
    child.once('exit', (code, signal) => ended(code ?? signal));
    function ended(code, signal) {
      if (entry.child !== child) return; entry.child = null;
      if (entry.state === 'stopping') { entry.state = 'stopped'; entry.since = Date.now(); note(name, 'stopped'); return; }
      note(name, `exited (${code ?? signal})`);
      const again = definition.restart === 'on-failure' && entry.wanted && entry.restarts < definition.maxRestarts;
      if (!again) { entry.state = 'failed'; entry.error = entry.error || `exited (${code ?? signal})`; entry.since = Date.now(); return; }
      entry.restarts += 1; entry.state = 'starting';
      const wait = Math.min(definition.backoffMs * 2 ** (entry.restarts - 1), 30_000);
      note(name, `restarting in ${Math.round(wait / 1000)}s (${entry.restarts} of ${definition.maxRestarts})`);
      setTimeout(() => { if (entry.wanted && entry.state === 'starting') begin(name); }, wait).unref?.();
    }
    return child;
  }

  async function waitReady(name) {
    const definition = services.get(name), entry = record(name), deadline = Date.now() + readyMs, began = Date.now();
    while (Date.now() < deadline) {
      if (entry.state === 'failed') throw Object.assign(new Error(`${definition.label || name} stopped while starting: ${entry.error || 'no reason given'}`), { status: 502 });
      if (entry.child && (definition.ready ? await ready(definition) : Date.now() - began >= settleMs)) { entry.state = 'running'; entry.since = Date.now(); entry.restarts = 0; note(name, 'running'); return; }
      await sleep(readyEveryMs);
    }
    throw Object.assign(new Error(`${definition.label || name} did not become ready in ${Math.round(readyMs / 1000)}s`), { status: 504 });
  }

  /** Starts a service and, first, everything it depends on. */
  async function start(name) {
    for (const each of order([name])) {
      const entry = record(each);
      if (entry.state === 'running') continue;
      if (entry.state === 'starting' && entry.child) { await waitReady(each); continue; }
      entry.restarts = 0; begin(each);
      if (entry.state === 'failed') throw Object.assign(new Error(`${services.get(each).label || each} could not start: ${entry.error}`), { status: 502 });
      await waitReady(each);
    }
  }
  async function terminate(name) {
    const entry = record(name);
    entry.wanted = false;
    if (!entry.child) { if (entry.state !== 'stopped') { entry.state = 'stopped'; entry.since = Date.now(); } return; }
    const child = entry.child; entry.state = 'stopping'; note(name, 'stopping');
    await new Promise(resolve => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, graceMs);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    });
    entry.child = null; entry.state = 'stopped'; entry.since = Date.now();
  }
  /** Stops a service, after everything that depends on it. */
  async function stop(name) {
    record(name);
    const down = new Set(), walk = each => { for (const dependent of dependentsOf(each)) if (!down.has(dependent)) { down.add(dependent); walk(dependent); } };
    walk(name);
    for (const each of order([...services.keys()]).filter(other => down.has(other)).reverse()) await terminate(each);   // what depends on it goes first, the last to start is the first to stop
    await terminate(name);
  }
  async function restart(name) { await stop(name); await start(name); }
  async function stopAll() {
    let names; try { names = order([...services.keys()]).reverse(); } catch { names = [...services.keys()]; }   // a broken graph must never stop the container from shutting down
    for (const name of names) await terminate(name);
  }

  const view = name => { const definition = services.get(name), entry = record(name); return { name, label: definition.label || name, state: entry.state, since: new Date(entry.since).toISOString(), restarts: entry.restarts, dependsOn: definition.dependsOn, ...(entry.error ? { error: entry.error } : {}) }; };
  const status = () => Object.fromEntries([...services.keys()].map(name => [name, view(name)]));
  const logs = (name, tail = 200) => { record(name); return live.get(name).logs.slice(-Math.max(1, Math.min(tail, logLimit))); };

  return { register, order, start, stop, restart, stopAll, status, logs, STATES };
}

module.exports = { createSupervisor };
