# REST API schema

Base URL: your server root (e.g. `http://192.168.1.50:47821` or `https://media.example.com`).
All bodies are JSON. Authenticate with `Authorization: Bearer <jwt>` (the web
client may also send the token via the `sr_token` cookie).

Roles: **public** (no auth), **user** (any active account), **admin**.

Errors are always `{ "error": "message" }` with an appropriate HTTP status
(`400` validation, `401` unauthenticated/inactive, `403` forbidden, `404`
missing, `409` conflict, `502` provider failure).

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
