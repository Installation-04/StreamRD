#!/usr/bin/env node
/**
 * The owner's journey, start to finish, in Google Chrome against the local lab (qa/lab/start.cjs):
 *   first account -> connect a debrid account -> import -> match -> libraries -> play every kind of file (as it is, audio converted,
 *   picture converted), seek, resume, a series pack with Up next -> invite a child and a friend -> the child sees only what the limit
 *   allows -> the friend requests a film -> the owner approves with automatic release search -> it downloads, is imported and plays ->
 *   the log shows the request's history and the diagnostic bundle holds no secrets.
 * It is the regression test for what only a real browser shows: the player page itself, with real H.264/AAC decoders.
 *
 *   node qa/lab/journey.cjs                 needs ffmpeg and Google Chrome (CHROME_PATH=... to choose the binary)
 *   QA_ARTIFACT_DIR=/some/dir               where screenshots and journey.json go
 */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streamrd-journey-")), port = Number(process.env.LAB_PORT || 8080), base = `http://127.0.0.1:${port}`;
const artifacts = process.env.QA_ARTIFACT_DIR || path.join(dir, "artifacts");
const KEY = "lab-debrid-key-0123456789", sleep = ms => new Promise(done => setTimeout(done, ms));
const report = { steps: [], pageErrors: [], startedAt: new Date().toISOString() };
const step = async (name, run) => { const at = Date.now(); process.stdout.write(`• ${name} … `); await run(); report.steps.push({ name, ms: Date.now() - at }); console.log(`ok (${((Date.now() - at) / 1000).toFixed(1)}s)`); };
/** Polls until check() returns something truthy; the last value seen is in the failure message. */
async function until(what, check, timeoutMs = 60_000, everyMs = 1000) {
  const end = Date.now() + timeoutMs; let last;
  for (;;) { try { last = await check(); if (last) return last; } catch (error) { last = error.message; } if (Date.now() > end) throw Error(`Timed out waiting for ${what}. Last: ${JSON.stringify(last)?.slice(0, 300)}`); await sleep(everyMs); }
}

async function startLab() {
  // The lab keeps its videos between runs (LAB_MEDIA_DIR) and always starts from an empty database here.
  const child = spawn(process.execPath, [path.join(__dirname, "start.cjs")], { env: { ...process.env, LAB_DIR: dir, LAB_FRESH: "1", LAB_PORT: String(port), LAB_TRANSFER_SECONDS: "8" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; const collect = chunk => { output = (output + chunk).slice(-6000); if (process.env.LAB_VERBOSE) process.stdout.write(chunk); };
  child.stdout.on("data", collect); child.stderr.on("data", collect);
  await until("the lab to start", () => { if (child.exitCode !== null) throw Error(`the lab stopped: ${output.slice(-800)}`); return output.includes("lab: StreamRD is on"); }, 15 * 60_000, 1000)
    .catch(error => { child.kill("SIGTERM"); throw Error(`${error.message}\n${output.slice(-1500)}`); });
  return child;
}

async function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  const lab = await startLab();
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }), args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const person = async name => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 850 }, colorScheme: "dark", acceptDownloads: true }), page = await context.newPage();
    page.on("pageerror", error => report.pageErrors.push({ who: name, message: error.message.slice(0, 300) }));
    const plays = []; page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/play")) plays.push(Date.now()); });
    const text = async () => (await page.locator("body").innerText()).replace(/\s*\n+\s*/g, " / ");
    const shot = file => page.screenshot({ path: path.join(artifacts, `${file}.png`) }).catch(() => undefined);
    const video = () => page.evaluate(() => { const v = document.querySelector("video"); if (!v) return null; const source = v.querySelector("source");
      return { at: v.currentTime, paused: v.paused, error: v.error ? `${v.error.code} ${v.error.message}` : null, src: (source?.src || v.src).replace(/^https?:\/\/[^/]+/, ""), width: v.videoWidth }; });
    const api = (method, route, body) => page.evaluate(async ([m, r, b]) => { const response = await fetch(r, { method: m, credentials: "include", headers: { "Content-Type": "application/json" }, ...(b ? { body: JSON.stringify(b) } : {}) }); return response.status; }, [method, route, body]);
    const open = async (library, title) => {
      await page.goto(`${base}/shared-libraries`, { waitUntil: "networkidle" });
      await page.locator('main a[href^="/shared-libraries/"]').filter({ hasText: library }).first().click(); await page.waitForLoadState("networkidle");
      await page.getByRole("link", { name: new RegExp(title, "i") }).first().click(); await page.waitForLoadState("networkidle"); await sleep(500);
    };
    /** Presses Play and waits until the picture is really moving; returns the video's state. */
    const play = async label => {
      await page.getByRole("button", { name: /play from server/i }).click();
      let seen = null;
      return until(`${label} to play`, async () => { seen = await video(); return seen && seen.at > 2 && seen.width > 0 && !seen.error ? seen : null; }, 45_000, 500)
        .catch(async error => { await shot(`failed-${label.replace(/\W+/g, "-")}`); throw Error(`${error.message} | video: ${JSON.stringify(seen)} | page: ${(await text()).slice(0, 400)}`); });
    };
    const seek = async fraction => { const box = await page.getByRole("slider", { name: "Seek" }).boundingBox(); await page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2); await page.mouse.down(); await page.mouse.up(); };
    return { name, context, page, plays, text, shot, video, api, open, play, seek };
  };
  const owner = await person("owner"); let kid, friend; const links = {}; const ids = {};

  try {
    await step("a new server sends its first visitor to create the owner account", async () => {
      await owner.page.goto(base, { waitUntil: "networkidle" });
      await owner.page.getByRole("link", { name: /create the first account/i }).click();   // not "Sign in": nobody has an account yet
      await until("the sign-up page", async () => /\/signup$/.test(owner.page.url()), 15_000, 300); await owner.page.waitForLoadState("networkidle");
      await until("the owner's sign-up form", async () => /Set up your server/.test(await owner.text()), 30_000, 300);   // the page first asks the server who may join
      await owner.page.getByLabel("Display name", { exact: true }).fill("Owner");
      await owner.page.getByLabel("Email", { exact: true }).fill("owner@example.invalid");
      await owner.page.getByLabel(/^Password/).fill("lab-owner-password-1");
      await owner.page.getByRole("button", { name: /create/i }).click();
      await until("the setup page", async () => /\/setup$/.test(owner.page.url()), 20_000, 300);
    });

    await step("the debrid account connects: a wrong key is refused in plain words, the right one is accepted", async () => {
      await owner.page.goto(`${base}/account/debrid`, { waitUntil: "networkidle" });
      const key = owner.page.getByLabel(/Real-Debrid key/), save = owner.page.getByRole("button", { name: "Save", exact: true }), test = owner.page.getByRole("button", { name: "Test connection" }).first();
      await key.fill("wrong-key"); await save.click(); await until("the wrong key to be saved", async () => (await test.isEnabled()));
      await test.click(); await until("the refusal", async () => /✗ Real-Debrid did not accept this key/.test(await owner.text()));
      await key.fill(KEY); await save.click(); await sleep(800); await test.click();
      await until("the connection test to pass", async () => /✓ lab \(premium\)/.test(await owner.text()));
    });

    await step("the account is imported: every film and show, including names that end in an audio codec", async () => {
      const titles = await until("seven titles", async () => { await owner.page.goto(`${base}/library`, { waitUntil: "networkidle" }); const found = ((await owner.page.locator("main").innerText()).match(/View title\n(.+)/g) || []).map(line => line.split("\n")[1]); return found.length >= 7 ? found : null; }, 60_000, 2000);
      for (const title of ["Sintel", "Tears of Steel", "Spring", "Big Buck Bunny", "Elephants Dream", "Example Show"]) assert.ok(titles.includes(title), `${title} was not imported (got ${titles.join(", ")})`);
    });

    await step("titles are matched with their details and age ratings", async () => {
      await owner.page.goto(`${base}/library`, { waitUntil: "networkidle" });
      const retry = owner.page.getByRole("button", { name: /retry matching/i }); if (await retry.count()) await retry.click();
      await until("every title to be matched", async () => { await owner.page.goto(`${base}/library`, { waitUntil: "networkidle" }); return /Artwork & details: 7 of 7 titles matched/.test(await owner.text()); }, 90_000, 3000);
    });

    await step("two libraries are created: Movies for chosen people, TV Shows for everyone", async () => {
      await owner.page.goto(`${base}/admin/shared-libraries`, { waitUntil: "networkidle" });
      const create = async (name, type, everyone) => {
        await owner.page.getByLabel("Library name", { exact: true }).fill(name);
        await owner.page.getByLabel("Content type", { exact: true }).selectOption({ label: type });
        const box = owner.page.getByLabel("Visible to everyone", { exact: true }); if (everyone) await box.check(); else await box.uncheck();
        await owner.page.getByRole("button", { name: "Create library" }).click();
        await until(`${name} to be created`, async () => (await owner.text()).includes(`Created ${name}.`));
      };
      await create("Movies", "Movies", false); await create("TV Shows", "TV shows", true);
      await owner.page.goto(`${base}/shared-libraries`, { waitUntil: "networkidle" });
      await owner.page.locator('main a[href^="/shared-libraries/"]').filter({ hasText: "Movies" }).first().click(); await owner.page.waitForLoadState("networkidle");
      ids.sintel = await owner.page.getByRole("link", { name: /sintel/i }).first().getAttribute("href");   // /shared-libraries/<library>/<item>
    });

    await step("an MP4 with H.264 and AAC plays as it is", async () => {
      await owner.open("Movies", "Sintel"); const state = await owner.play("Sintel");
      assert.match(state.src, /^\/media\//, "a file the browser can play should come straight from the provider link");
    });

    await step("an MKV with H.264 and DTS plays with its audio converted, and playback is asked for once", async () => {
      await owner.open("Movies", "Big Buck Bunny");
      await owner.page.getByLabel("Version", { exact: true }).selectOption({ index: 1 }); await sleep(1000);   // the 1080p version
      owner.plays.length = 0;
      const state = await owner.play("Big Buck Bunny (DTS)");
      assert.match(state.src, /^\/api\/stream\/[\w-]+\?start=0$/);
      await sleep(3000);
      assert.equal(owner.plays.length, 1, `the player asked the server to play ${owner.plays.length} times; a converted stream must not make it start over`);
      assert.match(await owner.text(), /Audio converted for your browser/);
      assert.doesNotMatch(await owner.text(), /may not play in your browser|could not be played/, "a converted stream that is playing needs no warning");
    });

    await step("seeking in it continues playback: the browser refuses the copied picture there, and the picture is converted instead", async () => {
      await owner.seek(0.5);
      const state = await until("playback after the seek", async () => { const now = await owner.video(); return now && now.at > 2 && /start=(5\d|6\d)/.test(now.src) ? now : null; }, 45_000, 500);
      assert.equal(state.error, null);
      assert.match(state.src, /&video=1$/, "this file's copied picture cannot be decoded part-way in, so the player should have asked for it to be converted");
      assert.match(await owner.text(), /Converted for your browser/);
      await owner.shot("seek-fallback");
    });

    await step("leaving and coming back resumes where it stopped", async () => {
      await owner.page.keyboard.press("Escape");   // the focus is still on the seek bar from the click; Esc must work there too
      await until("the title page", async () => /\/shared-libraries\//.test(owner.page.url()), 15_000, 300);
      await owner.page.getByRole("button", { name: /play from server/i }).click();
      const state = await until("the resumed stream", async () => { const now = await owner.video(); return now && now.at > 2 && !now.error ? now : null; }, 60_000, 500);
      const start = Number(/start=(\d+)/.exec(state.src)?.[1] ?? 0);
      assert.ok(start >= 50, `expected to resume near the minute mark, started at ${start}s (${state.src})`);
    });

    await step("HEVC 10-bit with TrueHD, and Xvid with MP3 in AVI, play with the picture converted", async () => {
      for (const title of ["Elephants Dream", "Tears of Steel"]) { await owner.open("Movies", title); const state = await owner.play(title); assert.match(state.src, /^\/api\/stream\//); assert.match(await owner.text(), /Converted for your browser/); }
    });

    await step("a title still downloading says so instead of failing", async () => {
      await owner.open("Movies", "Spring"); await owner.page.getByRole("button", { name: /play from server/i }).click();
      await until("the preparing message", async () => /still preparing this video/.test(await owner.text()), 20_000);
    });

    await step("a season pack offers its episodes, plays one and moves on to the next", async () => {
      await owner.open("TV Shows", "Example Show"); await owner.page.getByRole("button", { name: /play from server/i }).click();
      await until("the episode list", async () => /S01E03/.test(await owner.text()), 20_000);
      assert.doesNotMatch(await owner.text(), /\/Example\.Show/, "file names are shown without the provider's leading slash");
      await owner.page.getByRole("button", { name: /S01E01/ }).click();
      await until("episode 1", async () => { const now = await owner.video(); return now && now.at > 2 && /S01E01/.test(await owner.text()); }, 45_000, 500);
      await owner.seek(0.93);
      await until("Up next", async () => /UP NEXT/.test(await owner.text()), 45_000, 500);
      await until("episode 2", async () => { const now = await owner.video(); return now && now.at > 1 && /S01E02[^/]*Audio converted/.test(await owner.text()); }, 60_000, 500);
    });

    await step("invitations are created for a child (kids' limit) and a friend", async () => {
      // Nobody chose a registration policy on this server: it is invitation only, and a stranger's sign-up is refused.
      assert.equal(await owner.api("POST", "/api/auth/signup", { email: "stranger@example.invalid", password: "lab-stranger-password-1", displayName: "Stranger" }), 403);
      await owner.page.goto(`${base}/admin/users`, { waitUntil: "networkidle" });
      await until("the registration policy to show", async () => (await owner.page.getByRole("combobox", { name: "New account registration", exact: true }).inputValue().catch(() => "")) === "invite", 20_000, 300);
      const invite = async (who, limit, libraries) => {
        await owner.page.getByLabel("Invitation email", { exact: true }).fill(`${who}@example.invalid`);
        for (const library of ["Movies", "TV Shows"]) { const box = owner.page.getByRole("checkbox", { name: library }); if (libraries.includes(library)) await box.check(); else await box.uncheck(); }
        await owner.page.getByLabel("Viewing limit", { exact: true }).selectOption({ label: limit });
        await owner.page.getByRole("button", { name: "Create invitation", exact: true }).click();
        links[who] = await until(`${who}'s link`, async () => { const value = await owner.page.getByLabel("Private invitation link", { exact: true }).inputValue().catch(() => ""); return value.includes("#invite=") && !Object.values(links).includes(value) ? value : null; }, 15_000, 300);
      };
      await invite("kid", "Kids (G, TV-Y, TV-Y7)", ["Movies", "TV Shows"]); await invite("friend", "No limit", ["Movies"]);
    });

    const join = async (who, name) => {
      const guest = await person(who);
      await guest.page.goto(links[who], { waitUntil: "networkidle" });
      await guest.page.getByLabel("Display name", { exact: true }).fill(name);
      await guest.page.getByLabel(/^Password/).fill(`lab-${who}-password-1`);
      await guest.page.getByRole("button", { name: /accept invitation/i }).click();
      await until("the libraries page", async () => /\/shared-libraries$/.test(guest.page.url()), 20_000, 300);
      return guest;
    };
    await step("the child's account shows only titles within its limit, and the server refuses the rest", async () => {
      kid = await join("kid", "Kiddo");
      await kid.page.locator('main a[href^="/shared-libraries/"]').filter({ hasText: "Movies" }).first().click(); await kid.page.waitForLoadState("networkidle");
      const shown = async () => ((await kid.page.locator("main").innerText()).match(/View title\n(.+)/g) || []).map(line => line.split("\n")[1]).sort();
      await until("the child's library to list its titles", async () => (await shown()).length > 0, 20_000, 500);
      assert.deepEqual(await shown(), ["Big Buck Bunny", "Spring"], "only the G-rated films");
      const [, , library, item] = ids.sintel.split("/");
      assert.equal(await kid.api("GET", `/api/shared-libraries/${library}/items/${item}`), 404);
      assert.equal(await kid.api("POST", `/api/shared-libraries/${library}/items/${item}/play`, {}), 404);
      for (const route of ["/api/admin/logs", "/api/admin/logs/bundle", "/api/admin/users"]) assert.equal(await kid.api("GET", route), 403, route);
      for (const route of ["/api/requests", "/api/discovery/search?q=sintel&type=movie"]) assert.equal(await kid.api("GET", route), 403, route);
    });

    await step("the friend asks for a film that is not in the library", async () => {
      friend = await join("friend", "Friend");
      await friend.page.goto(`${base}/library`, { waitUntil: "networkidle" });   // Imports is the administrator's page
      await until("a viewer to be taken from Imports to the libraries", async () => /\/shared-libraries$/.test(friend.page.url()), 15_000, 300);
      await friend.page.goto(`${base}/setup`, { waitUntil: "networkidle" });
      await until("the viewer's setup page", async () => /Server-managed playback/.test(await friend.text()), 20_000, 300);
      assert.doesNotMatch(await friend.text(), /private debrid library/i, "a viewer is not sent to import from a debrid account");
      await friend.page.goto(`${base}/discover`, { waitUntil: "networkidle" });
      await friend.page.getByRole("searchbox").first().or(friend.page.getByRole("textbox").first()).fill("Cosmos Laundromat"); await friend.page.keyboard.press("Enter");
      await friend.page.getByRole("link", { name: /cosmos laundromat/i }).first().click(); await friend.page.waitForLoadState("networkidle");
      await friend.page.getByRole("button", { name: /request movie/i }).click();
      await until("the request to be received", async () => /Awaiting approval/.test(await friend.text()), 20_000);
    });

    await step("the owner adds an indexer; release search leaves out the cam copy, the sequel and the other film", async () => {
      await owner.page.goto(`${base}/admin/request-settings`, { waitUntil: "networkidle" });
      await owner.page.getByRole("textbox", { name: "Name", exact: true }).fill("Lab indexer");
      await owner.page.getByRole("textbox", { name: "Torznab URL" }).fill("http://127.0.0.1:47990/torznab/api");
      await owner.page.locator("input[type=password]").last().fill("lab-indexer-key");
      await owner.page.getByRole("button", { name: "Add indexer" }).click();
      await until("the indexer to be added", async () => /Indexer added\. Working/.test(await owner.text()), 30_000);
      await owner.page.goto(`${base}/admin/requests`, { waitUntil: "networkidle" });
      await owner.page.getByRole("button", { name: "Review request" }).click();
      await owner.page.getByRole("button", { name: "Find releases" }).click();
      const page = await until("the releases", async () => { const now = await owner.text(); return /Best match/.test(now) ? now : null; }, 30_000);
      assert.match(page, /Cosmos\.Laundromat\.2015\.1080p\.WEB-DL\.H264\.AAC-LAB \/ ★ Best match/);
      assert.doesNotMatch(page, /HDCAM|Laundromat\.2\.2019|Cosmos\.2014/);
    });

    await step("approval picks the release, the transfer runs and the film lands in the library", async () => {
      await owner.page.locator("select").filter({ hasText: "No shared library selected" }).selectOption({ label: "Movies" });
      await owner.page.getByRole("button", { name: "Find the best release and approve" }).click();
      await until("the request to become available", async () => { await owner.page.getByRole("button", { name: "Refresh queue" }).click().catch(() => undefined); await sleep(800); return /Close review \/ Available on server/.test(await owner.text()); }, 180_000, 3000);   // the request's own status, not the filter's option
    });

    await step("the friend sees it arrive and plays it", async () => {
      await friend.page.goto(`${base}/requests`, { waitUntil: "networkidle" });
      await until("the friend's request to show as available", async () => /Available on server/.test(await friend.text()), 20_000);
      await friend.open("Movies", "Cosmos Laundromat"); await friend.play("Cosmos Laundromat");
    });

    await step("the log tells the request's story, and the diagnostic bundle carries no secrets", async () => {
      await owner.page.goto(`${base}/admin/logs`, { waitUntil: "networkidle" });
      await owner.page.getByLabel("Search log messages and details").fill("Cosmos Laundromat");
      const lines = await until("the request's history", async () => { const now = await owner.text(); return /Request received/.test(now) && /imported into the shared library/.test(now) ? now : null; }, 20_000);
      assert.match(lines, /best release was chosen automatically \(Cosmos\.Laundromat\.2015\.1080p/);
      // The rest of what happened is there too: the import, each play with the server's decision, the indexer.
      await owner.page.getByLabel("Search log messages and details").fill("");
      const all = await until("the full log", async () => { const now = await owner.text(); return /Account scan finished/.test(now) ? now : null; }, 20_000);
      for (const line of [/Account scan finished: 7 checked, 7 imported/, /Playing Sintel \(2010\): as it is/, /Playing Big Buck Bunny \(2008\): audio converted/, /Playing Elephants Dream \(2006\): picture and audio converted/, /could not decode the copied picture/, /Added the indexer Lab indexer/, /Connection test failed: Real-Debrid did not accept this key/, /Saved debrid settings/]) assert.match(all, line);
      const [download] = await Promise.all([owner.page.waitForEvent("download", { timeout: 20_000 }), owner.page.getByRole("button", { name: "Diagnostic bundle" }).click()]);
      const file = path.join(artifacts, "diagnostics.json"); await download.saveAs(file);
      const raw = fs.readFileSync(file, "utf8"), bundle = JSON.parse(raw);
      assert.equal(bundle.requestCounts.available, 1); assert.ok(bundle.logs.some(line => line.type === "request")); assert.ok(bundle.logs.some(line => line.type === "playback"));
      for (const secret of [KEY, "lab-indexer-key", "lab-tmdb-key", "owner@example.invalid", "friend@example.invalid", "btih:", "/media/"]) assert.ok(!raw.includes(secret), `the bundle contains ${secret}`);
    });

    assert.deepEqual(report.pageErrors, [], "no page raised a script error");
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(artifacts, "journey.json"), JSON.stringify(report, null, 2));
    await browser.close().catch(() => undefined); lab.kill("SIGTERM"); await sleep(800);
    if (!process.env.LAB_KEEP) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`The journey passed: ${report.steps.length} steps. Report and screenshots: ${artifacts}`);
}
main().then(() => process.exit(0), error => { console.error(`\nFAIL: ${error.message}`); process.exit(1); });
