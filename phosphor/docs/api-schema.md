# REST API schema

Base URL: your server root (e.g. `http://192.168.1.50:61337` or
`https://phosphor.example.com`). All bodies are JSON. Authenticate with
`Authorization: Bearer <jwt>` (the web client may also send the token via
the `ph_token` cookie).

Roles: **user** (any active account), **admin**.

Errors are always `{ "error": "message" }` with an appropriate HTTP status
(`400` validation, `401` unauthenticated/inactive, `403` forbidden, `404`
missing, `409` conflict, `429` rate limited (with a `Retry-After` header,
on `/api/auth/*`), `502` provider/indexer failure).

## Health

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/health` | public | `{ status, db, version, time }` |

## Auth

| Method | Path | Role |
|---|---|---|
| POST | `/api/auth/signup` | public |
| POST | `/api/auth/login` | public |
| POST | `/api/auth/logout` | public |

`POST /api/auth/signup` `{ email, password (min 8 chars), displayName }` →
201 `{ token, user }` (first account on an empty server gets `role: "admin"`).
`POST /api/auth/login` `{ email, password }` → 200 same shape (403 if
deactivated, 401 if wrong credentials).

## Account (role: user)

| Method | Path | Description |
|---|---|---|
| GET | `/api/account/profile` | `{ user }` |
| PUT | `/api/account/update` | `{ displayName? }` |
| POST | `/api/account/change-password` | `{ currentPassword, newPassword }` |
| GET | `/api/account/debrid` | `{ primaryProvider, fallbackOrder, keys }` — keys redacted to `"****abcd"` hints |
| PUT | `/api/account/debrid` | Update config (below) |
| GET | `/api/account/saved-searches` | `{ savedSearches: [SavedSearch] }`, newest first |
| POST | `/api/account/saved-searches` | `{ name, query, minSeeders?, maxSizeGb?, sort? }` → 201 `{ savedSearch }`; 409 past 20 per account |
| DELETE | `/api/account/saved-searches/:id` | 200 no-op if it doesn't belong to the caller |

```json
// PUT /api/account/debrid
{
  "primaryProvider": "realdebrid",          // "realdebrid" | "alldebrid" | "premiumize" | "torbox"
  "fallbackOrder": [],                      // reserved for future multi-provider fallback
  "realDebridToken": "…",                   // omit = keep, null = clear
  "allDebridApiKey": "…",
  "premiumizeApiKey": "…",
  "torboxApiKey": "…"
}
```

## Debrid (role: user)

| Method | Path | Description |
|---|---|---|
| GET | `/api/debrid/account?provider=<id>` | Live account info; doubles as "test connection" |

```json
{ "account": { "provider": "torbox", "username": "you@example.com", "premium": true } }
```

## Search (role: user)

`GET /api/search?q=<query>&minSeeders=&maxSizeGb=&sort=seeders|size|date`

Fans out to every enabled indexer in parallel, merges, filters, sorts.
Indexer failures are reported per-indexer, not fatal. Raw per-indexer results
(before the seeders/size filter and sort, which are cheap and applied fresh
per request) are cached in-process for 30s per `(indexer, query text)` pair,
so adjusting filters/sort without changing the query doesn't re-hit your
Jackett/Prowlarr instance.

```json
{
  "results": [
    {
      "indexerId": "…", "indexerName": "My Jackett",
      "title": "Some.Movie.2024.1080p", "link": "magnet:?xt=…",
      "hasMagnet": true, "sizeBytes": 2147483648,
      "seeders": 120, "peers": 140, "publishedAt": "2024-01-01T00:00:00Z"
    }
  ],
  "errors": []
}
```

## Downloads (role: user)

| Method | Path | Description |
|---|---|---|
| GET | `/api/downloads` | `{ jobs: [DownloadJob] }`, newest first |
| GET | `/api/downloads/:id` | `{ job }` |
| POST | `/api/downloads` | Add a magnet or direct link (below) |
| POST | `/api/downloads/:id/refresh` | Poll the provider for an active job |
| DELETE | `/api/downloads/clear-completed` | Bulk-remove every `finished`/`error` job in one query → `{ removed: number }` |
| DELETE | `/api/downloads/:id` | Remove a job from the queue |

```json
// POST /api/downloads
{ "title": "Some Movie", "sourceUrl": "magnet:?xt=…", "sizeBytes": 123, "seeders": 10, "indexerName": "My Jackett" }
// 201 — magnet jobs may already be "finished" if the provider had it cached
{ "job": { "id": "…", "status": "queued", "progress": 0, "provider": "realdebrid", "streamUrl": null, "...": "…" } }
// 502 on provider failure — job is still recorded with status "error"
{ "job": { "status": "error", "error": "[realdebrid] hoster_unavailable" }, "error": "…" }
```

`sourceUrl` starting with `magnet:` is submitted to the provider and must be
polled via `/refresh` until `status` becomes `"finished"` (with a
`streamUrl`) or `"error"`. Any other URL is treated as a direct hoster link
and resolved immediately — the job is created already `"finished"` or
`"error"`, no polling needed. Provider is always the caller's configured
primary provider.

## Admin (role: admin — every route below returns 401/403 otherwise)

### Users

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/users` | `{ users: [User] }` |
| PATCH | `/api/admin/users/:id` | `{ role?, active?, displayName? }` — self-demotion/deactivation rejected |

### Indexers

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/indexers` | List (apiKey redacted to a hint) |
| POST | `/api/admin/indexers` | `{ name, baseUrl, apiKey, enabled? }` |
| PATCH | `/api/admin/indexers/:id` | Partial update |
| DELETE | `/api/admin/indexers/:id` | Remove |
| POST | `/api/admin/indexers/:id/test` | Runs a throwaway search → `{ ok, sampleResultCount? , error? }` |

### Server & provider settings

| Method | Path | Description |
|---|---|---|
| GET/PUT | `/api/admin/server` | `{ providerOrder, disabledProviders, providerTimeoutMs, maxResolveAttempts, maxResultsPerIndexer }` |
| GET | `/api/admin/providers` | Provider list with enabled flags / base URL overrides |
| PUT | `/api/admin/providers/:id` | `{ enabled?, baseUrl? }` |
| POST | `/api/admin/providers/:id/test` | Connectivity test using the calling admin's own key |

### Health, logs, backup

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/health` | DB status, user/indexer counts, download stats, provider enablement |
| GET | `/api/admin/logs?limit=&type=&level=&provider=` | Recent structured events, newest first (max 500) |
| GET | `/api/admin/export/config` | JSON export: server settings, provider settings, **indexers (including plaintext API keys — treat as sensitive)** |
| POST | `/api/admin/import/config` | Validated import of the same document (`version: 1`); indexers upsert by id |

## Search and download traffic controls

Regular search requests share four concurrent indexer tasks per backend process,
with a FIFO waiting queue capped at 128 and a ten-second queue wait limit. Busy,
failed or timed-out indexers appear in the existing `errors` array while successful
results remain available. Admin connectivity-test requests are separate from this
regular-search pool. Torznab requests include the result limit when supported by
the indexer; local slicing still enforces maxResultsPerIndexer if it ignores it.

Raw results are cached for 30 seconds and simultaneous identical misses coalesce.
Keys fingerprint the indexer identity/name/URL/key/revision, exact trimmed query,
timeout and result limit. Query case is preserved. Admin create/update/delete,
enable changes, imports and server-setting changes clear the local cache; old
in-flight work cannot repopulate a cleared cache. Other processes miss on changed
configuration snapshots but do not share the cache or concurrency budget. Search
query text is limited to 500 characters; malformed filters/sort return HTTP 400.

`POST /api/downloads/:id/refresh` retains its `{ job }` success response and account
ownership checks. Repeated refreshes share work and a three-second result cache,
scoped to user/job/provider/reference and credential snapshot. A separate pool
limits provider refresh work to four active calls and 64 waiting calls per process,
with the same ten-second queue wait limit. Deletion is checked before returning
cached data, and in-flight refreshes cannot recreate deleted jobs.

Transient refresh failures (HTTP 408/429/5xx, timeouts/network failures, or local
capacity exhaustion) preserve active status/progress and return HTTP 503 with
`{ job, error, retryable: true, retryAfterMs: 8000 }` and `Retry-After: 8`. Successful
refresh clears the temporary error. Permanent refresh failures retain terminal
error behavior (502). Existing terminal jobs are not automatically resurrected.
Finished transfers without a resolved stream remain active for another attempt.
Indexer/provider HTTP timeouts cover body reads as well as response headers.

The web queue serializes automatic cycles and manual mutations. Each automatic
cycle refreshes up to twelve jobs, at most three concurrently, rotating through
the currently listed jobs. Polls are scheduled after a cycle completes rather
than on a fixed interval. Changes reset the delay to four seconds; unchanged or
failed cycles back off to at most sixty seconds. Automatic polling pauses while
hidden, resumes on visibility/focus, and cancels requests on unmount. Manual action
errors are shown, with duplicate actions disabled per job. One failing refresh
does not discard successful updates from other jobs.

These limits/caches are process-local, not distributed leases. Visible windows
may still make separate HTTP requests, though short-lived backend sharing reduces
their provider calls. Global provider-setting changes can take up to three seconds
to pass the refresh response cache. The existing list API returns only the newest
200 jobs; jobs beyond that window and persistent background polling remain outside
this change. This does not add file selection or fix every provider adapter in
Phosphor. No schema change is required for these traffic controls.


### Authentication session update

Issued tokens now have a product issuer, HS256, token ID and account session version.
Old tokens require a new sign-in after this upgrade. POST /api/auth/logout revokes
only the current token. POST /api/account/change-password returns
`{ ok: true, token, role }`: save that replacement token; other older tokens now
receive 401. Admin deactivation also invalidates older sessions. New internal
sessionVersion fields are not included in public user responses. Apply the new
schema and use a stable, non-placeholder JWT_SECRET before deployment.

## Optional Plex/Jellyfin library export

Administrator-only mounted-file exports use `/api/admin/library`. See the
[endpoint contract and filesystem requirements](https://github.com/Installation-04/StreamRD/blob/main/docs/plex-jellyfin.md#api).
No database schema changes are required for these filesystem manifests.

## Community setup checklist

`GET /api/account/setup` requires login and returns product, current role,
`configurationReady`, `connectionVerified: false`, progress, provider configuration
booleans (never keys/hints), and role-aware next-action checks. Optional library
configuration is visible only to admins; members receive administrator guidance
without admin links or filesystem paths. Responses are private/no-store. No
provider/indexer requests are made, so configured does not mean verified.

## Mounted-media browsing and reviewed batch export

- `GET /api/admin/library/files?path=&cursor=&limit=50` returns the relative path,
  parentPath, directory/video items with editable filename suggestions, and an
  opaque nextCursor. Limit is 1–100. Cursors belong to the root/directory; hidden
  children and escaping symlinks are omitted. Browsing does not write media.
- `POST /api/admin/library/entries/batch` accepts `{items: [...]}` with 1–100
  existing library-input objects. HTTP 200 returns indexed per-file exported/error
  outcomes and `{exported, failed}` summary. Successes persist when another item
  fails; retries of the same mapping are idempotent. Admin review is explicit.

Both routes require administrator access and preserve existing single-file APIs.
Directory traversal has bounded retained candidates but still enumerates the
directory per page; remote mount latency remains dependent on the mount.

## System readiness

`GET /api/admin/system` requires a live administrator session and returns private,
no-store diagnostics: product/version, checkedAt, Node runtime, DB up/down status,
migration state, verified applied count, bundled total, pending/failed names, last
applied timestamp, automatic startup mode, snapshot policy, and optional mount
configuration. States: current/unmanaged/pending/failed/drifted/unavailable.
No upgrade mutation, baseline, snapshot, provider call, credential, raw path, or
exception detail is exposed. Counts are not trustworthy when state is failed,
drifted, or unavailable; the UI labels those as not verified. The backup policy
field does not prove that a snapshot exists.

## Metadata and matching

Administrator endpoints under `/api/admin/metadata` require live admin auth and
private/no-store responses. `GET/PUT /settings` returns provider, language, automatic,
refreshDays and configured booleans; keys are accepted on PUT and never returned.
Blank keys preserve existing values; clearTmdb/clearOmdb explicitly remove them.
`POST /test {provider}`, `/search {query,type,year?,provider?}`, and
`/preview {provider,id,type}` perform explicit provider requests.

`GET /records?limit=50&cursor=...` returns bounded shared matching activity and
counts. `POST /scan {targetType?,cursor?,limit?}` queues at most 100 existing
catalog/library targets per page. `/records/:targetType/:targetId` supports GET,
DELETE, POST `/match {provider,id,type,expectedRevision?}`, POST `/refresh`, and
PATCH `/locks {lockedFields,expectedRevision?}`. Phosphor shared targets are mounted
library entries; StreamRD also has catalog targets. Private account records are
excluded from shared activity and cannot be addressed through admin target routes.

Metadata details include provider/id/type/name/year, synopsis, safe artwork URLs,
genres, cast, runtimeMinutes, rating/ratingSource, contentRating, imdbId/tmdbId,
providerUrl and fetchedAt. Record views add status, revision, locks, attempts and
sanitized error. Internal field-ownership bookkeeping is omitted.

## Private account library and onboarding scan

All `/api/account/library` endpoints require a live owner session and private/no-store
responses. GET lists only that user's items, with `limit` (1–100, default30), scoped
opaque `cursor`, `q` and `type` filters. It returns `{items,total,nextCursor}`.
Views contain id/name/type/year/provider/phase/progress/createdAt/metadata/metadataStatus;
raw provider references, owner IDs, credential fingerprints and signed URLs are omitted.

- GET `/scans`: local automatic preference, per-provider configured/enabled state,
  status, counters, safe error and last update; no upstream request.
- POST `/scan {provider?,force?}`: queue eligible providers; default idempotent
  onboarding start, `force:true` deliberate rescan.
- POST `/scan/cancel {provider}`: cancel future pages; retain imports.
- GET `/:id`: owned item or404, including for another administrator.
- POST `/:id/play {fileToken?}`: freshly resolved stream, explicit video choices,
  or pending progress; no URL is stored.
- DELETE `/:id`: remove local import and private metadata only.

`GET/PUT /api/account/debrid` adds `autoImportLibrary` (defaulttrue). Credential
saves queue scan work locally when enabled. Setup GET remains local; the Setup UI
starts a first eligible account scan once and shows its progress.

Owned `/:id/metadata` supports GET record, POST `/search`, `/preview`, `/match`,
`/refresh`, and PATCH `/locks`, using the same normalized bodies as shared metadata.
These routes check item ownership before any provider lookup. Mutations/lookups
are rate limited; metadata provider keys remain server-managed.

See the repository metadata and account-library guides for provider support,
matching rules, migration requirements, limits and fixture versus live evidence.

## Invitations and server-shared libraries

Account registration now supports `open`, `invite` and `closed` modes, with
one-use email-bound invitation tokens. Named server libraries use explicit
per-user grants and server-side provider credentials. See the
[complete endpoint contracts and access rules](../../docs/server-sharing.md).
