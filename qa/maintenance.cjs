const assert = require('node:assert/strict');
const path = require('node:path');

// Admin → System: updates panel and backup/restore. Never restarts the disposable container.
module.exports = async function maintenance({ product, page, url, api, admin, call, shot, noOverflow, report }) {
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto(`${url}/admin/system`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Updates', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Backups & restore', exact: true }).waitFor();
  await page.getByText('Installed', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Update to v/ }).count(), 0, 'No one-click update without a configured hook');
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).waitFor();

  const before = (await call(api, '/api/admin/system/maintenance', null, admin.token)).backups.length;
  await page.getByRole('button', { name: 'Create backup', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Backup created and verified.' }).waitFor();
  const list = page.getByRole('list', { name: 'Database backups' });
  await list.getByRole('listitem').first().waitFor();
  const backups = (await call(api, '/api/admin/system/maintenance', null, admin.token)).backups;
  assert.equal(backups.length, before + 1);
  const name = backups[0].name;
  assert.match(name, /^manual-.*\.db$/);
  await page.getByRole('button', { name: `Verify ${name}`, exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'passed its integrity check' }).waitFor();

  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: `Download ${name}`, exact: true }).click();
  assert.equal((await downloaded).suggestedFilename(), name);

  await page.getByRole('button', { name: `Restore ${name}`, exact: true }).click();
  const confirm = page.getByRole('button', { name: /^(Stage restore|Restore and restart)$/ });
  assert.equal(await confirm.isDisabled(), true, 'Restore needs the typed confirmation');
  await page.getByLabel('Type RESTORE to confirm').fill('RESTORE');
  assert.equal(await confirm.isDisabled(), false);
  await noOverflow('desktop system maintenance'); await shot('system-maintenance');
  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow('mobile system maintenance');
  // The shared helper resets scroll to the top; capture the new panels themselves on mobile.
  for (const [heading, file] of [['update-heading', 'system-updates-mobile'], ['backup-restore-heading', 'system-maintenance-mobile']]) {
    const filename = `${product}-${file}.png`;
    await page.locator(`section[aria-labelledby="${heading}"]`).screenshot({ path: path.join(process.env.QA_ARTIFACT_DIR, filename), animations: 'disabled' });
    report.screenshots.push(filename);
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  // Cancel rather than stage: the disposable service must keep running for the remaining journeys.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await call(api, '/api/admin/system/maintenance', null, admin.token)).pendingRestore, null);

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Backup deleted.' }).waitFor();
  assert.equal((await call(api, '/api/admin/system/maintenance', null, admin.token)).backups.length, before);
  report.journeys.push(`${product}: admin update check, verified backup create/verify/download, typed restore confirmation and delete`);

  // Logs: search, copy, download.
  await page.goto(`${url}/admin/logs`, { waitUntil: 'networkidle' });
  await page.getByRole('searchbox', { name: 'Search log messages' }).waitFor();
  const shown = Number((await page.getByRole('status').filter({ hasText: /entries shown/ }).first().innerText()).match(/(\d+) entries shown/)[1]);
  assert.ok(shown > 0, 'The log should contain the QA run so far');
  await page.getByRole('searchbox', { name: 'Search log messages' }).fill('no-such-message-xyz');
  await page.getByText('No entries match these filters.').waitFor();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByRole('button', { name: /^Copy shown \(\d+\)$/ }).click();
  await page.getByRole('status').filter({ hasText: /^(Copied|Your browser blocked copying)/ }).waitFor();
  const logDownload = page.waitForEvent('download');
  await page.getByLabel('Download format').selectOption('ndjson');
  assert.match((await logDownload).suggestedFilename(), /^(streamrd|phosphor)-logs-.*\.ndjson$/);
  await noOverflow('desktop logs'); await shot('logs');
  report.journeys.push(`${product}: admin logs search, copy and download`);

  // The signed-in user's library: matching progress panel (and, for StreamRD, the dashboard row).
  await page.goto(`${url}/library`, { waitUntil: 'networkidle' });
  await page.getByRole('region', { name: 'Metadata matching progress' }).waitFor();
  await page.getByRole('button', { name: 'Check my library for non-movie titles' }).click();
  await page.getByText('Nothing to remove: every title looks like a movie or show.').waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await noOverflow('desktop library match status'); await shot('library-match-status');
  if (product === 'streamrd') {
    await page.goto(`${url}/`, { waitUntil: 'networkidle' });
    await page.getByRole('region', { name: 'New in your libraries' }).waitFor();
    await noOverflow('desktop dashboard library row'); await shot('dashboard-library-row');
  }
  report.journeys.push(`${product}: library matching progress${product === 'streamrd' ? ' and dashboard library row' : ''}`);
};
