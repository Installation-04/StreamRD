# Community Edition validation — v0.3.0

## Backend regression evidence

**278 tests passed:** 166 StreamRD across 17 files and 112 Phosphor across 14 files.
Both server type checks passed. The 22 added tests cover directory browsing,
private setup guidance, and reviewed export batches in both products.

Filesystem cases include deterministic pages, directory-scoped cursors, hidden and
unsupported entries, escaping symlinks, parent traversal, invalid page sizes,
filename suggestions, partial batch successes, collisions, idempotent retries,
source preservation, and admin-only APIs. Setup cases include unauthenticated
access, member/admin actions, credential isolation, disabled providers/indexers,
private/no-store responses, optional mounts, live role changes, and malformed or
empty catalog source records. No upstream requests are made by setup checks.

The initial broad run encountered hook/test timeouts while four Docker builds
contended for resources. Both full suites subsequently passed with lower resource
pressure. A later rebuild hit the environment's disk limit; only rebuildable build
cache and unused old image layers were removed. No app data or backups were pruned.

## Production and browser acceptance

All four final production images built successfully. Both runtime/restart/verified
backup-and-restore smoke checks passed. **All 12 browser journeys passed**, with
**16 screenshots** and **no browser page errors**. All four package type checks
also passed. The [checked-in browser report](screenshots/v0.3.0/validation.json)
records the exact journeys and screenshot filenames.

Production build/runtime and final browser results are recorded in the release's
screenshot/validation assets and the GitHub checks on its exact commit. The browser
runner is [infra/run-browser-qa.sh](../infra/run-browser-qa.sh) and its assertions
are in [qa/product.cjs](../qa/product.cjs). It starts only fresh disposable
containers and volumes, checks occupied ports, and cleans up its own resources.

The expected journeys exercise actual login, guided setup, mounted-file selection,
reviewed movie/episode exports, repair, export search/removal, favorites/catalog
search, local Torznab search and saved searches, queue outage recovery, member
access control, theme changes, and mobile signup into setup. Desktop and 390px
mobile layouts are checked for horizontal overflow; browser page errors fail the
run. A setup progress-label issue found during QA was corrected with an explicit
accessible name.

The gallery uses disposable fictional accounts. Film names refer to Blender open
movies, with intentionally generated geometric fallback posters rather than film
artwork. Filesystem videos are dummy bytes used solely to validate file/export
workflows; they are not playable media. Phosphor's local Torznab feed returns
synthetic sizes/seeders and an example magnet ID. No live indexer/debrid accounts
are queried. The simulated queue outage is a browser response fixture, followed
by recovery against the real API.

## CI host compatibility

The first GitHub run passed server tests and web builds but could not install the
pinned Chromium tooling on the newly updated Ubuntu 26.04 runner. Browser/Docker
jobs now explicitly use supported Ubuntu 24.04; the application runtime remains
Node 22 in its Debian-based images.

## Scope

This is regression/workflow evidence, not a complete accessibility audit,
production-scale load result, native client test, or live provider playback test.
The [v0.2.0 real-scanner evidence](media-library-validation.md) remains the baseline
for Plex/Jellyfin discovery and original-byte reads; scanner naming/manifest format
is unchanged. Optional FUSE/cloud mount behavior depends on the operator's mount.
