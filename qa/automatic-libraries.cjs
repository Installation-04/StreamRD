const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

module.exports = async function automaticLibraries({ product, page, url, api, admin, member, call, shot, noOverflow, report }) {
  const sr = product === 'streamrd';
  const backend = process.env[sr ? 'QA_STREAMRD_BACKEND' : 'QA_PHOSPHOR_BACKEND'];
  assert.match(backend ?? '', /^[a-z0-9-]+$/, 'Use the disposable browser runner');
  function requests(kind) {
    const file = kind === 'metadata' ? '/app/data/metadata-provider-requests.jsonl' : '/app/data/account-provider-requests.jsonl';
    const code = `const fs=require('node:fs');process.stdout.write(fs.existsSync(${JSON.stringify(file)})?fs.readFileSync(${JSON.stringify(file)},'utf8'):'')`;
    return execFileSync('docker', ['exec', backend, 'node', '-e', code], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  async function poll(read, ready, label) {
    for (let attempt = 0; attempt < 160; attempt++) {
      const value = await read(); if (ready(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw Error(`${product}: timed out waiting for ${label}`);
  }
  const initialMetadataRequests = requests('metadata').length;
  await page.goto(`${url}/admin/metadata`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Make every title feel complete.', exact: true }).waitFor();
  assert.equal(requests('metadata').length, initialMetadataRequests, 'Opening settings must not contact metadata providers');
  const tmdb = page.getByLabel('TMDB API key or read access token', { exact: true }), omdb = page.getByLabel('OMDb API key', { exact: true });
  await tmdb.fill('metadata-fixture-only'); await omdb.fill('metadata-fixture-only');
  await page.getByRole('button', { name: 'Save metadata settings', exact: true }).click();
  await poll(() => call(api, '/api/admin/metadata/settings', null, admin.token), result => result.settings.tmdbConfigured && result.settings.omdbConfigured, 'saved metadata settings');
  await page.getByText('Settings saved. Provider keys remain on the server. Saving does not test the connection.', { exact: true }).waitFor();
  assert.equal(await tmdb.inputValue(), ''); assert.equal(await omdb.inputValue(), '');
  assert.equal(requests('metadata').length, initialMetadataRequests, 'Saving keys must not imply a connection test');
  await page.getByRole('button', { name: 'Test connection', exact: true }).nth(0).click();
  await page.getByText('TMDB responded successfully to an explicit connection test.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Test connection', exact: true }).nth(1).click();
  await page.getByText('OMDb / IMDb responded successfully to an explicit connection test.', { exact: true }).waitFor();
  assert.ok(requests('metadata').length >= initialMetadataRequests + 2);
  const logo = await page.request.get(`${url}/metadata/tmdb.svg`); assert.equal(logo.status(), 200); assert.ok((await logo.text()).includes('viewBox'));
  report.journeys.push(`${product}: private metadata settings, explicit provider tests and local attribution asset`);

  const original = (await call(api, '/api/admin/library', null, admin.token)).entries[0];
  await page.getByRole('button', { name: 'Scan mounted library', exact: true }).click();
  await poll(() => call(api, `/api/admin/metadata/records/library/${original.id}`, null, admin.token), result => result.record?.status === 'matched', 'manual scan while automation is disabled');
  let sintel;
  if (sr) {
    await page.getByRole('button', { name: 'Scan catalog', exact: true }).click();
    sintel = (await call(api, '/api/admin/catalog', null, admin.token)).titles.find(title => title.name === 'Sintel');
    assert.ok(sintel);
    await poll(() => call(api, `/api/catalog/title/${sintel.id}`, null, admin.token), result => result.title.metadata?.imdbId === 'tt1727587', 'catalog enrichment');
  }
  await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
  const lockName = sr ? 'Sintel' : 'Big Buck Bunny', lockType = sr ? 'catalog' : 'library', lockId = sr ? sintel.id : original.id;
  await page.getByRole('button', { name: `Field locks for ${lockName}`, exact: true }).click();
  await page.getByRole('region', { name: `Field locks for ${lockName}`, exact: true }).getByRole('checkbox', { name: 'Overview', exact: true }).check();
  await page.getByRole('button', { name: 'Save field locks', exact: true }).click();
  await poll(() => call(api, `/api/admin/metadata/records/${lockType}/${lockId}`, null, admin.token), result => result.record?.lockedFields.includes('description'), 'saved field locks');
  await page.getByLabel('Enable automatic metadata matching', { exact: true }).check();
  await page.getByRole('button', { name: 'Save metadata settings', exact: true }).click();
  await poll(() => call(api, '/api/admin/metadata/settings', null, admin.token), result => result.settings.automatic, 'automatic metadata opt-in');
  await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
  await noOverflow('desktop metadata'); await shot('metadata');
  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow('mobile metadata'); await shot('metadata-mobile'); await page.setViewportSize({ width: 1440, height: 1050 });
  if (sr) {
    await page.goto(`${url}/title/${sintel.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('region', { name: 'Movie and series metadata' }).waitFor(); await page.getByRole('link', { name: 'View on IMDb', exact: false }).waitFor();
    assert.ok((await page.locator('main').innerText()).includes('Demo performer'));
    await noOverflow('desktop enriched title'); await shot('title-metadata');
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow('mobile enriched title'); await shot('title-metadata-mobile'); await page.setViewportSize({ width: 1440, height: 1050 });
  }
  await page.goto(`${url}/admin/library`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Fix metadata match for Big Buck Bunny', exact: true }).click();
  await page.getByRole('combobox', { name: /^Provider/ }).selectOption('omdb');
  await page.getByRole('button', { name: 'Search metadata', exact: true }).click();
  await page.getByRole('button', { name: 'Preview Big Buck Bunny (2008)', exact: true }).click();
  await page.getByRole('region', { name: 'Metadata preview' }).waitFor();
  await page.getByRole('button', { name: 'Use this match', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Metadata saved for this web library entry.' }).waitFor();
  const enriched = (await call(api, '/api/admin/library', null, admin.token)).entries.find(entry => entry.id === original.id);
  assert.equal(enriched.libraryPath, original.libraryPath); assert.equal(enriched.media.sourcePath, original.media.sourcePath); assert.equal(enriched.metadata.provider, 'omdb');
  await noOverflow('enriched mounted library'); await shot('library-metadata');
  report.journeys.push(`${product}: real queued metadata worker and reviewed OMDb correction preserve mounted exports`);

  await page.goto(`${url}/account/debrid`, { waitUntil: 'networkidle' });
  await page.locator('#debrid-key-realdebrid').fill('account-fixture-only');
  await page.getByLabel('Automatically scan existing torrents after connecting', { exact: true }).check();
  await page.getByRole('button', { name: /^save$/i }).click();
  await poll(() => call(api, '/api/account/library/scans', null, admin.token), result => result.providers.some(provider => provider.provider === 'realdebrid' && ['queued', 'scanning', 'complete'].includes(provider.status)), 'on-connect account scan');
  await page.waitForFunction(() => document.querySelector('#debrid-key-realdebrid')?.value === '');
  await page.goto(`${url}/setup`, { waitUntil: 'networkidle' });
  await page.getByRole('region', { name: 'Your account library scan' }).waitFor();
  await noOverflow('onboarding scanner'); await shot('setup-scan');
  await poll(() => call(api, '/api/account/library/scans', null, admin.token), result => result.providers.some(provider => provider.provider === 'realdebrid' && provider.status === 'complete'), 'all account pages');
  const imports = await call(api, '/api/account/library', null, admin.token); assert.equal(imports.total, 2);
  assert.ok(imports.items.every(item => !('providerRef' in item) && !('credentialFingerprint' in item) && !('userId' in item)));
  assert.ok(requests('account').every(request => request.method === 'GET'), 'Onboarding must only read the existing provider account');
  const privateTitle = imports.items.find(item => item.name === 'Sintel'); assert.ok(privateTitle);
  await poll(() => call(api, `/api/account/library/${privateTitle.id}`, null, admin.token), result => result.item.metadata?.imdbId === 'tt1727587', 'imported title metadata');
  const globalActivity = await call(api, '/api/admin/metadata/records', null, admin.token); assert.ok(globalActivity.records.every(record => record.targetType !== 'account'));
  execFileSync('docker', ['exec', backend, 'node', '-e', 'require("node:fs").writeFileSync("/app/data/metadata-qa-override.json",JSON.stringify({rating:8.1,delayMs:2000}),{mode:0o600})']);
  await call(api, `/api/account/library/${privateTitle.id}/metadata/refresh`, {}, admin.token);
  await page.goto(`${url}/library`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'My library.', exact: true }).waitFor(); await page.getByRole('link', { name: 'Open Sintel', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Open Sintel', exact: true }).getByText('★ 8.1', { exact: false }).waitFor();
  execFileSync('docker', ['exec', backend, 'node', '-e', 'require("node:fs").unlinkSync("/app/data/metadata-qa-override.json")']);
  await noOverflow('private gallery desktop'); await shot('account-library');
  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow('private gallery mobile'); await shot('account-library-mobile'); await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole('searchbox', { name: 'Search my library', exact: true }).fill('Sintel'); await page.getByRole('link', { name: 'Open Sintel', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Open Sintel', exact: true }).click(); await page.getByRole('button', { name: '▶ Play from my account', exact: true }).waitFor();
  assert.ok(requests('account').every(request => request.method === 'GET'), 'Opening imported details must not resolve stream links');
  await noOverflow('private title desktop'); await shot('account-title');
  await page.route('https://example.invalid/qa-account-video.mp4', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: fs.readFileSync(path.join(__dirname, 'fixtures/account-video.mp4')) }));
  await page.getByRole('button', { name: '▶ Play from my account', exact: true }).click();
  await page.getByRole('heading', { name: 'This torrent has more than one video.', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /readme\.nfo/ }).count(), 0);
  await page.getByRole('button', { name: /Sintel\.2010\.mp4/ }).click();
  await page.locator('video').waitFor(); await page.waitForFunction(() => { const video = document.querySelector('video'); return video && video.currentTime > 0; });
  await page.getByRole('button', { name: 'Close player', exact: true }).click();
  assert.ok(requests('account').some(request => request.method === 'POST' && request.path.endsWith('/unrestrict/link')));
  assert.ok(requests('account').every(request => request.method === 'GET' || request.path.endsWith('/unrestrict/link')), 'No torrent may be created, selected or deleted');
  const privateResponse = await fetch(`http://127.0.0.1:${api}/api/account/library/${privateTitle.id}`, { headers: { Authorization: `Bearer ${member.token}` } }); assert.equal(privateResponse.status, 404);
  const memberLibrary = await call(api, '/api/account/library', null, member.token); assert.equal(memberLibrary.total, 0);
  await call(api, '/api/account/library/scan', { provider: 'realdebrid', force: true }, admin.token);
  await poll(() => call(api, '/api/account/library/scans', null, admin.token), result => result.providers.some(provider => provider.provider === 'realdebrid' && provider.status === 'complete'), 'idempotent account rescan');
  assert.equal((await call(api, '/api/account/library', null, admin.token)).total, 2);
  report.journeys.push(`${product}: on-connect read-only account scan, automatic metadata, private gallery, file choice and synthetic video playback`);
};
