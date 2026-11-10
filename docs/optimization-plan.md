# Optimization work

Optimize for a small self-hosted installation first. StreamRD serves an
admin-curated catalog; Phosphor searches Torznab indexers and queues debrid
jobs. Clients play resolved provider URLs directly.

## Implemented first batch

- StreamRD caps source/provider attempts across the whole resolution instead
  of allowing the cap again for each source. The resolution's upstream time
  budget is providerTimeoutMs multiplied by maxPlaybackAttempts. Every provider
  HTTP call, including reading its body, uses the remaining budget. Database
  operations and logging are not covered by this network budget.
- Read server/provider settings once per resolution, deduplicate provider
  order, and stop retrying HTTP 401/403/429 providers during that resolution.
  Provider-specific JSON error codes still need normalization.
- Phosphor coalesces concurrent cache misses for the same search key. Failed
  requests can retry; cache clearing invalidates pending writes from old work.
- Backend test discovery targets source tests rather than compiled copies.
  Test setup explicitly initializes temporary SQLite files for Prisma 5.

## Implemented playback-reference batch

- Persist user-isolated torrent references for 24 hours. Repeated requests poll
  the saved reference rather than adding the magnet again. In-process sharing
  and database leases coordinate concurrent callers/workers. Transient failures
  preserve references; removed references can be recreated. Credentials and signed
  URLs are not stored in this table.
- Preserve the legacy playback response and add pending metadata to its error
  body. Web polls pending work with cancellation and a finite retry count.
- Add integration coverage for restarts, isolation, expiry, concurrent workers,
  transient errors, removed references and the existing playback API.
- The network/provider side effect and local persistence cannot be atomic;
  crashes before persistence may still duplicate adds. Background retention,
  provider-specific error normalization remain open; file selection is covered below.

## Implemented catalog-browsing batch

- Add opt-in compact browse endpoints with bounded title and genre-row pages.
  Keep the existing full-title rows API for mobile/TV compatibility.
- Use timestamp/ID keyset cursors and composite indexes for recent/type rows.
  Genre filtering uses exact SQLite JSON membership without loading sources or
  descriptions. The genre-discovery SQL still scans catalog genre JSON.
- Web home uses load-more controls, duplicate-request guards and cancellation.
- Add cursor/auth/privacy/index regression tests and a reproducible synthetic
  benchmark. See [catalog-benchmark.md](catalog-benchmark.md) for measured results.
- Personal-list pagination is completed below; concurrent-load measurements remain.

## Implemented personal-list batch

- Add compact cursor pages for favorites and distinct viewing history. Legacy
  response shapes remain; legacy history also uses the corrected aggregate.
- Aggregate successful playback logs before limiting so repeated plays of one
  title cannot crowd older titles out of the list. Add account-scoped indexes;
  aggregation still scans an account's successful logs.
- Bound visible-card favorite-status requests to 200 IDs. Web uses paginated
  personal lists, serialized optimistic edits and protection from stale responses.
- Cover privacy, cursor scoping, timestamps, deleted boundaries, empty accounts,
  repeated history, invalid requests and query-plan index selection. Browser
  validation covers pagination and late-status/optimistic-edit behavior.
- Extend the temporary-database benchmark with authenticated personal lists.

## Implemented torrent-file selection batch

- Normalize selected Real-Debrid files, AllDebrid file trees and Premiumize cloud
  file/folder metadata. Premiumize finished torrents now have resolvable links.
- Skip samples/non-video entries for automatic single-video playback; request an
  explicit choice for packs. Choice tokens bind file identity to account/source/
  credentials/reference and do not expose provider links.
- Web supports choosing/changing files, pending retries and a format-error fallback.
  Explicit choices reuse provider references; incompatible containers/codecs do
  not trigger transcoding. Real-Debrid still downloads all selected files.
- Test provider mappings, empty/non-video/sample packs, token scoping and API
  round trips. A local-provider browser check selected E02 then E01 with one add,
  verified no source/key leakage in choices and exercised the format-error UI.
- Legacy clients need a chooser for ambiguous packs. Direct hoster multi-file
  unrestrict responses and live-provider validation remain outside this batch.

## Implemented profile-progress batch

- Opt-in tracked playback creates user/profile/title/media-scoped sessions and
  durable positions without persisting stream URLs. Legacy resolve/history clients
  keep their existing contracts; no positions are inferred from resolution logs.
- Sequence checks and an active-session pointer prevent delayed writes/old players
  from overwriting the current player. Positions resume after reload; at least
  95% complete videos leave the new Continue Watching row.
- Web offers account/profile selection, periodic and event-based saves, metadata
  resume, and progress cards. Favorites remain account-scoped. File packs still
  require selecting the desired episode before resuming its own saved position.
- Ownership/expiry/validation/cascade/pagination and concurrent-update tests cover
  backend behavior. Real-video browser validation saved/resumed at 30 seconds,
  isolated Kids at 60 seconds, showed profile-specific cards and completed the
  120-second fixture at 118 seconds without page errors.
- Additive tables need a schema update. Session retention and first-frame/buffering
  analytics remain; final page-exit delivery is best effort.

## Implemented Phosphor traffic-control batch

- Limit regular indexer search concurrency to four per process, with a bounded
  FIFO queue and queue timeout. Preserve partial results and send Torznab limits.
- Key/coalesce search results by configuration snapshot and exact trimmed query;
  invalidate local results on admin CRUD/imports/server-setting changes.
- Coalesce/bound download refresh work, cache brief user-isolated results, and keep
  jobs active on transient failures so clients can retry. Do not resurrect deletes.
- Web queue cycles refresh three jobs concurrently in rotating batches of twelve,
  back off to sixty seconds, pause while hidden, and serialize manual actions.
- Backend regressions and controlled-clock Chromium fixtures verify these limits,
  invalidation, recovery, cancellation, and visibility behavior. Details are in
  phosphor/docs/traffic-validation.md. No Phosphor schema change is required.

## Implemented authentication/error-hardening batch

- Reject missing/placeholder production signing secrets, generate ephemeral
  development fallbacks, pin JWT algorithms/issuers and validate claims.
- Add durable current-token logout revocation and account version invalidation on
  password change/deactivation. Web keeps the initiating password-change session,
  uses Secure cookies on HTTPS, and retains credentials on transient profile errors.
- Serialize first-admin signup decisions under a SQLite write lock; reserve a
  configured ADMIN_EMAIL role. Email ownership/public bootstrap remains separate.
- Wrap async routes and handle authentication DB errors; central generic JSON and
  request-ID logs avoid raw exception/request data. Malformed cookie/JSON and
  uniqueness conflicts have safe responses.
- Full backend suites and real local browser/API checks pass. A disposable upgrade
  fixture preserves 11 StreamRD and 7 Phosphor tables through SQLite's User rebuild.
  See auth-hardening.md for compatibility and remaining credential/browser work.

## Implemented production runtime batch

- Correct compiled entrypoints, exclude tests from production output, and retain
  only production npm dependencies, including Prisma for database administration.
- Frozen installs in CI and all four Docker builds; non-root Node 22 runtimes;
  explicit web ports and backend readiness dependencies.
- Preserve installer configuration and signing keys on reruns; create private new
  configs and detect old volumes needing an explicit UID 1000 ownership upgrade.
- Verify consistent SQLite snapshots, reject backup overwrites, and prove login
  and application data survive restart and restoration into a new volume.
- Both production container smoke checks pass; 155 StreamRD and 101 Phosphor
  backend tests pass. See [production-runtime.md](production-runtime.md).

## Implemented optional Plex/Jellyfin export

- Both admin interfaces export mounted video files as scanner-compatible movie
  and episode symlinks, with an optional source mount; URL playback remains.
- Persist ownership in a private filesystem manifest, reject traversal/escapes and
  collisions, repair missing links, and remove links without deleting source media.
- Optional Compose overrides and scanner setup are in [plex-jellyfin.md](plex-jellyfin.md).
  Provider-to-mount matching and scanner API integration remain manual.

## Community Edition v0.3.0

- Add role-aware guided setup using private, local-only configuration checks;
  configured services remain explicitly unverified until tested separately.
- Browse mounted directories with scoped cursor pages and bounded retained
  candidates. Review filename hints and export up to 100 files with partial results.
- Refresh both web experiences, with accessible controls and mobile layouts,
  explicit loading/error recovery, and existing account/provider behavior retained.
- Add disposable production browser journeys, screenshots, CI evidence, and a
  community project tracker with a Notion import bundle. Live Notion publication
  is blocked on workspace access; the source tracker records that limitation.
- See [community-validation.md](community-validation.md) and [Project HQ](product/PROJECT-HQ.md).

## Remaining stages and acceptance checks

1. Extend synthetic measurements to concurrent-user load and real browser costs.
   Use production observations to decide whether genre normalization or maintained
   history summaries justify a migration; avoid adding infrastructure by default.
2. Add retention for expired playback sessions/source jobs and old logs with
   backup/restore and cleanup-boundary tests. Keep recoverable references intact.
3. Propagate file choice and profile progress to native clients and Phosphor where
   appropriate. Handle multi-entry direct hoster responses. Real-provider playback
   remains unverified; local fixtures cover supported protocol shapes.
4. Add first-frame, buffering and playback-error analytics without conflating
   successful URL resolution with actual playback. Preserve account/profile scope.
5. Encrypt stored provider credentials with an explicit key/rotation and backup
   strategy. Plan HttpOnly browser sessions/CSRF compatibility, audit business/provider
   log redaction, and consider verified public bootstrap/email ownership separately.
6. Build on the v0.4.0 versioned SQLite migration foundation: keep released SQL
   immutable, add reviewed migration steps and regenerate checkpoint signatures.
   Exact historical/current adoption, pre-change snapshots, drift/history refusal,
   and read-only System readiness are implemented. See [database-upgrades.md](database-upgrades.md).
7. Extract shared provider/API contracts after behavior stabilizes. Keep the two
   product workflows separate; consider distributed traffic coordination only if
   deployments actually require more than one backend process.

Local synthetic catalog benchmarks are recorded in catalog-benchmark.md. No production benchmarks or real-provider playback have been performed.

## Automatic Libraries v0.5.0

Metadata matching now supports TMDB and OMDb, background enrichment, reviewed
corrections, field locks, bounded caches/concurrency and private account targets.
Onboarding imports existing debrid torrents into owner-scoped libraries with
durable paged scans, credential guards and play-time stream resolution. Future
work includes measured scan/load behavior, scoped retention, native-client parity,
optional richer metadata and reviewed provider-to-mount mapping. See
[account library](account-library.md) and [metadata](metadata-automation.md).


## Server-managed access foundation

The `plex-style-access` work adds expiring invitations, configurable registration,
admin session revocation and explicit named sharing of an administrator's imported
account library. Viewer playback uses server credentials, with grant/session/source
checks before and after provider work. Original private imports remain private.
See [users and sharing](server-sharing.md) for contracts and existing catalog limits.

Full Plex Home parity is a separate milestone: managed household users, PIN gates,
enforced maturity/label restrictions across every browse/play route, named sharing
for the legacy curated catalog, device inventories/concurrency controls and watch
progress for shared imports. These require common authorization rather than merely
hiding UI controls. No such restrictions are claimed by the current type filters.

## Measured in v0.10: what is and is not worth optimizing

A code audit suggested three performance items. They were measured before any change (Node 22, one core,
SQLite in WAL mode, the production build of StreamRD with a freshly created database):

| Suspect | Measurement | Decision |
|---|---|---|
| Background workers poll the database every 1.5–2 s even when idle | **0.43 % of one core** over 30 s idle (13 CPU ticks), 82 MB resident | Leave as is. Backing off would add up to several seconds of latency to every new scan, request or match for no measurable saving. |
| The home view loads the whole catalog | With **20,000 titles**: the web app's compact `/api/catalog/browse` answers in 24 ms with 11 KB per page; the legacy `/api/catalog/rows` (kept for API compatibility) takes 58 ms but returns 3.4 MB. | The web app already pages. `/rows` is capped at the newest 2,000 titles since v0.9.1. Its only in-repo consumers (the native apps) were removed, so it can go in a later breaking release. |
| A database lookup on every authenticated request | Typical API calls complete in 5–10 ms in total. | Leave as is. A cache would delay role changes, deactivation and sign-out, which are deliberately immediate. |

Not done, and not recommended without a need: server-rendering the catalog pages (large change, no measured problem) and an
`arm64` image (the publish workflow cannot be exercised before a real tag, so it should be added together with a test release).
Re-measure before optimizing: a library of this size on a small host is dominated by provider and metadata API latency, not by this server.
