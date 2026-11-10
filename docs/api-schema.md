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
| GET | `/api/account/profile` | `{ user }` |
| PUT | `/api/account/update` | Update `displayName` / `avatarUrl` |
| POST | `/api/account/change-password` | `{ currentPassword, newPassword }` |
| GET | `/api/account/debrid` | Debrid config; keys are redacted to hints (`"****abcd"`) |
| PUT | `/api/account/debrid` | Update config (below) |

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

## Retired in v0.18.0

The curated catalogue and everything that only existed for it answer **410 Gone** (`{ "error": "...", "retired": true }`) for any method:
`/api/catalog/*`, `/api/play/*` (catalogue playback, progress and continue-watching), `/api/account/favorites*`,
`/api/account/profiles*`, `/api/account/continue-watching` and `/api/admin/catalog*`. Nothing stored was deleted. Playback from libraries is
under `/api/shared-libraries/*` (see below), and the home page's rows come from `/api/home`.

Only administrators may call `/api/account/library*` (the personal debrid import API); members get **403**. Their earlier imports stay stored and hidden.

## Admin (role: admin — every route below returns 401/403 otherwise)

### Users

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/users` | `{ users: [User] }` |
| GET | `/api/admin/users/:id` | `{ user, recentPlaybacks }` |
| PATCH | `/api/admin/users/:id` | `{ role?, active?, displayName? }` — self-demotion/deactivation is rejected |

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
| GET | `/api/admin/health` | DB status, user/library-title counts, `brokenLinks`, playback stats (per-provider plays, last-hour plays, 24h failures), in-process counters, provider enablement |
| GET | `/api/admin/logs?limit=&type=&level=&provider=&userId=` | Recent structured events, newest first (max 500) |
| GET | `/api/admin/export/config` | JSON export of server settings + provider settings (versionable); older exports that carry a `catalog` key still import, the key is ignored |
| POST | `/api/admin/import/config` | Validated import of the same document (`version: 1`); titles upsert by id |

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
library targets per page (catalogue targets were retired in v0.18.0). `/records/:targetType/:targetId` supports GET,
DELETE, POST `/match {provider,id,type,expectedRevision?}`, POST `/refresh`, and
PATCH `/locks {lockedFields,expectedRevision?}`. Phosphor shared targets are mounted
library entries. Private account records are
excluded from shared activity and cannot be addressed through admin target routes.

Metadata details include provider/id/type/name/year, synopsis, safe artwork URLs,
genres, cast, runtimeMinutes, rating/ratingSource, contentRating, imdbId/tmdbId,
providerUrl and fetchedAt. Record views add status, revision, locks, attempts and
sanitized error. Internal field-ownership bookkeeping is omitted.

## Media servers (administrators only)

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/media-servers` | `{ manager: { available }, servers: { jellyfin, plex } }`; each server has `port`, `state` (`unknown` without the media manager, then `absent`, `pulling`, `starting`, `running`, `stopped`, `failed`), `error?` and `secretHint` (the last four characters of the saved token, never the token). |
| PUT | `/api/admin/media-servers` | `{ plex?: { port?, secret? }, jellyfin?: { port?, secret? } }`; `secret` is a Plex token or Jellyfin API key (stored encrypted) and `null` clears it. |
| POST | `/api/admin/media-servers/:server/launch` | `{ port?, claim? }` → 202 `{ state }`. `claim` is a Plex claim token, passed to the launch and never stored. 409 when the media manager is not installed. |
| POST | `/api/admin/media-servers/:server/stop` | Stops the container started from here. |
| DELETE | `/api/admin/media-servers/:server` | Removes it (its settings under `config/` are kept). |
| POST | `/api/admin/media-servers/:server/test` | `{ reachable, accepted }`: whether the server answers and accepted the saved token. |
| POST | `/api/admin/media-servers/:server/refresh` | Asks the server to rescan the libraries under `/library` → `{ refreshed }`. |

`:server` is `jellyfin` or `plex`. Everything here answers 403 to non-administrators.
## My List (any signed-in viewer)

| Method | Path | Description |
|---|---|---|
| GET | `/api/shared-libraries/favorites` | `{ items: [{ libraryId, item }] }`: the viewer's list, newest first, one entry per title (the version a library shows), only from libraries and within the viewing limit the viewer has now. |
| PUT | `/api/shared-libraries/:id/items/:itemId/favorite` | Adds the title → `{ favorite: true }`; 404 if the item is not visible to the viewer; 409 when the list holds 500 titles. |
| DELETE | `/api/shared-libraries/:id/items/:itemId/favorite` | Removes it → `{ favorite: false }`. |

Library item views (a library's items, one item, and `GET /api/home` rows) carry `favorite: boolean`, and `GET /api/home` has a `myList` row (StreamRD). Entries name a title by owner and group, so every version of a title shares one entry.

## Link health (administrators only, v0.19.0)

| Method | Path | Description |
|---|---|---|
| GET | `/api/account/library/health` | `{ ok, unknown, broken, items: [{ id, name, year, reason, checkedAt }] }` — counts of finished imports by health, and up to 50 broken ones. No provider references. |
| POST | `/api/account/library/:id/check` | Checks one item now → `{ outcome: "ok" \| "unknown" \| "broken" \| "skipped", health }`; 404 for an item that is not yours. |

Library item views carry `health` (`unknown`, `ok` or `broken`). A background job checks a few items a minute (`LINK_HEALTH=false` disables it); two definite "gone" answers in a row make an item `broken`, which is then never the primary version of its title while another works. Both routes answer 403 to non-administrators.

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
- `GET /api/home` → `{externalEnabled, trailersEnabled, featured:[slide], recentlyAdded:[{libraryId|null,item}], popularHere:[…], trending:[card], popularMovies:[card], popularSeries:[card]}`; a card is `{provider:"free",id,type,name,year,posterUrl,rating}`; a slide is `{kind:"library"|"external",id,href,title,year,rating,genres,description,backdropUrl,trailer,label}` where `trailer` is a YouTube id or null.
- Invitations: `POST /api/admin/invitations {email, expiresInDays, libraryIds[], maxAge}`; `GET/PUT /api/admin/invite-address {url}`; `POST /api/auth/invitation` also returns `{libraries:[names], limited}`; invitation records carry `libraryIds` and `maxAge`.
- Viewing limits: `PATCH /api/admin/users/:id {maxAge: 7|8|14|17|null}`; `PUT /api/admin/shared-libraries/items/:itemId/rating {rating: string|null}` → `{ratingLabel, minAge, ratingManual}`. Library item views carry `ratingLabel` and `ratingManual`.
- Administrators can set `everyone: true` when creating or updating a library (`/api/admin/shared-libraries`) to make it visible to every active user without per-user grants.
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

## Logs and library matching (v0.8.1)

- `GET /api/admin/logs?limit&cursor&type&level&provider&userId&q&from&to` → `{logs, nextCursor}`.
  `limit` 1–1000 (default 100); `cursor` is opaque keyset paging (newest first); `q` searches
  message text; `from`/`to` are ISO dates. Invalid dates or cursors return 400.
- `GET /api/admin/logs/export?format=ndjson|csv|txt&max=…&(same filters)` streams an attachment
  (max 50,000 rows, 10 requests/minute). CSV neutralizes formula-leading cells.
- `GET /api/account/library/metadata/summary` → counts for the caller's own library only:
  `{total, matched, matching, review, unmatched, error, notStarted, provider:{configured, automatic}}`.
- `POST /api/account/library/metadata/rematch` queues up to 500 of the caller's review, unmatched,
  failed or never-started titles → `{queued, remaining, configured}`. Call until `queued` is 0.
