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
