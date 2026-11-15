import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { app, auth, resetDb, adminAndUser } from "./helpers";
import { parseReleaseNotes, clearReleaseNotesCache } from "../src/release-notes";
import { version } from "../package.json";

// The Updates panel shows what changed in each release. The release page is played by a stand-in; what matters is that notes become plain
// sections (never markup), that only the installed version and later ones are listed, newest first, and that nothing is fetched when checks are off.
const BODY = `# StreamRD v9.9.9 — Notes that read well

## What changes for the viewer
- **Bold** thing with a [link](https://example.invalid/x) and \`code\`
  carried onto a second line
- Another fix <script>alert(1)</script>

## Upgrading
Plain paragraph text.
`;
beforeEach(async () => { await resetDb(); clearReleaseNotesCache(); delete process.env.UPDATE_CHECK; });
afterEach(() => { vi.restoreAllMocks(); delete process.env.UPDATE_CHECK; });
const entry = (tag: string, body = BODY, extra: Record<string, unknown> = {}) => ({ tag_name: tag, name: `StreamRD ${tag}`, body, draft: false, prerelease: false, published_at: "2026-11-10T00:00:00Z", html_url: `https://github.com/Installation-04/StreamRD/releases/tag/${tag}`, ...extra });
const next = (n: number) => { const [a, b, c] = version.split(".").map(Number); return `${a}.${b}.${c + n}`; };

it("cuts release notes into plain sections: a title, headings, items that continue onto a second line, and paragraphs", () => {
  const parsed = parseReleaseNotes(BODY);
  expect(parsed.title).toBe("Notes that read well");
  expect(parsed.sections.map(section => section.heading)).toEqual(["What changes for the viewer", "Upgrading"]);
  expect(parsed.sections[0].blocks[0]).toEqual({ kind: "item", text: "Bold thing with a link and code carried onto a second line" });
  expect(parsed.sections[0].blocks[1].text).toContain("<script>");   // kept as text: the page shows it as text and never as markup
  expect(parsed.sections[1].blocks).toEqual([{ kind: "text", text: "Plain paragraph text." }]);
  expect(parseReleaseNotes("").sections).toEqual([]);
});

it("lists the installed version and every later release, newest first, and leaves out drafts, pre-releases and older ones", async () => {
  const { admin, user } = await adminAndUser();
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify([
    entry(`v${next(1)}`), entry(`v${next(3)}`), entry(`v${next(2)}`, BODY, { draft: true }), entry(`v${next(4)}`, BODY, { prerelease: true }),
    entry(`v${version}`), entry("v0.0.1"), entry("not-a-version"), entry(`v${next(5)}`, "Just a sentence, no headings."),
  ]), { status: 200 }));
  expect((await request(app).get("/api/admin/system/update/notes")).status).toBe(401);
  expect((await request(app).get("/api/admin/system/update/notes").set(auth(user.token))).status).toBe(403);
  const found = await request(app).get("/api/admin/system/update/notes").set(auth(admin.token));
  expect(found.status).toBe(200);
  expect(found.body.current).toBe(version); expect(found.body.error).toBeNull();
  expect(found.body.releases.map((release: { version: string }) => release.version)).toEqual([next(5), next(3), next(1), version]);   // a release whose notes have no headings is still listed
  expect(found.body.releases[1]).toMatchObject({ title: "Notes that read well", url: expect.stringMatching(/^https:\/\/github\.com\//) });
  expect(String(fetch.mock.calls[0][0])).toBe("https://api.github.com/repos/Installation-04/StreamRD/releases?per_page=30");
  fetch.mockClear();
  await request(app).get("/api/admin/system/update/notes").set(auth(admin.token));
  expect(fetch).not.toHaveBeenCalled();   // kept for a while
});

it("fetches nothing when update checks are off, and fails soft with no detail when the release page is unavailable", async () => {
  const { admin } = await adminAndUser();
  process.env.UPDATE_CHECK = "false";
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("token=secret-network-detail"));
  const off = await request(app).get("/api/admin/system/update/notes?refresh=1").set(auth(admin.token));
  expect(off.body.releases).toEqual([]); expect(off.body.error).toMatch(/turned off/); expect(fetch).not.toHaveBeenCalled();
  delete process.env.UPDATE_CHECK;
  const down = await request(app).get("/api/admin/system/update/notes?refresh=1").set(auth(admin.token));
  expect(down.status).toBe(200); expect(down.body.releases).toEqual([]);
  expect(down.body.error).toMatch(/could not be fetched/); expect(JSON.stringify(down.body)).not.toContain("secret-network-detail");
});
