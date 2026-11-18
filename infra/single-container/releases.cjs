'use strict';
// Installs a program from a GitHub release into a folder: finds the right download for this machine, downloads it with a size limit,
// checks it against the checksum GitHub publishes for it, unpacks it without letting it write outside its folder, and puts it in place in
// one step so a failed install never leaves half a program behind. It does not run anything it downloads.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');

const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,79}$/;
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const ARCH = { x64: 'amd64', x86_64: 'amd64', amd64: 'amd64', arm64: 'arm64', aarch64: 'arm64' };

/** The downloads GitHub allows: its own hosts, over HTTPS. A redirect to anywhere else is refused. */
function allowedHost(url) {
  let parsed; try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  return parsed.protocol === 'https:' && (host === 'github.com' || host === 'api.github.com' || host.endsWith('.githubusercontent.com'));
}

/** The one download for this machine among a release's assets. Several that fit is an error, not a guess. */
function chooseAsset(assets, { arch = os.arch(), platform = 'linux' } = {}) {
  const want = ARCH[String(arch).toLowerCase()];
  if (!want) throw fail(`This machine's processor (${arch}) is not one the release downloads are made for`, 409);
  const other = want === 'amd64' ? ['arm64', 'aarch64', 'arm', 'armv7', '386', 'i386'] : ['amd64', 'x86_64', 'x64', 'arm', 'armv7', '386', 'i386'];
  const words = name => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const sums = /(sha256|sha512|sha1|checksums?|\.sig$|\.asc$|\.pem$|\.sbom|\.txt$|\.json$|\.md$|\.deb$|\.rpm$|\.apk$|\.msi$|\.exe$|\.dmg$|\.pkg$)/i;
  const fits = (assets || []).filter(asset => {
    const name = String(asset.name || ''), list = words(name);
    if (sums.test(name) || /^source/i.test(name)) return false;
    if (!list.includes(platform)) return false;
    const names = want === 'amd64' ? ['amd64', 'x86', '64', 'x64'] : ['arm64', 'aarch64'];
    return list.some(word => names.includes(word)) && !list.some(word => other.includes(word) && !names.includes(word));
  });
  const archive = fits.filter(asset => /\.(zip|tar\.gz|tgz)$/i.test(asset.name));
  const pool = archive.length ? archive : fits;
  if (pool.length === 1) return pool[0];
  if (!pool.length) throw fail(`The release has no download for ${platform} ${want} (it offers: ${(assets || []).map(a => a.name).slice(0, 12).join(', ') || 'nothing'})`, 409);
  throw fail(`More than one download fits ${platform} ${want} (${pool.map(a => a.name).join(', ')}); not guessing`, 409);
}

/** The sha-256 GitHub publishes for an asset ("sha256:<hex>"), or null when it publishes none. */
function digestOf(asset) {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(String(asset && asset.digest || ''));
  return match ? match[1].toLowerCase() : null;
}

// ---- zip: read in memory-light pieces, refuse anything that could write outside the folder or fill the disk.
function listZip(buffer, limits) {
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65_557); at--) if (buffer.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  if (end < 0) throw fail('The download is not a zip file', 422);
  const count = buffer.readUInt16LE(end + 10), start = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || start === 0xffffffff) throw fail('Zip files this large are not supported', 422);
  if (count > limits.files) throw fail(`The zip holds more than ${limits.files} files`, 422);
  const entries = []; let at = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) throw fail('The zip file is damaged', 422);
    const flags = buffer.readUInt16LE(at + 8), method = buffer.readUInt16LE(at + 10), crc = buffer.readUInt32LE(at + 16), packed = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28), extraLength = buffer.readUInt16LE(at + 30), commentLength = buffer.readUInt16LE(at + 32), attributes = buffer.readUInt32LE(at + 38), local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw fail('The zip file is encrypted', 422);
    if (packed === 0xffffffff || size === 0xffffffff) throw fail('Zip files this large are not supported', 422);
    total += size; if (total > limits.bytes) throw fail('The zip would unpack to more than the allowed size', 422);
    entries.push({ name, method, crc, packed, size, local, mode: (attributes >>> 16) & 0xffff, directory: name.endsWith('/') });
  }
  return entries;
}
/** Where an archive entry lands inside `root`, or null for one that must be ignored. Anything that would leave the folder is an error. */
function safeTarget(root, name) {
  const clean = name.replace(/\\/g, '/');
  if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.split('/').includes('..') || clean.includes('\0')) throw fail(`The archive has an unsafe path (${name.slice(0, 80)})`, 422);
  const target = path.join(root, clean);
  if (target !== root && !target.startsWith(root + path.sep)) throw fail(`The archive has an unsafe path (${name.slice(0, 80)})`, 422);
  return target;
}
function unzip(file, root, limits) {
  const buffer = fs.readFileSync(file), written = [];
  for (const entry of listZip(buffer, limits)) {
    const isLink = (entry.mode & 0o170000) === 0o120000;
    if (isLink) throw fail(`The archive has a link (${entry.name.slice(0, 80)}); refusing it`, 422);
    const target = safeTarget(root, entry.name);
    if (entry.directory) { fs.mkdirSync(target, { recursive: true }); continue; }
    if (buffer.readUInt32LE(entry.local) !== 0x04034b50) throw fail('The zip file is damaged', 422);
    const from = entry.local + 30 + buffer.readUInt16LE(entry.local + 26) + buffer.readUInt16LE(entry.local + 28);
    const packed = buffer.subarray(from, from + entry.packed);
    const data = entry.method === 0 ? packed : entry.method === 8 ? zlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.size) }) : null;
    if (!data) throw fail(`The zip uses a compression method that is not supported (${entry.method})`, 422);
    if (data.length !== entry.size || zlib.crc32(data) !== entry.crc) throw fail(`The zip file is damaged (${entry.name.slice(0, 80)})`, 422);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data, { mode: (entry.mode & 0o111) ? 0o755 : 0o644 }); written.push(target);
  }
  return written;
}
function untar(file, root, limits) {
  return new Promise((resolve, reject) => {
    const list = spawn('tar', ['-tzvf', file], { stdio: ['ignore', 'pipe', 'pipe'] }); let text = '';
    list.stdout.on('data', chunk => { text += chunk; if (text.length > 4_000_000) list.kill('SIGKILL'); });
    list.once('error', () => reject(fail('tar is not available to unpack the download', 500)));
    list.once('exit', code => {
      if (code !== 0) return reject(fail('The download is not a readable archive', 422));
      const lines = text.split('\n').filter(Boolean);
      if (lines.length > limits.files) return reject(fail(`The archive holds more than ${limits.files} files`, 422));
      let total = 0;
      for (const line of lines) {
        const kind = line[0]; if (kind === 'l' || kind === 'h') return reject(fail('The archive has a link; refusing it', 422));
        const match = /^\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.*)$/.exec(line); if (!match) return reject(fail('The archive listing could not be read', 422));
        total += Number(match[1]);
        try { safeTarget(root, match[2]); } catch (error) { return reject(error); }
      }
      if (total > limits.bytes) return reject(fail('The archive would unpack to more than the allowed size', 422));
      const run = spawn('tar', ['-xzf', file, '-C', root, '--no-same-owner', '--no-same-permissions'], { stdio: 'ignore' });
      run.once('error', () => reject(fail('tar is not available to unpack the download', 500)));
      run.once('exit', done => done === 0 ? resolve() : reject(fail('The archive could not be unpacked', 422)));
    });
  });
}

function createReleases(options = {}) {
  const request = options.fetch || fetch;
  const token = options.token || '';
  const maxBytes = options.maxBytes ?? 300 * 1024 * 1024;
  const limits = { files: options.maxFiles ?? 5000, bytes: options.maxUnpacked ?? 1024 * 1024 * 1024 };
  const get = async (url, headers = {}) => {
    if (!allowedHost(url)) throw fail('Only GitHub downloads are allowed', 400);
    let response;
    try { response = await request(url, { redirect: 'follow', headers: { 'User-Agent': 'streamrd-installer', ...(token && /^https:\/\/api\.github\.com\//.test(url) ? { Authorization: `Bearer ${token}` } : {}), ...headers }, signal: AbortSignal.timeout(options.timeoutMs ?? 120_000) }); }
    catch { throw fail('GitHub could not be reached', 502); }
    if (response.url && !allowedHost(response.url)) throw fail('GitHub sent the download somewhere else; refusing it', 502);
    if (response.status === 404) throw fail('That release was not found on GitHub', 404);
    if (response.status === 403 || response.status === 429) throw fail('GitHub is limiting requests right now; try again in a few minutes', 503);
    if (!response.ok) throw fail(`GitHub answered ${response.status}`, 502);
    return response;
  };
  /** A release's details: the newest, or a named tag. */
  async function release(repo, tag) {
    if (!REPO.test(repo)) throw fail('That is not a GitHub repository name', 400);
    if (tag !== undefined && tag !== 'latest' && !TAG.test(tag)) throw fail('That is not a release name', 400);
    const url = tag && tag !== 'latest' ? `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}` : `https://api.github.com/repos/${repo}/releases/latest`;
    const info = await (await get(url, { Accept: 'application/vnd.github+json' })).json();
    if (!info || !Array.isArray(info.assets)) throw fail('GitHub sent a release that could not be read', 502);
    return info;
  }
  async function download(asset, file) {
    const url = asset.browser_download_url;
    if (!url) throw fail('The release download has no address', 502);
    const response = await get(url, { Accept: 'application/octet-stream' });
    const announced = Number(response.headers.get('content-length')); if (announced > maxBytes) throw fail('The download is larger than allowed', 413);
    const hash = crypto.createHash('sha256'); let bytes = 0;
    const counted = Readable.fromWeb(response.body).on('data', chunk => { bytes += chunk.length; hash.update(chunk); if (bytes > maxBytes) counted.destroy(fail('The download is larger than allowed', 413)); });
    await pipeline(counted, fs.createWriteStream(file, { mode: 0o600 }));
    return { bytes, sha256: hash.digest('hex') };
  }
  /**
   * Installs `repo` into `dir`. `binary` is the file name the program ends up as (found anywhere in the archive). Returns what was installed.
   * Nothing in `dir` changes unless everything worked; the previous install is kept until the new one is in place.
   */
  async function install({ repo, tag, dir, binary, arch, onStep = () => {} }) {
    if (!path.isAbsolute(dir) || dir.includes('..')) throw fail('The install folder must be an absolute path', 400);
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(binary || '')) throw fail('That is not a program file name', 400);
    onStep('Looking up the release'); const info = await release(repo, tag);
    const asset = chooseAsset(info.assets, { arch: arch || os.arch() });
    const parent = path.dirname(dir); fs.mkdirSync(parent, { recursive: true });
    const work = fs.mkdtempSync(path.join(parent, `.${path.basename(dir)}-install-`)), archive = path.join(work, 'download'), out = path.join(work, 'unpacked'), previous = `${dir}.previous`;
    try {
      fs.mkdirSync(out);
      onStep(`Downloading ${asset.name}`); const got = await download(asset, archive);
      const expected = digestOf(asset);
      if (expected && expected !== got.sha256) throw fail('The download does not match the checksum GitHub published for it; it was discarded', 422);
      onStep('Unpacking');
      if (/\.zip$/i.test(asset.name)) unzip(archive, out, limits); else if (/\.(tar\.gz|tgz)$/i.test(asset.name)) await untar(archive, out, limits);
      else fs.copyFileSync(archive, path.join(out, binary));
      const found = findFile(out, binary);
      if (!found) throw fail(`The download does not contain ${binary}`, 422);
      if (found.isSymbolicLink) throw fail('The program file is a link; refusing it', 422);
      fs.chmodSync(found.path, 0o755);
      // The unpacked files go into place together: the old folder is moved aside, the new one moved in, and the old one is only removed afterwards.
      const root = path.dirname(found.path);
      fs.rmSync(previous, { recursive: true, force: true });
      if (fs.existsSync(dir)) fs.renameSync(dir, previous);
      try { fs.renameSync(root, dir); }
      catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, dir); throw fail(`The program could not be put in place: ${error.message}`, 500); }
      fs.rmSync(previous, { recursive: true, force: true });
      return { tag: info.tag_name, asset: asset.name, bytes: got.bytes, sha256: got.sha256, verified: Boolean(expected), path: path.join(dir, binary) };
    } finally { fs.rmSync(work, { recursive: true, force: true }); }
  }
  return { release, install, chooseAsset };
}
function findFile(root, name) {
  const queue = [root];
  while (queue.length) {
    const here = queue.shift();
    for (const entry of fs.readdirSync(here, { withFileTypes: true })) {
      const full = path.join(here, entry.name);
      if (entry.isDirectory()) queue.push(full); else if (entry.name === name) return { path: full, isSymbolicLink: entry.isSymbolicLink() };
    }
  }
  return null;
}

module.exports = { createReleases, chooseAsset, digestOf, allowedHost, safeTarget };
