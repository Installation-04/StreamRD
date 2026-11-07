# Community browser journeys

These tests exercise actual production web/API images against new disposable
containers and SQLite volumes. They never reuse an installation or contact real
providers. The Phosphor search feed and filesystem videos are explicitly dummy
fixtures; screenshots do not establish real debrid playback.

From the repository root, first build the corresponding `streamrd-server`,
`streamrd-web`, `phosphor-server`, and `phosphor-web` images. Then:

```bash
npm ci --prefix qa
cd qa && npx playwright install --with-deps chromium && cd ..
bash infra/run-browser-qa.sh both
# Or choose streamrd / phosphor to test only one pair of images.
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an installed Chromium executable if
needed. Set `QA_ARTIFACT_DIR` to an absolute directory for screenshots and the JSON
validation report. The runner refuses occupied ports and missing images, creates
only fresh volumes, and removes only its own containers/volumes on exit.

Coverage includes read-only System readiness and migration counts on desktop/mobile,
actual UI login, member/admin separation, private guided setup,
mounted-file browsing, reviewed movie/episode exports, repair, export search and
removal, catalog favorites/search, local Torznab and saved-search flows, queue
loading/error recovery, desktop/mobile overflow, and browser page errors. This is
workflow coverage, not a complete WCAG audit, native-client test, or live-provider
validation. The separate backend filesystem suite verifies original preservation,
collisions, mount outages, and path confinement.

The automatic-library journeys also exercise server-only metadata settings,
background account scans, private matching and synthetic-video playback. The
server-sharing journeys create an email-bound one-use invitation through the UI,
accept its fragment link in a fresh browser context, grant a named server library,
and play without personal debrid credentials. They verify source-private isolation,
access removal and administrative session revocation, then restore open signup and
remove their shared-library fixture. Provider HTTP transport is intercepted only
inside disposable QA volumes; these checks do not establish live-account playback.

CI pins the browser/Docker jobs to Ubuntu 24.04, which supports the pinned
Playwright 1.57.0 browser packages. Do not switch those jobs to a newer runner OS
until its browser support has been verified.
