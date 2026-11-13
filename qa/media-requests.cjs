const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Real APIs and workers against disposable images; only provider transport is a
// protocol fixture. These journeys never use a live provider or qBittorrent host.
module.exports = async function mediaRequests({ product, page, url, api, admin, member, call, shot, noOverflow, report }) {
  const backend = process.env[product === 'streamrd' ? 'QA_STREAMRD_BACKEND' : 'QA_PHOSPHOR_BACKEND'];
  assert.match(backend ?? '', /^[a-z0-9-]+$/);
  const output = process.env.QA_ARTIFACT_DIR;
  const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 1050 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  const cookie = product === 'streamrd' ? 'sr' : 'ph';
  await context.addCookies([{ name: `${cookie}_token`, value: member.token, domain: 'localhost', path: '/' }, { name: `${cookie}_role`, value: 'user', domain: 'localhost', path: '/' }]);
  const viewer = await context.newPage();
  viewer.on('pageerror', error => report.pageErrors.push({ product, message: error.message }));
  async function poll(read, ready, label) {
    for (let attempt = 0; attempt < 320; attempt++) {
      const value = await read(); if (ready(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw Error(`${product}: timed out waiting for ${label}`);
  }
  function override(patch) {
    const code = 'const fs=require("node:fs"),file="/app/data/request-qa-override.json";let old={};try{old=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}fs.writeFileSync(file,JSON.stringify({...old,...JSON.parse(fs.readFileSync(0,"utf8"))}),{mode:0o600})';
    execFileSync('docker', ['exec', '-i', backend, 'node', '-e', code], { input: JSON.stringify(patch) });
  }
  function traces(file) {
    const code = 'const fs=require("node:fs");process.stdout.write(fs.existsSync(process.argv[1])?fs.readFileSync(process.argv[1],"utf8"):"")';
    return execFileSync('docker', ['exec', backend, 'node', '-e', code, file], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  async function viewerShot(name) {
    await viewer.evaluate(() => { window.scrollTo(0, 0); return document.fonts.ready; });
    const filename = `${product}-${name}.png`;
    await viewer.screenshot({ path: path.join(output, filename), fullPage: !name.endsWith('mobile'), animations: 'disabled' });
    report.screenshots.push(filename);
  }
  async function viewerNoOverflow(label) {
    const size = await viewer.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(size.scroll <= size.viewport + 1, `${product} ${label} horizontal overflow: ${JSON.stringify(size)}`);
  }
  async function status(route, token, method = 'GET', body) {
    return (await fetch(`http://127.0.0.1:${api}${route}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).status;
  }
  async function requestMovie(name, id) {
    await viewer.goto(`${url}/discover`, { waitUntil: 'networkidle' });
    await viewer.getByLabel('Search movies or shows', { exact: true }).fill(name);
    await viewer.getByRole('combobox', { name: /^Media type/ }).selectOption('movie');   // StreamRD searches movies and shows together unless told otherwise
    await viewer.getByRole('combobox', { name: /^Metadata source/ }).selectOption('tmdb');
    await viewer.getByRole('link', { name: `View ${name}`, exact: true }).click();
    await viewer.getByRole('heading', { name, exact: true }).waitFor();
    const response = viewer.waitForResponse(value => value.url().endsWith('/api/requests') && value.request().method() === 'POST');
    await viewer.getByRole('button', { name: 'Request movie', exact: true }).click();
    const submitted = await (await response).json(); assert.ok(submitted.request?.id);
    assert.equal(submitted.request.externalId, String(id));
    await viewer.getByRole('link', { name: 'View my request →', exact: true }).waitFor();
    return submitted.request;
  }
  async function approve(request, destination, libraryId) {
    await page.goto(`${url}/admin/requests`, { waitUntil: 'networkidle' });
    const article = page.getByRole('article', { name: `Request for ${request.name}`, exact: true });
    await article.getByRole('button', { name: 'Review request', exact: true }).click();
    await article.getByRole('combobox', { name: /^Download destination/ }).selectOption(destination);
    if (destination === 'cloud') {
      await article.getByRole('combobox', { name: /^Cloud provider/ }).selectOption('realdebrid');
      await article.getByRole('combobox', { name: /^Shared library after import/ }).selectOption(libraryId);
    }
    await article.getByLabel('Approved release magnet', { exact: true }).fill(`magnet:?xt=urn:btih:${(destination === 'cloud' ? '1' : '2').repeat(40)}`);
    const response = page.waitForResponse(value => value.url().endsWith(`/api/admin/requests/${request.id}/approve`) && value.request().method() === 'POST');
    await article.getByRole('button', { name: 'Approve download', exact: true }).click();
    assert.equal((await response).status(), 200);
  }
  try {
    // A source library is an explicit administrator decision. Approval does not
    // silently grant an entire collection to otherwise-unprivileged requesters.
    const created = await call(api, '/api/admin/shared-libraries', { name: 'Requested movies', mediaType: 'movie' }, admin.token);
    const libraryId = created.library.id;
    await call(api, `/api/admin/shared-libraries/${libraryId}/users`, { userId: member.user.id }, admin.token);
    const stranger = await call(api, '/api/auth/signup', { email: 'requests-stranger@example.invalid', password: 'request-fixture-password123', displayName: 'Unrelated viewer' });

    await page.goto(`${url}/admin/request-settings`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Download settings.', exact: true }).waitFor();
    await page.getByLabel('qBittorrent Web UI URL', { exact: true }).fill('https://qbit.fixture.invalid');
    await page.getByLabel('qBittorrent username', { exact: true }).fill('fakeuser');
    await page.getByLabel('qBittorrent password', { exact: true }).fill('qbit-fixture-only');
    await page.getByLabel('Enable local qBittorrent downloads', { exact: true }).check();
    await page.getByRole('button', { name: 'Save download settings', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'qBittorrent settings saved.' }).waitFor();
    assert.equal(traces('/app/data/request-client-requests.jsonl').length, 0, 'Saving settings must not contact qBittorrent');
    await page.getByRole('button', { name: 'Test saved qBittorrent connection', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'responded successfully' }).waitFor();
    const settings = await call(api, '/api/admin/request-settings', null, admin.token);
    assert.equal(settings.settings.qbit.passwordConfigured, true);
    assert.ok(!JSON.stringify(settings).includes('qbit-fixture-only'));
    await noOverflow('desktop request settings'); await shot('request-settings');

    await viewer.goto(`${url}/discover`, { waitUntil: 'networkidle' });
    await viewer.getByLabel('Search movies or shows', { exact: true }).fill('Elephants Dream');
    await viewer.getByRole('combobox', { name: /^Media type/ }).selectOption('movie');
    await viewer.getByRole('combobox', { name: /^Metadata source/ }).selectOption('tmdb');
    await viewer.getByRole('link', { name: 'View Elephants Dream', exact: true }).waitFor();
    await viewerNoOverflow('desktop request discovery'); await viewerShot('request-discovery');
    const cloud = await requestMovie('Elephants Dream', 1003);
    assert.equal(cloud.status, 'requested');
    assert.equal((await call(api, '/api/requests', { provider: 'tmdb', id: '1003', type: 'movie' }, member.token)).request.id, cloud.id, 'Repeated requests must follow the same canonical request');
    assert.equal(await status(`/api/requests/${cloud.id}`, stranger.token), 404);
    assert.ok(!JSON.stringify(await call(api, `/api/requests/${cloud.id}`, null, member.token)).match(/sourceUrl|providerRef|sourceFingerprint|subscribers|qbit-fixture-only|account-fixture-only/));
    assert.equal(traces('/app/data/account-provider-requests.jsonl').filter(value => value.path.endsWith('/torrents/addMagnet')).length, 0, 'A member request must not begin a transfer without approval');
    await viewerNoOverflow('desktop requested title'); await viewerShot('request-media');
    await viewer.setViewportSize({ width: 390, height: 844 }); await viewerNoOverflow('mobile requested title'); await viewerShot('request-media-mobile'); await viewer.setViewportSize({ width: 1440, height: 1050 });
    report.journeys.push(`${product}: metadata discovery, unavailable-title request, canonical deduplication, manual approval gate and follower privacy`);

    await approve(cloud, 'cloud', libraryId);
    await poll(() => call(api, `/api/requests/${cloud.id}`, null, member.token), value => value.request.status === 'downloading' && value.request.progress === 37, 'measured cloud download progress');
    const measuredCloud = viewer.getByRole('progressbar', { name: 'Measured download progress', exact: true });
    await measuredCloud.waitFor(); await viewer.waitForFunction(() => document.querySelector('progress')?.value === 37);
    await viewerShot('request-cloud-progress');
    await noOverflow('desktop approval queue'); await shot('request-admin');
    override({ cloudProgress: 100 });
    await poll(() => call(api, `/api/requests/${cloud.id}`, null, member.token), value => value.request.status === 'available', 'finished cloud import into an accessible library');
    await viewer.getByRole('link', { name: /^Open in shared library/ }).waitFor();
    const available = await call(api, '/api/discovery/tmdb/movie/1003', null, member.token);
    assert.ok(available.availability.some(item => item.kind === 'shared' && item.href.includes(libraryId)));
    assert.equal(await viewer.getByRole('button', { name: 'Request movie', exact: true }).count(), 0);
    await viewer.getByRole('link', { name: /^Open in shared library/ }).click();
    await viewer.getByRole('heading', { name: 'Elephants Dream', exact: true }).waitFor();
    await viewer.getByRole('button', { name: 'Play from server', exact: true }).waitFor();
    report.journeys.push(`${product}: administrator-approved cloud transfer reports 37 percent, finishes, imports and becomes accessible before a play link appears`);

    const local = await requestMovie('Request Local Fixture', 1004);
    await approve(local, 'local');
    await poll(() => call(api, `/api/requests/${local.id}`, null, member.token), value => value.request.status === 'downloading' && value.request.progress === 42, 'measured qBittorrent download progress');
    await viewer.goto(`${url}/requests`, { waitUntil: 'networkidle' });
    await viewer.getByRole('heading', { name: 'My requests.', exact: true }).waitFor();
    await viewer.getByRole('heading', { name: 'Request Local Fixture', exact: true }).waitFor();
    await viewerNoOverflow('desktop request tracking'); await viewerShot('requests-queue');
    override({ localProgress: 100 });
    await poll(() => call(api, `/api/requests/${local.id}`, null, member.token), value => value.request.status === 'downloaded' && value.request.progress === 100, 'completed local download awaiting import');
    await viewer.goto(`${url}/discover/tmdb/movie/1004`, { waitUntil: 'networkidle' });
    await viewer.getByText('Downloaded by qBittorrent.', { exact: false }).waitFor();
    assert.equal(await viewer.getByRole('link', { name: /^Open in (shared library|my library|catalog)/ }).count(), 0);
    const localDetails = await call(api, '/api/discovery/tmdb/movie/1004', null, member.token);
    assert.deepEqual(localDetails.availability, []);
    assert.ok(!JSON.stringify(localDetails).match(/fixture-local-downloads|sourceUrl|providerRef|sourceFingerprint|SID=/));
    await viewer.setViewportSize({ width: 390, height: 844 }); await viewerNoOverflow('mobile local completion'); await viewerShot('request-local-complete-mobile'); await viewer.setViewportSize({ width: 1440, height: 1050 });
    assert.equal(traces('/app/data/request-client-requests.jsonl').filter(value => value.path === '/api/v2/torrents/add').length, 1);
    assert.equal(traces('/app/data/account-provider-requests.jsonl').filter(value => value.path.endsWith('/torrents/addMagnet')).length, 1);
    report.journeys.push(`${product}: real qBittorrent client protocol reports 42 percent then downloaded locally without inventing library availability or duplicate submissions`);

    await viewer.goto(`${url}/discover`, { waitUntil: 'networkidle' });
    await viewer.getByRole('combobox', { name: /^Media type/ }).selectOption('series');
    await viewer.getByRole('combobox', { name: /^Metadata source/ }).selectOption('tmdb');
    await viewer.getByLabel('Search movies or shows', { exact: true }).fill('Request Series Fixture');
    await viewer.getByRole('link', { name: 'View Request Series Fixture', exact: true }).click();
    const seriesResponse = viewer.waitForResponse(value => value.url().endsWith('/api/requests') && value.request().method() === 'POST');
    await viewer.getByRole('button', { name: 'Request show', exact: true }).click();
    const series = await (await seriesResponse).json(); assert.equal(series.request.type, 'series'); assert.equal(series.request.status, 'requested');
    await viewer.getByText('Show requests track the release that is selected for them.', { exact: false }).waitFor();
    await viewerShot('request-show');
    await viewer.getByRole('link', { name: 'View my request →', exact: true }).click();
    await viewer.getByRole('list', { name: 'Request history', exact: true }).waitFor();
    await viewer.getByRole('button', { name: 'Stop tracking', exact: true }).click();
    await viewer.waitForURL(/\/requests$/);
    assert.equal(await status(`/api/requests/${series.request.id}`, member.token), 404);
    const clientChanges = traces('/app/data/request-client-requests.jsonl').filter(value => value.method === 'POST' && !value.path.endsWith('/auth/login'));
    assert.ok(clientChanges.every(value => value.path === '/api/v2/torrents/add'));
    report.journeys.push(`${product}: show requests retain selected-release scope and stopping tracking removes private history without deleting upstream media`);
  } catch (error) {
    await viewer.screenshot({ path: path.join(output, `${product}-request-failure.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
};
