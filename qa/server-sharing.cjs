const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Requires the fresh production containers and read-only provider fixtures from
// infra/run-browser-qa.sh. Invite secrets remain in memory and never enter reports.
module.exports = async function serverSharing({ product, page, url, api, admin, member, call, shot, noOverflow, report }) {
  const browser = page.context().browser();
  assert.ok(browser, 'A real browser context is required');
  const viewerEmail = 'invited-viewer@example.invalid';
  const viewerPassword = 'invited-viewer-fixture-password123';
  const libraryName = 'Community cinema';
  const cookieName = product === 'streamrd' ? 'sr_token' : 'ph_token';
  const viewerContext = await browser.newContext({ viewport: { width: 1440, height: 1050 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  const viewer = await viewerContext.newPage();
  viewer.on('pageerror', error => report.pageErrors.push({ product, message: error.message }));
  const output = process.env.QA_ARTIFACT_DIR;
  let libraryId, invitationToken, viewerToken, viewerUser;
  const navigationUrls = [];
  viewer.on('request', request => navigationUrls.push(request.url()));
  async function responseStatus(route, token, method = 'GET', data) {
    const result = await fetch(`http://127.0.0.1:${api}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return result.status;
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
  async function policy(mode) {
    await page.goto(`${url}/admin/users`, { waitUntil: 'networkidle' });
    await page.getByRole('combobox', { name: 'New account registration', exact: true }).selectOption(mode);
    await page.getByRole('button', { name: 'Save registration policy', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /^Saved:/ }).waitFor();
    assert.equal((await call(api, '/api/admin/access', null, admin.token)).mode, mode);
  }
  try {
    await policy('invite');
    // No invitation means no signup form, even if the public URL is known.
    await viewer.goto(`${url}/signup`, { waitUntil: 'networkidle' });
    await viewer.getByText('An invitation is required', { exact: true }).waitFor();
    assert.equal(await viewer.getByLabel('Display name', { exact: true }).count(), 0);
    assert.equal(await responseStatus('/api/auth/signup', null, 'POST', { email: 'uninvited@example.invalid', displayName: 'Uninvited', password: viewerPassword }), 403);

    await page.getByLabel('Invitation email', { exact: true }).fill(viewerEmail);
    const invitationResponse = page.waitForResponse(response => response.url().endsWith('/api/admin/invitations') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
    const issued = await (await invitationResponse).json();
    invitationToken = issued.inviteToken;
    assert.match(invitationToken, /^[A-Za-z0-9_-]{43}$/);
    const inviteLink = await page.getByLabel('Private invitation link', { exact: true }).inputValue();
    assert.equal(inviteLink, `${url}/signup#invite=${invitationToken}`);
    // A fresh list response and page refresh must not reveal the one-time secret.
    const invitationList = await call(api, '/api/admin/invitations', null, admin.token);
    assert.ok(!JSON.stringify(invitationList).includes(invitationToken));
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText(viewerEmail, { exact: true }).waitFor();
    await noOverflow('desktop server access'); await shot('server-access');
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow('mobile server access'); await shot('server-access-mobile');
    await page.setViewportSize({ width: 1440, height: 1050 });

    await viewer.goto(inviteLink, { waitUntil: 'networkidle' });
    await viewer.getByLabel('Display name', { exact: true }).waitFor();
    assert.equal(await viewer.getByLabel('Email', { exact: true }).inputValue(), viewerEmail);
    assert.equal(new URL(viewer.url()).hash, '', 'Invitation token must be removed from the address bar');
    assert.ok(navigationUrls.every(value => !value.includes(invitationToken)), 'Invitation must not enter request URLs');
    await viewer.getByLabel('Display name', { exact: true }).fill('Invited viewer');
    await viewer.getByLabel(/^Password/).fill(viewerPassword);
    const signupResponse = viewer.waitForResponse(response => response.url().endsWith('/api/auth/signup') && response.request().method() === 'POST');
    await viewer.getByRole('button', { name: /accept invitation/i }).click();
    const signup = await (await signupResponse).json();
    viewerUser = signup.user; viewerToken = signup.token;
    assert.ok(viewerUser?.id && viewerToken);
    await viewer.waitForURL(/\/shared-libraries$/);
    await viewer.getByRole('heading', { name: 'No libraries shared yet.', exact: true }).waitFor();
    assert.ok((await viewerContext.cookies()).some(cookie => cookie.name === cookieName && cookie.value === viewerToken));
    assert.equal((await call(api, '/api/account/library', null, viewerToken)).total, 0);
    const ownSetup = await call(api, '/api/account/setup', null, viewerToken);
    assert.ok(ownSetup.providers.every(provider => !provider.configured), 'Invited viewer must not require personal provider credentials');
    assert.equal(await responseStatus('/api/auth/invitation', null, 'POST', { inviteToken: invitationToken }), 400);
    assert.ok(!await viewer.evaluate(token => JSON.stringify(localStorage).includes(token) || JSON.stringify(sessionStorage).includes(token), invitationToken));
    report.journeys.push(`${product}: real invitation-only signup with one-use email-bound fragment link and private token handling`);

    await page.goto(`${url}/admin/shared-libraries`, { waitUntil: 'networkidle' });
    await page.getByLabel('Library name', { exact: true }).fill(libraryName);
    await page.getByRole('combobox', { name: 'Content type', exact: true }).selectOption('movie');
    const createdResponse = page.waitForResponse(response => response.url().endsWith('/api/admin/shared-libraries') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create library', exact: true }).click();
    const created = await (await createdResponse).json(); libraryId = created.library?.id; assert.ok(libraryId);
    const library = page.getByRole('region', { name: libraryName, exact: true });
    await library.getByRole('combobox', { name: `Add a user to ${libraryName}`, exact: true }).selectOption(viewerUser.id);
    await library.getByRole('button', { name: 'Grant access', exact: true }).click();
    await library.getByRole('button', { name: `Remove access for ${viewerEmail}`, exact: true }).waitFor();
    await noOverflow('desktop shared library administration'); await shot('shared-library-admin');
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow('mobile shared library administration'); await shot('shared-library-admin-mobile'); await page.setViewportSize({ width: 1440, height: 1050 });
    const shared = await call(api, '/api/shared-libraries', null, viewerToken);
    assert.deepEqual(shared.libraries.map(entry => entry.id), [libraryId]);
    assert.ok(!JSON.stringify(shared).match(/sourceUserId|credentialFingerprint|providerRef|account-fixture-only/));
    assert.equal((await call(api, '/api/shared-libraries', null, member.token)).libraries.length, 0);
    assert.equal(await responseStatus(`/api/shared-libraries/${libraryId}/items`, member.token), 404);
    const source = await call(api, '/api/account/library', null, admin.token);
    const sintel = source.items.find(item => item.name === 'Sintel'); assert.ok(sintel);
    assert.equal(await responseStatus(`/api/account/library/${sintel.id}`, viewerToken), 404, 'Publishing does not expose the source private API');
    const readySetup = await call(api, '/api/account/setup', null, viewerToken);
    assert.equal(readySetup.configurationReady, true, 'A ready granted server library should satisfy onboarding without viewer keys');

    await viewer.goto(`${url}/setup`, { waitUntil: 'networkidle' });
    await viewer.getByRole('heading', { name: 'Your essentials are configured.', exact: true }).waitFor();
    assert.equal(await viewer.getByRole('region', { name: 'Your account library scan', exact: true }).count(), 0, 'Shared viewers should not be prompted to connect personal providers');
    await viewer.goto(`${url}/shared-libraries`, { waitUntil: 'networkidle' });
    await viewer.getByRole('link', { name: `Open library ${libraryName}`, exact: true }).click();
    await viewer.getByRole('link', { name: 'Open Sintel', exact: true }).waitFor();
    await viewerNoOverflow('desktop shared library'); await viewerShot('shared-library');
    await viewer.setViewportSize({ width: 390, height: 844 }); await viewerNoOverflow('mobile shared library'); await viewerShot('shared-library-mobile'); await viewer.setViewportSize({ width: 1440, height: 1050 });
    await viewer.getByRole('searchbox', { name: 'Search shared library', exact: true }).fill('Sintel');
    await viewer.getByRole('link', { name: 'Open Sintel', exact: true }).click();
    await viewer.getByRole('button', { name: 'Play from server', exact: true }).waitFor();
    await viewerNoOverflow('desktop shared title'); await viewerShot('shared-title');
    await viewer.route('https://example.invalid/qa-account-video.mp4', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: fs.readFileSync(path.join(__dirname, 'fixtures/account-video.mp4')) }));
    await viewer.getByRole('button', { name: 'Play from server', exact: true }).click();
    await viewer.getByRole('heading', { name: 'This torrent has more than one video.', exact: true }).waitFor();
    if (product === 'streamrd') { await viewerNoOverflow('desktop player chooser'); await viewerShot('player-choose'); }
    assert.equal(await viewer.getByRole('button', { name: /readme\.nfo/ }).count(), 0);
    await viewer.getByRole('button', { name: /Sintel\.2010\.mp4/ }).click();
    await viewer.locator('video').waitFor();
    // Pause as soon as playback starts: the synthetic clip is one second long and must not finish.
    // Pausing mid-clip must persist this viewer's position without exposing any stream data.
    await viewer.waitForFunction(() => { const video = document.querySelector('video'); if (video && video.currentTime > 0 && !video.paused) { video.pause(); return true; } return false; }, null, { polling: 'raf' });
    if (product === 'streamrd') { await viewerNoOverflow('desktop player'); await viewerShot('player'); }
    await viewer.getByRole('button', { name: 'Close player', exact: true }).click();
    // Watch progress is implemented for StreamRD shared libraries only; Phosphor keeps its v0.6.0 behavior.
    if (product === 'streamrd') {
    let resumed;
    for (let attempt = 0; attempt < 20 && !resumed; attempt++) {
      resumed = (await call(api, '/api/shared-libraries/continue', null, viewerToken)).items[0];
      if (!resumed) await new Promise(done => setTimeout(done, 250));
    }
    assert.ok(resumed && resumed.positionSeconds > 0 && resumed.libraryId === libraryId && resumed.item.id === sintel.id, 'Paused playback should create a Continue watching entry');
    assert.doesNotMatch(JSON.stringify(resumed), /example\.invalid|private/i, 'Continue watching must not expose provider links or references');
    assert.equal((await call(api, '/api/shared-libraries/continue', null, admin.token)).items.length, 0, 'Progress is per viewer');
    await viewer.goto(`${url}/shared-libraries`, { waitUntil: 'networkidle' });
    await viewer.getByRole('link', { name: 'Continue watching Sintel', exact: true }).waitFor();
    await viewerNoOverflow('desktop continue watching'); await viewerShot('shared-continue-watching');
    await viewer.setViewportSize({ width: 390, height: 844 }); await viewerNoOverflow('mobile continue watching'); await viewerShot('shared-continue-watching-mobile'); await viewer.setViewportSize({ width: 1440, height: 1050 });
    const again = await fetch(`http://127.0.0.1:${api}/api/shared-libraries/${libraryId}/items/${sintel.id}/play`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerToken}` }, body: JSON.stringify({ fileToken: undefined }) });
    const resumeBody = await again.json();
    if (resumeBody.stream) assert.ok(resumeBody.resumeSeconds > 0, 'Playing again should resume at the saved position');
    report.journeys.push(`${product}: shared-library watch progress, per-viewer Continue watching and resume`);
    }
    report.journeys.push(`${product}: named server library grant, no-key onboarding, private-source isolation, file choice and synthetic-video playback`);

    // Invitations that carry libraries and a viewing limit, the title rating an administrator sets, and what a limited account sees.
    await page.goto(`${url}/admin/users`, { waitUntil: 'networkidle' });
    const guestEmail = 'second-guest@example.invalid';
    await page.getByLabel('Invitation email', { exact: true }).fill(guestEmail);
    assert.equal(await page.getByRole('checkbox', { name: libraryName, exact: true }).isChecked(), true, 'The invitation form should offer the library, ticked by default');
    await page.getByLabel('Viewing limit', { exact: true }).selectOption('7');
    const guestIssued = page.waitForResponse(response => response.url().endsWith('/api/admin/invitations') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
    const guestInvitation = await (await guestIssued).json();
    assert.ok(guestInvitation.invitation.libraryIds.includes(libraryId)); assert.equal(guestInvitation.invitation.maxAge, 7);
    await page.getByLabel('Private invitation link', { exact: true }).waitFor();
    await noOverflow('desktop invitation with access'); await shot('invite-access');
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    try {
      const guest = await guestContext.newPage();
      await guest.goto(`${url}/signup#invite=${guestInvitation.inviteToken}`, { waitUntil: 'networkidle' });
      await guest.getByText(`You will be able to watch: ${libraryName}`, { exact: false }).waitFor();
      await guest.screenshot({ path: path.join(output, `${product}-signup-invited.png`), animations: 'disabled' }); report.screenshots.push(`${product}-signup-invited.png`);
    } finally { await guestContext.close(); }
    // A limited account: an administrator sets the limit in Users and rates the title; the limited viewer then sees only rated titles.
    assert.equal(await responseStatus(`/api/shared-libraries/${libraryId}/items/${sintel.id}`, viewerToken), 200);
    await page.reload({ waitUntil: 'networkidle' });
    const limitResponse = page.waitForResponse(response => response.url().includes(`/api/admin/users/${viewerUser.id}`) && response.request().method() === 'PATCH');
    await page.getByRole('combobox', { name: 'Viewing limit for Invited viewer', exact: true }).selectOption('7');
    assert.equal((await limitResponse).status(), 200);
    await noOverflow('desktop viewing limits'); await shot('viewing-limits');
    assert.equal(await responseStatus(`/api/shared-libraries/${libraryId}/items/${sintel.id}`, viewerToken), 404, 'An unrated title must be hidden from a limited account');
    await page.goto(`${url}/shared-libraries/${libraryId}/${sintel.id}`, { waitUntil: 'networkidle' });
    const rated = page.waitForResponse(response => response.url().includes('/rating') && response.request().method() === 'PUT');
    await page.getByRole('combobox', { name: 'Age rating', exact: true }).selectOption('G');
    assert.equal((await rated).status(), 200);
    await page.getByRole('combobox', { name: 'Age rating', exact: true }).waitFor();
    await noOverflow('desktop title rating'); await shot('title-rating');
    await viewer.goto(`${url}/shared-libraries/${libraryId}`, { waitUntil: 'networkidle' });
    await viewer.getByRole('link', { name: 'Open Sintel', exact: true }).waitFor();
    assert.equal(await viewer.getByRole('link', { name: 'Find media', exact: true }).count(), 0, 'A limited account should not be offered discovery');
    assert.equal(await responseStatus('/api/discovery/search?q=Sintel&type=movie', viewerToken), 403);
    await viewerNoOverflow('desktop limited account library'); await viewerShot('kids-library');
    await call(api, `/api/admin/users/${viewerUser.id}`, { maxAge: null }, admin.token, 'PATCH');
    assert.equal(await responseStatus(`/api/shared-libraries/${libraryId}/items/${sintel.id}`, viewerToken), 200, 'Removing the limit applies at once');
    report.journeys.push(`${product}: invitation carrying libraries and a viewing limit, signup preview, administrator title rating, limited account view`);

    const revokedResponse = page.waitForResponse(response => response.url().endsWith(`/api/admin/shared-libraries/${libraryId}/users/${viewerUser.id}`) && response.request().method() === 'DELETE');
    await library.getByRole('button', { name: `Remove access for ${viewerEmail}`, exact: true }).click();
    assert.equal((await revokedResponse).status(), 200);
    assert.equal((await call(api, '/api/shared-libraries', null, viewerToken)).libraries.length, 0);
    assert.equal(await responseStatus(`/api/shared-libraries/${libraryId}/items/${sintel.id}`, viewerToken), 404);
    assert.equal(await responseStatus(`/api/shared-libraries/${libraryId}/items/${sintel.id}/play`, viewerToken, 'POST', {}), 404);
    await page.goto(`${url}/admin/users`, { waitUntil: 'networkidle' });
    const viewerRow = page.locator('article').filter({ hasText: viewerEmail }).filter({ has: page.getByRole('button', { name: 'Sign out all devices', exact: true }) });
    page.once('dialog', dialog => dialog.accept());
    await viewerRow.getByRole('button', { name: 'Sign out all devices', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'has been signed out on all devices' }).waitFor();
    assert.equal(await responseStatus('/api/shared-libraries', viewerToken), 401);
    assert.equal((await call(api, '/api/account/library', null, admin.token)).total, 2);
    report.journeys.push(`${product}: server-library access removal blocks detail/play immediately and administrator revokes viewer sessions`);
    await policy('open');
  } catch (error) {
    await viewer.screenshot({ path: path.join(output, `${product}-sharing-failure.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    // Leave the original catalog/private-library/member journeys unaffected.
    if (libraryId) await call(api, `/api/admin/shared-libraries/${libraryId}`, null, admin.token, 'DELETE');
    await call(api, '/api/admin/access', { mode: 'open' }, admin.token, 'PUT');
    await viewerContext.close();
  }
};
