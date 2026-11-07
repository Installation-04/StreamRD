# Automatic Libraries validation — v0.5.0

The backend suites contain **550 tests**: 304 StreamRD and 246 Phosphor. Local full
suites and focused final checks passed; both GitHub pipelines gate the annotated
release commit. All four package type checks and final production image builds
passed.

## Provider protocols and metadata

Tests cover TMDB/OMDb search, movie/series details, IMDb-ID lookup, source-labeled
ratings, safe artwork and external links, private credentials, explicit tests,
atomic concurrent settings updates, normalized responses, bounded caches and
duplicate-request sharing. Timeouts, streamed response limits, authentication,
quota errors and bounded concurrency have separate regressions.

Automation cases cover confident/ambiguous/unmatched results, manual scans with
automation disabled, automatic opt-out, retained terminal retry budgets, provider
cooldown/key rotation, leases, stale revisions, deleted/deactivated owners and
configuration changes during network requests. Catalog cases verify pinned draft
selection, source preservation, explicit field ownership, manual clears, concurrent
edits and identity review. Private metadata is owner-bound, omitted from shared
activity and cascaded on user deletion.

## Existing account imports

Provider cases exercise Real-Debrid pagination, AllDebrid lists, Premiumize cloud
traversal and Phosphor Torbox, including response/cursor limits and repeated-page
guards. Play-time cases cover video filtering, opaque choices, pending transfers,
direct cloud links, wrong IDs, changed tokens and safe errors.

Scanner tests verify no upstream requests in credential saves or status/setup GETs,
durable pages and duplicate refs, account isolation, scoped cursors, cancellation,
key changes, opt-out and deactivation during requests. Restart leases, bounded
retries, manual metadata preservation, old credential bindings, safe play errors
and owner-only content readiness are tested. Known non-video files are skipped.

## Migrations and production containers

Both disposable container smoke checks passed: non-root/pruned runtimes, fresh
migrations, restart persistence, verified snapshots/restoration, mounted exports
and populated historical adoption. The old fixture is seeded through its actual
historical columns, so the new auto-import column is not assumed before migration.
The pre-adoption snapshot contains the original user and no migration history.

A stale Phosphor checkpoint found in combined validation was regenerated from
reviewed SQL. The generator now reopens its inspection connection after each
external DDL prefix to avoid cached SQLite introspection. Released v0.4 checkpoint
entries and historical fixtures were compared and remain unchanged. Both fresh
generators/checks and upgrade/System regressions passed afterward.

## Production browser checks

**20 journeys passed, with 36 screenshots and no page errors.** The
[report](screenshots/v0.5.0/validation.json) lists exact journeys and files. Real
web/API images use fresh disposable volumes, test-only provider transport fixtures
and no real credentials. Checks include preserved mounted paths, saved field
locks, automatic onboarding imports, card metadata refresh without page reload,
cross-account denial, explicit file choice, actual synthetic-video playback and
duplicate-free rescans. Desktop/mobile document widths are checked for overflow.

The first new browser run exposed an overly exact provider-dropdown selector;
the locator was corrected and the complete final run passed. The runner cleans up
only its own containers/volumes. Screenshot and video provenance is documented
[here](screenshots/v0.5.0/README.md).

## Practical limits

No live-provider authentication, account scan, provider quota, matching-quality or
real debrid playback claim is made without operator keys. Browser compatibility
depends on codecs/container; there is no transcoder. Native clients and production
load measurements remain separate work.

Prior [Plex/Jellyfin scanner evidence](media-library-validation.md) remains the
compatibility baseline; mounted export layouts are unchanged. Automatic mapping
from provider references to local mounts is not included. A live Notion page still
requires workspace access; repository tracking and import bundles are maintained.
