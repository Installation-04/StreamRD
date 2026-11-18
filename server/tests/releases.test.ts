import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";

// The release downloader (infra/single-container/releases.cjs), run against a stand-in for GitHub and archives made here.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
const { createReleases, chooseAsset, allowedHost } = require("../../infra/single-container/releases.cjs") as any;

const sha = (buffer: Buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
/** A zip file with the given entries; `mode` is the unix permission/type word, `raw` writes the name as given. */
function zip(entries: Array<{ name: string; data?: Buffer; mode?: number; store?: boolean; crc?: number }>): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0), packed = entry.store === false ? zlib.deflateRawSync(data) : data, name = Buffer.from(entry.name), crc = entry.crc ?? zlib.crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.store === false ? 8 : 0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(entry.store === false ? 8 : 0, 10); header.writeUInt32LE(crc, 16); header.writeUInt32LE(packed.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((entry.mode ?? (entry.name.endsWith("/") ? 0o40755 : 0o100644)) << 16) >>> 0, 38); header.writeUInt32LE(offset, 42);
    parts.push(local, name, packed); central.push(header, name); offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
interface Served { assets: Array<{ name: string; body: Buffer; digest?: string | null }>; tag?: string; redirectTo?: string; calls: string[] }
function github(served: Served) {
  const base = "https://github.com/o/r/releases/download/v1/";
  return async (url: string) => {
    served.calls.push(url);
    const reply = (body: ConstructorParameters<typeof Response>[0], init: ResponseInit & { finalUrl?: string } = {}) => { const response = new Response(body, init); Object.defineProperty(response, "url", { value: init.finalUrl ?? url }); return response; };
    if (url.startsWith("https://api.github.com/repos/o/r/releases/")) return reply(JSON.stringify({ tag_name: served.tag ?? "v1", assets: served.assets.map(a => ({ name: a.name, browser_download_url: base + a.name, ...(a.digest === null ? {} : { digest: a.digest ?? `sha256:${sha(a.body)}` }) })) }), { headers: { "Content-Type": "application/json" } });
    const asset = served.assets.find(a => url === base + a.name);
    if (!asset) return reply("nope", { status: 404 });
    return reply(new Uint8Array(asset.body), { headers: { "Content-Length": String(asset.body.length) }, finalUrl: served.redirectTo });
  };
}
let folders: string[] = [];
const folder = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streamrd-releases-")); folders.push(dir); return dir; };
afterEach(() => { for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const program = Buffer.from("#!/bin/sh\necho hello\n");
const good = () => zip([{ name: "zurg-v1/", mode: 0o40755 }, { name: "zurg-v1/zurg", data: program, mode: 0o100755, store: false }, { name: "zurg-v1/config.yml", data: Buffer.from("x: 1\n"), store: false }]);

it("picks the one download for this machine, and refuses to guess between several", () => {
  const names = (list: string[]) => list.map(name => ({ name }));
  expect(chooseAsset(names(["zurg-v0.9.3-final-linux-amd64.zip", "zurg-v0.9.3-final-linux-arm64.zip", "zurg-v0.9.3-final-darwin-amd64.zip", "zurg-v0.9.3-final-windows-amd64.zip", "checksums.txt"]), { arch: "x64" }).name).toBe("zurg-v0.9.3-final-linux-amd64.zip");
  expect(chooseAsset(names(["zurg-v0.9.3-final-linux-amd64.zip", "zurg-v0.9.3-final-linux-arm64.zip"]), { arch: "arm64" }).name).toBe("zurg-v0.9.3-final-linux-arm64.zip");
  expect(chooseAsset(names(["rclone-v1.68.0-linux-amd64.zip", "rclone-v1.68.0-linux-arm-v7.zip", "rclone-v1.68.0-linux-386.zip", "rclone-v1.68.0-linux-amd64.deb", "SHA256SUMS", "rclone-v1.68.0-linux-arm64.zip"]), { arch: "x64" }).name).toBe("rclone-v1.68.0-linux-amd64.zip");
  expect(chooseAsset(names(["tool_1.0_Linux_x86_64.tar.gz", "tool_1.0_Linux_arm64.tar.gz", "tool_1.0_Linux_x86_64.sbom.json"]), { arch: "x64" }).name).toBe("tool_1.0_Linux_x86_64.tar.gz");
  expect(() => chooseAsset(names(["a-linux-amd64.zip", "b-linux-amd64.zip"]), { arch: "x64" })).toThrow(/More than one download fits/);
  expect(() => chooseAsset(names(["tool-windows-amd64.zip"]), { arch: "x64" })).toThrow(/no download for linux amd64/);
  expect(() => chooseAsset(names(["x-linux-amd64.zip"]), { arch: "riscv64" })).toThrow(/not one the release downloads are made for/);
});

it("installs a program from a release: checks the checksum GitHub published, unpacks it, makes it runnable, and reports what it did", async () => {
  const served: Served = { assets: [{ name: "zurg-v1-linux-amd64.zip", body: good() }, { name: "zurg-v1-linux-arm64.zip", body: Buffer.from("other") }], calls: [] };
  const dir = path.join(folder(), "zurg"), steps: string[] = [];
  const result = await createReleases({ fetch: github(served) }).install({ repo: "o/r", dir, binary: "zurg", arch: "x64", onStep: (text: string) => steps.push(text) });
  expect(result).toMatchObject({ tag: "v1", asset: "zurg-v1-linux-amd64.zip", verified: true, path: path.join(dir, "zurg") });
  expect(fs.readFileSync(path.join(dir, "zurg"))).toEqual(program); expect(fs.statSync(path.join(dir, "zurg")).mode & 0o111).toBeTruthy();
  expect(fs.readFileSync(path.join(dir, "config.yml"), "utf8")).toBe("x: 1\n");   // the rest of the folder comes with it
  expect(steps).toEqual(["Looking up the release", "Downloading zurg-v1-linux-amd64.zip", "Unpacking"]);
  expect(fs.readdirSync(path.dirname(dir))).toEqual(["zurg"]);   // no scratch folders left behind
  expect(served.calls[0]).toBe("https://api.github.com/repos/o/r/releases/latest");
});

it("says so when GitHub published no checksum, and refuses a download that does not match the one it did publish, keeping what was installed", async () => {
  const dir = path.join(folder(), "zurg");
  const plain = await createReleases({ fetch: github({ assets: [{ name: "zurg-linux-amd64.zip", body: good(), digest: null }], calls: [] }) }).install({ repo: "o/r", tag: "v1", dir, binary: "zurg", arch: "x64" });
  expect(plain.verified).toBe(false);
  fs.writeFileSync(path.join(dir, "mine.txt"), "kept");
  const tampered = { assets: [{ name: "zurg-linux-amd64.zip", body: good(), digest: `sha256:${"0".repeat(64)}` }], calls: [] };
  await expect(createReleases({ fetch: github(tampered) }).install({ repo: "o/r", dir, binary: "zurg", arch: "x64" })).rejects.toThrow(/does not match the checksum/);
  expect(fs.readFileSync(path.join(dir, "mine.txt"), "utf8")).toBe("kept"); expect(fs.readdirSync(path.dirname(dir))).toEqual(["zurg"]);
});

it("replaces an earlier install in one step, and puts it back when the new one cannot be used", async () => {
  const dir = path.join(folder(), "zurg"); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "zurg"), "old program"); fs.writeFileSync(path.join(dir, "old-only.txt"), "x");
  await createReleases({ fetch: github({ assets: [{ name: "zurg-linux-amd64.zip", body: good() }], calls: [] }) }).install({ repo: "o/r", dir, binary: "zurg", arch: "x64" });
  expect(fs.readFileSync(path.join(dir, "zurg"))).toEqual(program); expect(fs.existsSync(path.join(dir, "old-only.txt"))).toBe(false); expect(fs.existsSync(`${dir}.previous`)).toBe(false);
  const without = zip([{ name: "readme.txt", data: Buffer.from("hi"), store: false }]);
  await expect(createReleases({ fetch: github({ assets: [{ name: "zurg-linux-amd64.zip", body: without }], calls: [] }) }).install({ repo: "o/r", dir, binary: "zurg", arch: "x64" })).rejects.toThrow(/does not contain zurg/);
  expect(fs.readFileSync(path.join(dir, "zurg"))).toEqual(program);   // the working install is untouched
});

it("refuses archives that try to write outside the folder, hold links, are damaged, or are too big", async () => {
  const bad = async (body: Buffer, limits: Record<string, unknown> = {}) => createReleases({ ...limits, fetch: github({ assets: [{ name: "x-linux-amd64.zip", body }], calls: [] }) }).install({ repo: "o/r", dir: path.join(folder(), "x"), binary: "zurg", arch: "x64" });
  const file = { data: program, store: false };
  await expect(bad(zip([{ name: "../evil", ...file }, { name: "zurg", ...file }]))).rejects.toThrow(/unsafe path/);
  await expect(bad(zip([{ name: "/etc/evil", ...file }]))).rejects.toThrow(/unsafe path/);
  await expect(bad(zip([{ name: "a/../../evil", ...file }]))).rejects.toThrow(/unsafe path/);
  await expect(bad(zip([{ name: "zurg", data: Buffer.from("/etc/passwd"), mode: 0o120777 }]))).rejects.toThrow(/has a link/);
  await expect(bad(zip([{ name: "zurg", ...file, crc: 12345 }]))).rejects.toThrow(/damaged/);
  await expect(bad(Buffer.from("this is not a zip file at all"))).rejects.toThrow(/not a zip file/);
  await expect(bad(zip([{ name: "zurg", ...file }]), { maxBytes: 5 })).rejects.toThrow(/larger than allowed/);
  await expect(bad(zip([{ name: "zurg", ...file }]), { maxUnpacked: 5 })).rejects.toThrow(/more than the allowed size/);
  await expect(bad(zip([{ name: "a", ...file }, { name: "zurg", ...file }]), { maxFiles: 1 })).rejects.toThrow(/more than 1 files/);
  expect(fs.existsSync("/etc/evil")).toBe(false);
});

it("unpacks a .tar.gz the same careful way", async () => {
  const work = folder(), made = path.join(work, "made"); fs.mkdirSync(path.join(made, "tool-1"), { recursive: true }); fs.writeFileSync(path.join(made, "tool-1", "tool"), program); fs.chmodSync(path.join(made, "tool-1", "tool"), 0o755);
  const archive = path.join(work, "tool.tar.gz"); execFileSync("tar", ["-czf", archive, "-C", made, "tool-1"]);
  const dir = path.join(work, "installed");
  await createReleases({ fetch: github({ assets: [{ name: "tool_1_Linux_x86_64.tar.gz", body: fs.readFileSync(archive) }], calls: [] }) }).install({ repo: "o/r", dir, binary: "tool", arch: "x64" });
  expect(fs.readFileSync(path.join(dir, "tool"))).toEqual(program);
  fs.symlinkSync("/etc/passwd", path.join(made, "tool-1", "link")); const linked = path.join(work, "linked.tar.gz"); execFileSync("tar", ["-czf", linked, "-C", made, "tool-1"]);
  await expect(createReleases({ fetch: github({ assets: [{ name: "tool_1_Linux_x86_64.tar.gz", body: fs.readFileSync(linked) }], calls: [] }) }).install({ repo: "o/r", dir: path.join(work, "linked-install"), binary: "tool", arch: "x64" })).rejects.toThrow(/has a link/);
});

it("only talks to GitHub: other hosts, plain http, and a redirect elsewhere are refused, and names are checked before anything is asked", async () => {
  expect(allowedHost("https://github.com/o/r/releases/download/v1/a.zip")).toBe(true); expect(allowedHost("https://objects.githubusercontent.com/x")).toBe(true);
  for (const url of ["http://github.com/x", "https://evil.example/x", "https://github.com.evil.example/x", "https://githubusercontent.com.evil.test/x", "not a url"]) expect(allowedHost(url)).toBe(false);
  const asked: string[] = [], never = async (url: string) => { asked.push(url); throw new Error("must not be called"); };
  const releases = createReleases({ fetch: never });
  await expect(releases.release("not a repo", "latest")).rejects.toThrow(/not a GitHub repository name/);
  await expect(releases.release("o/r", "../../etc")).rejects.toThrow(/not a release name/);
  await expect(releases.install({ repo: "o/r", dir: "relative/dir", binary: "zurg" })).rejects.toThrow(/absolute path/);
  await expect(releases.install({ repo: "o/r", dir: path.join(folder(), "x"), binary: "../zurg" })).rejects.toThrow(/not a program file name/);
  expect(asked).toEqual([]);
  const redirected = { assets: [{ name: "zurg-linux-amd64.zip", body: good() }], redirectTo: "https://evil.example/zurg.zip", calls: [] };
  await expect(createReleases({ fetch: github(redirected) }).install({ repo: "o/r", dir: path.join(folder(), "x"), binary: "zurg", arch: "x64" })).rejects.toThrow(/somewhere else/);
  const strange = { assets: [{ name: "zurg-linux-amd64.zip", body: good() }], calls: [] };
  const rewrite = async (url: string) => { const response = await github(strange)(url); if (url.startsWith("https://api")) { const info = await response.json() as any; info.assets[0].browser_download_url = "https://evil.example/zurg.zip"; return new Response(JSON.stringify(info)); } return response; };
  await expect(createReleases({ fetch: rewrite }).install({ repo: "o/r", dir: path.join(folder(), "y"), binary: "zurg", arch: "x64" })).rejects.toThrow(/Only GitHub downloads are allowed/);
});

it("gives plain reasons when GitHub does not have the release, is limiting requests, or cannot be reached", async () => {
  const status = (code: number) => async () => new Response("{}", { status: code });
  await expect(createReleases({ fetch: status(404) }).release("o/r", "v9")).rejects.toThrow(/release was not found/);
  await expect(createReleases({ fetch: status(403) }).release("o/r")).rejects.toThrow(/limiting requests/);
  await expect(createReleases({ fetch: async () => { throw new Error("offline"); } }).release("o/r")).rejects.toThrow(/could not be reached/);
});
