#!/usr/bin/env node
/**
 * StreamRD and Phosphor share a lot of source. The files listed in shared-manifest.json are edited in the
 * StreamRD copy (the first path of each pair) and copied byte for byte into Phosphor. CI runs --check, so
 * the two can never drift apart unnoticed.
 *
 *   node scripts/sync-shared.cjs            copy StreamRD's version of every listed file into Phosphor
 *   node scripts/sync-shared.cjs --check    exit 1 if any copy differs or is missing (used by CI)
 *   node scripts/sync-shared.cjs --add <path-in-the-StreamRD-tree> [...]   start sharing a file (also copies it)
 *   node scripts/sync-shared.cjs --remove <path-in-the-StreamRD-tree> [...] stop sharing a file (the Phosphor copy stays as an independent file)
 *   node scripts/sync-shared.cjs --candidates   list files that are already identical but not yet shared
 */
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "shared-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const mode = process.argv[2] ?? "";
const args = process.argv.slice(3).filter((arg) => !arg.startsWith("--"));
const EXT = /\.(ts|tsx|cjs|css)$/;
const same = (a, b) => fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
const save = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
function pairFor(file) {
  const normalized = file.replace(/\\/g, "/");
  const pair = manifest.pairs.find((candidate) => normalized.startsWith(candidate.from + "/"));
  return pair ? { pair, rel: normalized.slice(pair.from.length + 1) } : null;
}
function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next" ? [] : walk(full, base);
    return EXT.test(entry.name) ? [path.relative(base, full).replace(/\\/g, "/")] : [];
  });
}

if (mode === "--add" || mode === "--remove") {
  if (!args.length) { console.error(`Usage: sync-shared.cjs ${mode} <path> [...]`); process.exit(2); }
  for (const arg of args) {
    const found = pairFor(arg);
    if (!found) { console.error(`${arg} is not inside a shared tree (${manifest.pairs.map((p) => p.from).join(", ")}).`); process.exit(2); }
    const files = new Set(found.pair.files);
    if (mode === "--add") {
      const target = path.join(root, found.pair.to, found.rel);
      if (fs.existsSync(target) && !same(path.join(root, arg), target) && !process.argv.includes("--force")) {
        console.error(`${found.pair.to}/${found.rel} already exists and differs. Sharing it would overwrite it; reconcile the two first, or pass --force.`);
        process.exit(2);
      }
      files.add(found.rel);
    } else files.delete(found.rel);
    found.pair.files = [...files].sort();
  }
  save();
}
if (mode === "--candidates") {
  let count = 0;
  for (const pair of manifest.pairs) for (const rel of walk(path.join(root, pair.from))) {
    if (!pair.files.includes(rel) && same(path.join(root, pair.from, rel), path.join(root, pair.to, rel))) { console.log(`${pair.from}/${rel}`); count++; }
  }
  console.log(count ? `${count} identical file(s) could be shared: node scripts/sync-shared.cjs --add <path>` : "No unshared identical files.");
  process.exit(0);
}

const problems = [];
let copied = 0;
for (const pair of manifest.pairs) for (const rel of pair.files) {
  const from = path.join(root, pair.from, rel), to = path.join(root, pair.to, rel);
  if (!fs.existsSync(from)) { problems.push(`${pair.from}/${rel} is listed in shared-manifest.json but missing; remove it with --remove or restore it.`); continue; }
  if (same(from, to)) continue;
  if (mode === "--check") { problems.push(`${pair.to}/${rel} differs from ${pair.from}/${rel}`); continue; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to); copied++;
}
if (problems.length) {
  console.error(problems.join("\n"));
  console.error("\nShared files are edited in the StreamRD tree and copied to Phosphor: run `node scripts/sync-shared.cjs`.\nIf a file must differ between the products, stop sharing it: `node scripts/sync-shared.cjs --remove <path>`.");
  process.exit(1);
}
const total = manifest.pairs.reduce((sum, pair) => sum + pair.files.length, 0);
console.log(mode === "--check" ? `${total} shared files are identical in StreamRD and Phosphor.` : `${total} shared files in sync (${copied} updated).`);
