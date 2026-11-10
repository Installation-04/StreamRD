#!/usr/bin/env node
// Builds the README images (docs/assets/readme/*) from the browser-journey screenshots.
//
//   node scripts/readme-assets.cjs <screenshots-dir> [output-dir]
//
// <screenshots-dir> holds the streamrd-*.png and phosphor-*.png files that the CI browser journeys upload (the
// `streamrd-browser-qa` and `phosphor-browser-qa` artifacts, extracted together, or docs/screenshots/vX.Y.Z).
// Every image is a crop of a real screenshot; nothing is drawn by hand except the hero banner's text and layout.
// Needs the `playwright` package (qa/package.json) and a Chromium.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require(path.join(__dirname, "../qa/node_modules/playwright"))); }

const [source, target = path.join(__dirname, "../docs/assets/readme")] = process.argv.slice(2);
if (!source) { console.error("usage: node scripts/readme-assets.cjs <screenshots-dir> [output-dir]"); process.exit(2); }
const shot = name => { const file = path.resolve(source, name); if (!fs.existsSync(file)) throw new Error(`Missing screenshot ${name} in ${source}`); return file; };
const url = name => pathToFileURL(shot(name)).href;
// A page loaded from a file (not setContent) may read the screenshot files.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "readme-assets-"));
const show = async (page, html) => { const file = path.join(scratch, "page.html"); fs.writeFileSync(file, html); await page.goto(pathToFileURL(file).href); };
const logo = fs.readFileSync(path.join(__dirname, "../docs/assets/logo.svg"), "utf8");

// name -> [source screenshot, output width, maximum output height]. The top of the page is kept.
const crops = {
  "discover-dark.png": ["streamrd-discover.png", 1200, 875],
  "discover-light.png": ["streamrd-discover-light.png", 1200, 875],
  "discover-mobile.png": ["streamrd-discover-mobile.png", 390, 844],
  "find-media.png": ["streamrd-request-discovery.png", 1200, 931],
  "requests.png": ["streamrd-requests-queue.png", 1200, 633],
  "imports.png": ["streamrd-account-library.png", 1200, 1000],
  "libraries.png": ["streamrd-shared-library.png", 1200, 833],
  "libraries-admin.png": ["streamrd-shared-library-admin.png", 1200, 1000],
  "people-access.png": ["streamrd-server-access.png", 1200, 917],
  "viewing-limits.png": ["streamrd-viewing-limits.png", 1200, 1000],
  "invitations.png": ["streamrd-invite-access.png", 1200, 1000],
  "kids-library.png": ["streamrd-kids-library.png", 1200, 931],
  "player.png": ["streamrd-player.png", 1200, 875],
  "system.png": ["streamrd-system.png", 1200, 917],
  "phosphor-search.png": ["phosphor-discover.png", 1200, 875],
  "phosphor-amber.png": ["phosphor-discover-amber.png", 1200, 875],
  "phosphor-queue.png": ["phosphor-queue.png", 1200, 875],
};

(async () => {
  fs.mkdirSync(target, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [out, [name, width, maxHeight]] of Object.entries(crops)) {
    await page.setViewportSize({ width, height: maxHeight });
    await show(page, `<body style="margin:0;background:#0a0a0a"><div style="width:${width}px;height:${maxHeight}px;overflow:hidden"><img src="${url(name)}" style="display:block;width:${width}px"></div></body>`);
    await page.waitForFunction(() => document.images[0].complete);
    const full = await page.evaluate(() => document.images[0].getBoundingClientRect().height);
    await page.screenshot({ path: path.join(target, out), clip: { x: 0, y: 0, width, height: Math.min(maxHeight, Math.round(full)) } });
  }
  // Hero banner: the real screenshots, arranged on a black and orange backdrop.
  await page.setViewportSize({ width: 1600, height: 900 });
  await show(page, `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box} body{margin:0;width:1600px;height:900px;overflow:hidden;position:relative;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#f4f2ef;
      background:radial-gradient(900px 520px at 18% -8%,#ff8a1f40,transparent 70%),radial-gradient(800px 480px at 92% -6%,#ffb04733,transparent 70%),#0a0a0a}
    .brand{position:absolute;top:44px;left:0;right:0;display:flex;justify-content:center;align-items:center;gap:22px} .brand svg{width:84px;height:84px}
    .brand b{font-size:92px;letter-spacing:-4px;font-weight:800;line-height:1} .brand b i{color:#ff8a1f;font-style:normal}
    .tag{position:absolute;top:146px;left:0;right:0;text-align:center;font-size:30px;color:#d9d3cb}
    .chips{position:absolute;top:204px;left:0;right:0;display:flex;justify-content:center;gap:12px} .chips span{border:1px solid #ffffff30;border-radius:30px;padding:9px 20px;font-size:19px;background:#ffffff08}
    .win{position:absolute;border:1px solid #ffffff22;border-radius:14px;overflow:hidden;box-shadow:0 30px 80px #000a;background:#000} .win img{display:block;width:100%}
    .main{left:350px;top:330px;width:900px;height:640px} .left{left:-40px;top:360px;width:560px;height:520px;transform:perspective(1400px) rotateY(14deg) rotateZ(-3deg);transform-origin:left}
    .right{left:1180px;top:350px;width:520px;height:520px;transform:perspective(1400px) rotateY(-16deg) rotateZ(3deg);transform-origin:right}
    .phone{left:120px;top:490px;width:190px;height:420px;border-radius:26px;border:2px solid #ffffff30} .phone img{width:100%}
    .fade{position:absolute;left:0;right:0;bottom:0;height:90px;background:linear-gradient(transparent,#0a0a0a)}
  </style>
  <div class="brand">${logo.replace("<svg ", '<svg width="84" height="84" ')}<b>stream<i>rd</i></b></div>
  <div class="tag">Your debrid accounts, turned into a private streaming service for you and your people.</div>
  <div class="chips"><span>Self-hosted</span><span>Libraries</span><span>Requests</span><span>Multi-user</span><span>One container</span></div>
  <div class="win left"><img src="${url("streamrd-discover-light.png")}"></div>
  <div class="win right"><img src="${url("phosphor-discover.png")}"></div>
  <div class="win main"><img src="${url("streamrd-discover.png")}"></div>
  <div class="win phone"><img src="${url("streamrd-discover-mobile.png")}"></div>
  <div class="fade"></div>`);
  await page.waitForFunction(() => [...document.images].every(image => image.complete));
  await page.screenshot({ path: path.join(target, "hero.jpg"), type: "jpeg", quality: 88 });
  await browser.close(); fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`Wrote ${Object.keys(crops).length + 1} images to ${target}`);
})().catch(error => { console.error(error.message); process.exit(1); });
