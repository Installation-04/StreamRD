# REST API schema

Base URL: your server root (e.g. `http://192.168.1.50:47821` or `https://media.example.com`).
All bodies are JSON. Authenticate with `Authorization: Bearer <jwt>` (the web
client may also send the token via the `sr_token` cookie).

Roles: **public** (no auth), **user** (any active account), **admin**.

Errors are always `{ "error": "message" }` with an appropriate HTTP status
(`400` validation, `401` unauthenticated/inactive, `403` forbidden, `404`
missing, `409` conflict, `429` rate limited (with a `Retry-After` header,
on `/api/auth/*`), `502` provider failure).

## Health

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/health` | public | Liveness probe: `{ status, db, version, time }` |

## Auth

| Method | Path | Role |
|---|---|---|
| POST | `/api/auth/signup` | public |
| POST | `/api/auth/login` | public |
| POST | `/api/auth/logout` | public |

`POST /api/auth/signup`

```json
// request
{ "email": "me@example.com", "password": "min-8-chars", "displayName": "Me" }
// 201 response — the FIRST account on an empty server gets "role": "admin"
{ "token": "<jwt>", "user": { "id": "…", "email": "…", "displayName": "…", "role": "user", "active": true } }
```

`POST /api/auth/login` takes `{ email, password }` and returns the same shape
(200). Deactivated accounts get `403`.

## Account (role: user)

| Method | Path | Description |
|---|---|---|
| GET | `/api/account/profile` | `{ user, profiles }` |
| PUT | `/api/account/update` | Update `displayName` / `avatarUrl` |
| POST | `/api/account/change-password` | `{ currentPassword, newPassword }` |
| GET | `/api/account/profiles` | `{ profiles: [Profile] }` — Netflix-style viewing profiles, up to 5 per account |
| POST | `/api/account/profiles` | `{ name, avatarUrl? }` → 201 `{ profile }`; 409 once the cap is reached |
| PATCH | `/api/account/profiles/:id` | Partial update; 404 for another account's profile |
| DELETE | `/api/account/profiles/:id` | 404 for another account's profile |
| GET | `/api/account/debrid` | Debrid config; keys are redacted to hints (`"****abcd"`) |
| PUT | `/api/account/debrid` | Update config (below) |
| GET | `/api/account/favorites` | `{ titles: [Title] }` — "My List", most recently added first |
| POST | `/api/account/favorites/:titleId` | Idempotent add → 201 `{ ok: true }`; 404 if the title doesn't exist |
| DELETE | `/api/account/favorites/:titleId` | Remove (no-op if absent) → `{ ok: true }` |
| GET | `/api/account/continue-watching` | `{ titles: [Title] }` — titles this user has successfully played, deduped, most recent first (max 20) |

`PUT /api/account/debrid`

```json
{
  "primaryProvider": "realdebrid",          // "realdebrid" | "alldebrid" | "premiumize"
  "fallbackOrder": ["alldebrid"],           // optional; [] = inherit global order
  "realDebridToken": "…",                   // omit = keep, null = clear
  "allDebridApiKey": "…",
  "premiumizeApiKey": "…"
}
```

## Debrid (role: user)

| Method | Path | Description |
|---|---|---|
| GET | `/api/debrid/account?provider=<id>` | Live account info from the provider (defaults to primary). Doubles as "test connection". |

```json
// 200
{ "account": { "provider": "realdebrid", "username": "alice", "premium": true, "premiumUntil": "2027-01-01T00:00:00.000Z", "points": 42 } }
```

## Catalog (role: user, or public if the admin enables unauthenticated browse)

| Method | Path | Description |
|---|---|---|
| GET | `/api/catalog/rows` | Netflix-style rows: `{ rows: [{ id, label, titles: [Title] }] }` |
| GET | `/api/catalog/search?q=` | `{ results: [Title] }` (max 50) |
| GET | `/api/catalog/title/:id` | `{ title: Title }` |

`Title` (user-facing — raw source URLs are never exposed to non-admins):

```json
{
  "id": "…", "name": "…", "description": "…", "type": "movie",
  "genres": ["Drama"], "year": 2024, "posterUrl": null, "backdropUrl": null,
  "sourceCount": 2, "createdAt": "…", "updatedAt": "…"
}
```

## Playback (role: user)

`POST /api/play` — `{ "titleId": "…", "sourceIndex": 0? }`

```json
// 200 — resolved through the user's provider order with automatic fallback
{
  "stream": {
    "url": "https://…/file.mp4", "filename": "file.mp4", "filesize": 123,
    "mimeType": "video/mp4", "provider": "realdebrid", "quality": "1080p", "label": null
  },
  "title": { "id": "…", "name": "…" }
}
// 502 — all providers failed (message from the last attempt)
{ "error": "[realdebrid] hoster_unavailable" }
```

## Admin (role: admin — every route below returns 401/403 otherwise)

### Users

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/users` | `{ users: [User] }` |
| GET | `/api/admin/users/:id` | `{ user, recentPlaybacks }` |
| PATCH | `/api/admin/users/:id` | `{ role?, active?, displayName? }` — self-demotion/deactivation is rejected |

### Catalog

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/catalog` | Titles **including** debrid sources |
| POST | `/api/admin/catalog/create` | Create title |
| PATCH | `/api/admin/catalog/:id/update` | Partial update |
| DELETE | `/api/admin/catalog/:id/delete` | Delete |

Title write shape:

```json
{
  "name": "Movie", "description": "…", "type": "movie", "genres": ["Drama"],
  "year": 2024, "posterUrl": null, "backdropUrl": null,
  "sources": [
    { "kind": "link",   "url": "https://hoster/…", "quality": "1080p", "label": "Mirror A" },
    { "kind": "magnet", "url": "magnet:?xt=…",     "quality": "2160p" }
  ]
}
```

### Server & provider settings

| Method | Path | Description |
|---|---|---|
| GET/PUT | `/api/admin/server` | Global settings (partial PUT allowed) |
| GET | `/api/admin/providers` | Provider list with enabled flags / base URL overrides |
| PUT | `/api/admin/providers/:id` | `{ enabled?, baseUrl? }` |
| POST | `/api/admin/providers/:id/test` | Connectivity test using the calling admin's own key → `{ ok, account? , error? }` |

Server settings shape:

```json
{
  "providerOrder": ["realdebrid", "alldebrid", "premiumize"],
  "disabledProviders": [],
  "providerTimeoutMs": 15000,
  "maxPlaybackAttempts": 3,
  "allowUnauthenticatedBrowse": false,
  "requireLoginForPlayback": true
}
```

### Health, logs, backup

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/health` | DB status, user/title counts, playback stats (per-provider plays, last-hour plays, 24h failures), in-process counters, provider enablement |
| GET | `/api/admin/logs?limit=&type=&level=&provider=&userId=` | Recent structured events, newest first (max 500) |
| GET | `/api/admin/export/config` | JSON export of server settings + provider settings + catalog (versionable) |
| POST | `/api/admin/import/config` | Validated import of the same document (`version: 1`); titles upsert by id |

### Pending torrent playback (backward-compatible extension)

`POST /api/play` still returns the existing `{ stream, title }` body with HTTP
200 when ready. An unfinished torrent returns HTTP 502 with the existing
`error` string plus `pending: true`, `retryAfterMs: 5000`, and `progress` (0–100).
Clients may retry the same request after that interval. Pending preparations do
not count as failed plays in PlaybackLog. Legacy clients continue to receive an
ordinary error and can retry manually; the web client retries up to 60 times and
cancels polling when navigating away. No new unauthenticated job endpoint exists.

Provider references are stored per user, provider, source, credentials and base
URL. Signed stream URLs are freshly resolved and never stored in the job table.
References expire after 24 hours; changed credentials select a separate job.
Concurrent workers use a database lease. Abandoned leases become recoverable
after their timeout. HTTP 404 clears a removed provider reference; transient
errors retain it. A process crash (or an error inside a provider's add operation)
before its returned reference is persisted can still cause a duplicate add on
retry. This is not an exactly-once guarantee across the provider and SQLite.

Upgrades require the additive `PlaybackSourceJob` table: regenerate the Prisma
client and apply the schema using the repository's existing `prisma db push`
workflow before starting the updated backend. Back up deployed databases first.

### Bounded catalog browsing

The legacy `GET /api/catalog/rows` response is unchanged for existing clients.
New clients use the following authenticated endpoints (or public browsing when
an admin has enabled it):

- `GET /api/catalog/browse?limit=20`: initial recent/movie/series rows plus up
  to five genre rows. Empty rows are omitted. `limit` is per row, defaults to
  20 and must be an integer from 1 to 50.
- `GET /api/catalog/browse?afterGenre=<nextGenre>&limit=20`: the next five genre
  rows. The response is `{ rows, nextGenre }`; null `nextGenre` ends pagination.
- `GET /api/catalog/browse/row?row=<rowId>&cursor=<nextCursor>&limit=20`: another
  page within a row. Row IDs are `recent`, `movies`, `series`, or `genre:<name>`.
  Response is `{ id, label, titles, nextCursor }`. Null ends pagination.

Cards contain only `id`, `name`, `year`, and `posterUrl`. Fetch the existing
`/api/catalog/title/:id` endpoint for full details. Encode query parameters with
URLSearchParams or encodeURIComponent. Genre names are sorted using SQLite's
binary order; nonempty string genres up to 500 characters are supported by the
new genre listing. Malformed and non-array genre JSON is ignored.

Row cursors carry the row ID, timestamp, and title ID; treat them as opaque and
pass them back unchanged. Invalid or cross-row cursors return HTTP 400. Rows use
`createdAt DESC, id DESC` keyset ordering, so deleting the cursor's title does
not invalidate pagination. Newer titles require refreshing the first page;
this is not a frozen snapshot while admins edit the catalog.

The web home page uses these endpoints with load-more controls and cancellation
on navigation. Favorites/history remain on their existing endpoints. Apply the
new additive Title indexes with the repository's existing schema-update workflow
before deployment. Genre queries currently use SQLite JSON functions; migrating
to another database needs an equivalent query implementation.

### Bounded favorites and viewing history

- `GET /api/account/favorites/page?limit=20&cursor=...`
- `GET /api/account/continue-watching/page?limit=20&cursor=...`

Both require an active authenticated account and return `{ titles, nextCursor }`.
Titles contain only `id`, `name`, `year`, and `posterUrl`. The default page size
is 20; valid limits are integers from 1 to 50. Null cursors end pagination.
Malformed, cross-account, or cross-list cursors return HTTP 400. Treat cursors
as opaque; URL-encode them when sending them back. Query filters always scope
results to the authenticated account, independently of cursor contents.

Favorites use creation timestamp and favorite-record ID keyset ordering. Removing
the cursor's favorite does not prevent loading the next page. History aggregates
all successful playback logs by title before limiting, ordered by latest success
then title ID. Failures do not advance a title. This fixes the previous behavior
where 200 recent plays of one title hid other titles. History still represents
successful URL resolution, not playback position or completion.

`POST /api/account/favorites/status` accepts `{ titleIds: string[] }`, at most 200
nonempty IDs, and returns `{ favoriteIds: string[] }` containing only favorites
among the requested IDs for the current account. Empty input returns an empty
array; duplicate IDs are deduplicated. The web queries status for newly visible
cards, rather than downloading the whole saved list. Favorite controls wait for
status and serialize edits per title; late page/status results preserve local
edits, and failed edits roll back with a visible error.

The original GET favorites and continue-watching response shapes remain available.
Legacy favorites still returns the full list. Legacy history returns up to 20
full titles using the corrected distinct-history query. New history pages scan
the account's indexed successful logs to aggregate them; this bounds returned
objects, but does not provide constant-time aggregation for arbitrarily large
histories. Page contents can change when new activity occurs; refresh to see
items that move ahead of an existing cursor.

Apply the additive Favorite(userId, createdAt, id) and
PlaybackLog(userId, success, titleId, createdAt) indexes with the existing Prisma
schema-update workflow before deployment. No history backfill is needed.

### Choosing a torrent video file

When a finished torrent contains multiple main videos, `POST /api/play` returns
HTTP 409 with `{ error, selectionRequired: true, provider, sourceIndex, files }`.
Each file contains `{ token, name, size?, format, sample }`. No provider URL or
API credential is included in the choice list. Retry the same endpoint with:

```json
{
  "titleId": "the-title-id",
  "sourceIndex": 0,
  "selection": { "provider": "realdebrid", "fileToken": "the-returned-token" }
}
```

Pass the returned sourceIndex and provider unchanged. Tokens are bound to the
account, source, credentials/base URL, saved torrent reference and file metadata.
An invalid or expired choice returns HTTP 409; malformed selection input returns
400. Explicit choices do not silently fall back to another source or provider.
Selecting a file reuses the saved reference rather than adding the torrent again.
As with pending work, asking for a choice does not create a failed playback log.

When there is exactly one main video it is chosen automatically, skipping samples,
trailers and non-video files. A sample-only torrent requires an explicit choice.
Empty/non-video torrents fail rather than playing an arbitrary document/archive.
Older adapters without metadata retain single-link behavior; multiple unnamed
links require a choice. Choice responses are capped at 500 video candidates;
oversized packs fail explicitly rather than silently hiding files.

Real-Debrid maps links to the selected files in order, refusing inconsistent
file/link counts. It still selects all files at the provider to start the torrent;
this change controls playback selection, not which files the provider downloads.
AllDebrid retrieves its nested file tree. Premiumize resolves finished transfers
through item details or nested folder listings and uses cloud links directly.
Tree traversal is bounded by depth/count limits and the existing network deadline.

The web chooser supports changing files and shows an external-link fallback if
HTML video playback fails. Container extensions are hints, not codec guarantees;
no transcoding is added. Legacy clients still receive a normal error string for
ambiguous packs and need a chooser update to play a specific file. Direct hoster
sources keep their existing unrestrict behavior; Premiumize multi-entry directdl
responses for those sources still use the first entry.

Provider mapping references: [Real-Debrid REST](https://api.real-debrid.com/),
[AllDebrid magnet files](https://docs.alldebrid.com/#get-files-and-links), and
[Premiumize API](https://www.premiumize.me/api/). Validation uses mocked responses
and a local provider fixture; live subscription playback has not been tested.

### Profile-scoped playback progress and resume

New clients opt in to tracking when resolving a stream:

```json
{ "titleId": "title-id", "trackProgress": true, "profileId": "optional-owned-profile-id" }
```

Omit `profileId` for the account's default viewing scope. A foreign/missing profile
returns HTTP 404. A successful response keeps `{ stream, title }` and adds
`playback: { sessionId, resumeSeconds, durationSeconds }`. Completed videos resume
from zero. Requesting a stream alone does not populate the new Continue Watching
row. Older clients that omit trackProgress retain their previous behavior.

After actual playback starts, save events using:

```json
{
  "sessionId": "returned-session-id",
  "sequence": 0,
  "positionSeconds": 30,
  "durationSeconds": 120
}
```

Send this body with `PUT /api/play/progress`. Sequences must increase per session.
Responses are `{ accepted: true }` or `{ accepted: false, reason: "out-of-order" |
"superseded" }`. An older player cannot overwrite a newer resolved tracked player
for the same account/profile/title/file. Seeks backwards within the active session
are allowed. Session IDs are account-authorized on every write; another account
receives 404. Inactive accounts receive 401. Sessions expire after 24 hours (410).
Positions/durations must be finite nonnegative numbers (duration strictly positive),
not exceed seven days, and position cannot exceed duration by more than one second.
The server clamps the one-second tolerance and marks at least 95% complete.

`GET /api/play/continue?profileId=...&limit=20&cursor=...` returns compact title
cards with positionSeconds, durationSeconds and mediaKey, plus nextCursor. It
includes only incomplete positive progress, with the most recent incomplete file
per title. Limits range from 1 to 50. Cursors are bound to the account and viewing
scope. Progress is separate for every profile and media identity; deleting a
profile cascades its progress/sessions. Favorites remain shared across the account.
The legacy `/api/account/continue-watching*` APIs still represent successful URL
resolution history, preserving existing client behavior.

Media identity hashes the catalog source and file path/name/size. It excludes
expiring CDN URLs and credentials; different files/editions do not share positions.
Metadata/source changes may create a new identity rather than risk resuming the
wrong video. For packs, choose the appropriate file again; that file then resumes
its own position. Progress does not automatically choose an episode for the user.

The web profile selector persists a choice per account in local storage. Player
writes are throttled to 15 seconds, with pause/seek/end/navigation/visibility flushes.
They are serialized; failures retry on later player events and display a message.
Exit flushes use fetch keepalive as a best effort, not a guaranteed delivery channel.
A failed/crashed browser can lose recent unsaved seconds. Live/unknown durations
are not tracked. No first-frame/buffering analytics or transcoding is included.

Apply the additive PlaybackSession and PlaybackProgress tables/indexes and
regenerate the Prisma client before deployment, using the existing schema-update
workflow after backing up deployed data. No guessed positions are backfilled from
old resolution logs. Expired session retention/cleanup remains future work.


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
[complete endpoint contracts and access rules](server-sharing.md).

## Shared-library watch progress

All routes require an active session and current access to the library.

- `POST /api/shared-libraries/:id/items/:itemId/play` — when a stream is returned it
  also includes `progressSessionId`, `resumeSeconds` and `durationSeconds`. Each play
  supersedes earlier player sessions for that viewer and file.
- `PUT /api/shared-libraries/:id/items/:itemId/progress`
  `{sessionId, sequence, positionSeconds, durationSeconds}` → `{accepted:true}` or
  `{accepted:false, reason:"out-of-order"}`. Unknown/superseded sessions and
  inaccessible items return 404; positions past the duration are rejected (400).
  95% watched marks the file complete and resets the resume position.
- `GET /api/shared-libraries/continue?limit=12` → `{items:[{libraryId,item,positionSeconds,durationSeconds,updatedAt}]}`
  for incomplete, currently accessible items, newest first, one per item.

## System maintenance (administrators only)

All routes require a live administrator session, are `no-store`, and are rate limited.

- `GET /api/admin/system/maintenance` → `{backups:[{name,kind,sizeBytes,createdAt}], pendingRestore, restartSupported}`.
- `POST /api/admin/system/backups` → 201 `{backup}`; a verified snapshot (max 20 manual).
- `GET /api/admin/system/backups/:name/download`; `POST …/verify` → `{ok,schema}` or `{ok:false,reason}`; `DELETE …/:name`.
  Names must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.db$`; anything else is 404.
- `POST /api/admin/system/backups/:name/restore` `{confirm:"RESTORE", restart?:boolean}` → 202
  `{preRestoreBackup, restartRequired:true, restarting}`. Stages the swap for the next start.
  `DELETE /api/admin/system/restore` cancels it. `POST /api/admin/system/restart` requires `ADMIN_RESTART=true`.
- `GET /api/admin/system/update[?refresh=1]` → `{current, latest, updateAvailable, publishedAt, url, checkEnabled, checkedAt, error, canApply}`.
- `POST /api/admin/system/update` `{version}` → 202 `{requested, backup}`. Requires `UPDATE_WEBHOOK_URL`,
  a matching newer release, and takes a `pre-update-*` backup first; hook failures return 502.
