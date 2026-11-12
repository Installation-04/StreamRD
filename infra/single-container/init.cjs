'use strict';
// The first program in the StreamRD container.
//
// Started as the unprivileged user (the image's default), it runs StreamRD and nothing else: no process in the container is root.
//
// Started as root with Docker's socket mounted (what install.sh sets up unless declined), it keeps one small thing for itself, the
// helper that talks to Docker (media-manager.cjs --embedded), and runs StreamRD and everything StreamRD starts as the unprivileged
// user. That user cannot open the socket, read the helper's memory or stop it; it can only send the helper the few fixed requests the
// helper answers, with a secret made anew at every start and given to the two API processes alone.
//
// Nothing here listens on the network or reads anything a visitor sends.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const APP_UID = 1000, APP_GID = 1000, HELPER_PORT = Number(process.env.HELPER_PORT) || 8099;   // the port is only ever changed by tests
const off = value => ['0', 'false', 'off', 'no'].includes(String(value ?? '').trim().toLowerCase());

/**
 * What this start may do with Docker, and why not when it may not. `socket` is the owner and mode of Docker's socket, or null.
 * Kept free of side effects so it can be tested without a container.
 */
function decide({ env, uid, socket }) {
  if (env.MEDIA_MANAGER_URL && env.MEDIA_MANAGER_TOKEN) return { mode: 'external' };   // a helper in a container of its own was set up
  if (off(env.DOCKER_CONTROL)) return { mode: 'off', reason: 'disabled' };
  if (!socket) return { mode: 'off', reason: 'no-socket' };
  if (uid !== 0) return { mode: 'off', reason: 'not-root' };
  // The helper is kept apart from StreamRD by being another user. That holds only if StreamRD's user cannot open the socket itself.
  const shared = socket.uid === APP_UID || (socket.mode & 0o006) === 0o006 || (socket.gid === APP_GID && (socket.mode & 0o060) === 0o060);
  return { mode: 'embedded', shared };
}

function main() {
  const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock', data = process.env.DATA_DIR || '/data', settings = process.env.CONFIG_DIR || data;
  let socket = null;
  try { const stat = fs.statSync(socketPath); if (stat.isSocket()) socket = { uid: stat.uid, gid: stat.gid, mode: stat.mode }; } catch { /* not mounted */ }
  const uid = process.getuid(), decision = decide({ env: process.env, uid, socket });
  const state = decision.mode === 'off' ? decision.reason : decision.mode;
  const say = text => console.log(`[init] ${text}`);

  if (uid !== 0) {
    if (decision.reason === 'not-root') say('Docker\'s socket is mounted, but the container does not start as root, so the helper could not be kept apart from StreamRD. Starting Plex and Jellyfin, updating and restarting from the web pages stay off. Start the container with user "0:0" to turn them on.');
    process.env.DOCKER_CONTROL_STATE = state;
    require('./start.cjs');
    return;
  }

  // A folder Docker made for a new bind mount belongs to root and is empty; StreamRD could not write to it.
  for (const directory of new Set([settings, data])) {
    try { if (fs.statSync(directory).uid === 0 && fs.readdirSync(directory).length === 0) fs.chownSync(directory, APP_UID, APP_GID); } catch { /* StreamRD says so itself if it cannot write */ }
  }

  const env = { ...process.env, HOME: '/home/node', USER: 'node', LOGNAME: 'node', DOCKER_CONTROL_STATE: state };
  let helper = null, stopping = false, wait = 2000;
  if (decision.mode === 'embedded') {
    const token = crypto.randomBytes(32).toString('hex');
    env.MEDIA_MANAGER_URL = `http://127.0.0.1:${HELPER_PORT}`; env.MEDIA_MANAGER_TOKEN = token;
    if (decision.shared) {
      env.DOCKER_CONTROL_SHARED = '1';
      say('Warning: on this machine Docker\'s socket can be opened by user 1000, the user StreamRD runs as, so the helper is not kept apart from it. Everything works; see "Docker control" in docs/plex-jellyfin.md.');
    }
    const startHelper = () => {
      helper = spawn(process.execPath, [path.join(__dirname, 'media-manager.cjs'), '--embedded'], {
        cwd: '/', stdio: ['ignore', 'inherit', 'inherit'],
        // Only what the helper needs: none of StreamRD's own secrets.
        env: { PATH: process.env.PATH || '', NODE_ENV: 'production', TZ: process.env.TZ || 'UTC', DOCKER_SOCKET: socketPath, MEDIA_MANAGER_TOKEN: token, PORT: String(HELPER_PORT), DATA_DIR: data, CONFIG_DIR: settings, APP_UID: String(APP_UID), APP_GID: String(APP_GID), STREAMRD_CONTAINER: process.env.STREAMRD_CONTAINER || '' },
      });
      const started = Date.now();
      helper.once('error', () => undefined);
      helper.once('exit', (code, signal) => {
        if (stopping) return;
        wait = Date.now() - started > 60000 ? 2000 : Math.min(wait * 2, 60000);   // StreamRD keeps running without it; try again, less often if it keeps failing
        say(`The Docker helper stopped (${code ?? signal}); starting it again in ${Math.round(wait / 1000)} s.`);
        setTimeout(() => { if (!stopping) startHelper(); }, wait).unref();
      });
    };
    startHelper();
    say('Docker control is on: the helper runs as root, StreamRD as user 1000.');
  }

  const app = spawn(process.execPath, [path.join(__dirname, 'start.cjs')], { uid: APP_UID, gid: APP_GID, env, stdio: 'inherit' });
  const finish = code => { stopping = true; if (helper && helper.exitCode === null) helper.kill('SIGTERM'); process.exit(code); };
  app.once('error', error => {
    console.error(error.code === 'EPERM'
      ? '[init] The container starts as root but may not change user (the SETUID and SETGID capabilities were taken away). Give them back, or start the container as user "1000:1000".'
      : `[init] StreamRD could not start: ${error.message}`);
    finish(1);
  });
  app.once('exit', (code, signal) => finish(code ?? (signal ? 1 : 0)));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { try { app.kill(signal); } catch { /* it has already gone */ } });
}

module.exports = { decide };
if (require.main === module) main();
