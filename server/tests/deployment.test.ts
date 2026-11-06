import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

// Test installer policy with Docker/privilege checks stubbed; no daemon, apt,
// system services, or real deployment configuration is touched by this suite.
function fixture(product: "streamrd" | "phosphor", existing?: string, blocked = false, portArgs = false) {
  const dir = mkdtempSync(join(tmpdir(), "installer-test-"));
  const source = resolve(process.cwd(), product === "streamrd" ? "../infra/install.sh" : "../phosphor/infra/install.sh");
  const script = join(dir, "install.sh");
  writeFileSync(script, readFileSync(source, "utf8").replace(/\nmain "\$@"\s*$/, "\n"));
  if (existing !== undefined) writeFileSync(join(dir, ".env"), existing);
  const shell = `script=$1; shift; source "$script"; require_root(){ :; }; check_os(){ :; }; install_docker(){ :; }; hostname(){ echo 127.0.0.1; }; find_free_port(){ echo "$1"; }; docker(){ ${blocked ? 'if [[ "$*" == *" run "* ]]; then return 1; fi;' : ''} return 0; }; HAS_PORT_ARGS=${portArgs}; main`;
  return { dir, run: () => spawnSync("bash", ["-c", shell, "fixture", script], { encoding: "utf8" }) };
}
for (const product of ["streamrd", "phosphor"] as const) {
  it(`${product} installer preserves existing signing secret, URLs and quoted ports`, () => {
    const env = 'JWT_SECRET=fixture-secret-to-preserve\nAPI_BASE_URL="http://127.0.0.1:48001"\n export API_PORT = "48001" # preserved comment\nWEB_PORT=3101\n';
    const test = fixture(product, env);
    try { const result = test.run(); expect(result.status).toBe(0); expect(readFileSync(join(test.dir, ".env"), "utf8")).toBe(env); expect(result.stdout).toContain("48001"); }
    finally { rmSync(test.dir, { recursive: true, force: true }); }
  });
  it(`${product} installer creates a private first-install configuration and preserves it on repeat`, () => {
    const test = fixture(product);
    try {
      expect(test.run().status).toBe(0); const file = join(test.dir, ".env"), first = readFileSync(file, "utf8");
      expect(first).toMatch(/JWT_SECRET=[a-f0-9]{64}/); expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(test.run().status).toBe(0); expect(readFileSync(file, "utf8")).toBe(first);
    } finally { rmSync(test.dir, { recursive: true, force: true }); }
  });
  it(`${product} installer reports old volume ownership without altering configuration`, () => {
    const env = 'JWT_SECRET=fixture-secret\nAPI_PORT=48001\nWEB_PORT=3101\n'; const test = fixture(product, env, true);
    try { const result = test.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain("UID 1000"); expect(readFileSync(join(test.dir, ".env"), "utf8")).toBe(env); }
    finally { rmSync(test.dir, { recursive: true, force: true }); }
  });
  it(`${product} installer reads configuration as data rather than executing it`, () => {
    const test = fixture(product, 'JWT_SECRET=fixture-secret\n');
    const file = join(test.dir, ".env"), marker = join(test.dir, "should-not-run");
    const env = `JWT_SECRET=fixture-secret\nEVIL=$(touch "${marker}")\n`;
    writeFileSync(file, env);
    try { expect(test.run().status).toBe(0); expect(existsSync(marker)).toBe(false); expect(readFileSync(file, "utf8")).toBe(env); }
    finally { rmSync(test.dir, { recursive: true, force: true }); }
  });
  it(`${product} installer refuses port overrides on an existing configuration`, () => {
    const env = 'JWT_SECRET=fixture-secret\n'; const test = fixture(product, env, false, true);
    try { expect(test.run().status).not.toBe(0); expect(readFileSync(join(test.dir, ".env"), "utf8")).toBe(env); }
    finally { rmSync(test.dir, { recursive: true, force: true }); }
  });
}
it("installer and production smoke shell syntax is valid", () => {
  execFileSync("bash", ["-n", "../infra/install.sh", "../phosphor/infra/install.sh", "../infra/smoke-images.sh"]);
});
