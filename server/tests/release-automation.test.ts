import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

// Runs infra/auto-release.sh with stub gh/git commands against a fixture repository: no network, no real tags.
const script = resolve(process.cwd(), "../infra/auto-release.sh");
type Check = [name: string, status: string, conclusion: string];
const GREEN: Check[] = ["a", "b", "c", "d", "e"].map(name => [`${name} job`, "completed", "success"]);

function run(options: { versions?: Record<string, string>; notes?: boolean; checks?: Check[]; tagExists?: boolean; dispatchFails?: boolean; mode?: string; dry?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "release-test-"));
  const versions = { server: "1.2.3", web: "1.2.3", "phosphor/server": "1.2.3", "phosphor/web": "1.2.3", ...options.versions };
  for (const [name, version] of Object.entries(versions)) { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, "package.json"), JSON.stringify({ version })); }
  mkdirSync(join(dir, "docs/releases"), { recursive: true });
  if (options.notes !== false) writeFileSync(join(dir, "docs/releases/v1.2.3.md"), "# notes\n");
  const bin = join(dir, "bin"), log = join(dir, "calls.log"), checksFile = join(dir, "checks.tsv");
  mkdirSync(bin); writeFileSync(log, "");
  writeFileSync(checksFile, (options.checks ?? GREEN).map(row => row.join("\t")).join("\n"));
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
echo "gh $*" >> "$STUB_LOG"
case "$1 $2" in
  "api --paginate") cat "$STUB_CHECKS" ;;
  "api repos/"*) [ "$STUB_TAG_EXISTS" = 1 ] ;;
  "workflow run") [ "$STUB_DISPATCH_FAILS" != 1 ] ;;
esac
`);
  writeFileSync(join(bin, "git"), `#!/usr/bin/env bash\necho "git $*" >> "$STUB_LOG"\n`);
  chmodSync(join(bin, "gh"), 0o755); chmodSync(join(bin, "git"), 0o755);
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, RELEASE_ROOT: dir, RELEASE_SHA: "0123456789abcdef", GITHUB_REPOSITORY: "owner/repo", RELEASE_MODE: options.mode ?? "auto", DRY_RUN: options.dry ? "true" : "false", SELF_CHECK_NAME: "Tag and publish release", STUB_LOG: log, STUB_CHECKS: checksFile, STUB_TAG_EXISTS: options.tagExists ? "1" : "0", STUB_DISPATCH_FAILS: options.dispatchFails ? "1" : "0" },
  });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { code: result.status, out: result.stdout + result.stderr, calls, tagged: calls.some(call => call.startsWith("git tag")), pushed: calls.some(call => call.startsWith("git push")), dispatched: calls.filter(call => call.startsWith("gh workflow run")) };
}

it("tags the new version at the commit and starts the Release and Publish image workflows", () => {
  const r = run();
  expect(r.code).toBe(0);
  expect(r.calls).toContain("git tag -a v1.2.3 -m StreamRD and Phosphor v1.2.3 0123456789abcdef");
  expect(r.calls).toContain("git push origin refs/tags/v1.2.3");
  expect(r.dispatched).toEqual(["gh workflow run release.yml --ref v1.2.3", "gh workflow run publish-image.yml --ref v1.2.3"]);
});
it("does nothing when the version already has a tag", () => {
  const r = run({ tagExists: true });
  expect(r.code).toBe(0); expect(r.out).toContain("v1.2.3 already exists"); expect(r.tagged).toBe(false); expect(r.dispatched).toEqual([]);
});
it("waits, without failing, while checks are still running, and ignores its own check", () => {
  const waiting = run({ checks: [...GREEN, ["slow job", "in_progress", ""]] });
  expect(waiting.code).toBe(0); expect(waiting.out).toContain("1 of 6 checks are still running"); expect(waiting.tagged).toBe(false);
  const own = run({ checks: [...GREEN, ["Tag and publish release", "in_progress", ""]] });
  expect(own.code).toBe(0); expect(own.tagged).toBe(true);
});
it("does not release when a check failed, or when too few checks have reported", () => {
  const failed = run({ checks: [...GREEN, ["broken job", "completed", "failure"]] });
  expect(failed.code).toBe(0); expect(failed.out).toContain("broken job (failure)"); expect(failed.tagged).toBe(false);
  const few = run({ checks: GREEN.slice(0, 2) });
  expect(few.code).toBe(0); expect(few.out).toContain("only 2 checks have reported"); expect(few.out).toContain("expected at least 3"); expect(few.tagged).toBe(false);
  expect(run({ checks: [...GREEN, ["optional", "completed", "skipped"], ["note", "completed", "neutral"]] }).tagged).toBe(true);
  expect(run({ checks: GREEN.slice(0, 4) }).tagged).toBe(true); // a StreamRD-only commit runs four checks
});
it("reports 'not ready' as a failure when someone asked for the release by hand", () => {
  const notReady: Array<{ checks: Check[] }> = [{ checks: [...GREEN, ["slow job", "in_progress", ""]] }, { checks: [...GREEN, ["broken job", "completed", "failure"]] }, { checks: GREEN.slice(0, 1) }];
  for (const options of notReady) {
    const r = run({ ...options, mode: "manual" });
    expect(r.code).toBe(1); expect(r.tagged).toBe(false);
  }
  expect(run({ mode: "manual" }).tagged).toBe(true);
});
it("refuses mismatched package versions and missing release notes", () => {
  const mismatch = run({ versions: { "phosphor/web": "1.2.2" } });
  expect(mismatch.code).toBe(1); expect(mismatch.out).toContain("phosphor/web is at 1.2.2"); expect(mismatch.tagged).toBe(false);
  const bad = run({ versions: { server: "1.2" } });
  expect(bad.code).toBe(1); expect(bad.tagged).toBe(false);
  const notes = run({ notes: false });
  expect(notes.code).toBe(1); expect(notes.out).toContain("docs/releases/v1.2.3.md does not exist"); expect(notes.tagged).toBe(false);
});
it("a dry run reports what it would do and changes nothing", () => {
  const r = run({ dry: true });
  expect(r.code).toBe(0); expect(r.out).toContain("Dry run: would tag v1.2.3"); expect(r.tagged).toBe(false); expect(r.pushed).toBe(false); expect(r.dispatched).toEqual([]);
});
it("tells you how to finish by hand if the tag was created but its workflows could not be started", () => {
  const r = run({ dispatchFails: true });
  expect(r.code).toBe(1); expect(r.pushed).toBe(true); expect(r.out).toContain("Tagged v1.2.3, but starting its workflows failed");
});
