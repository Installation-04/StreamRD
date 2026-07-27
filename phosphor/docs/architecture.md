# Architecture

## System overview

```text
                                ┌─────────────────────────────────────────────┐
                                │              Phosphor backend               │
   Web (Next.js) ──────┐        │  ┌───────────┐   ┌───────────────────────┐  │
                       │  HTTPS │  │ Express   │   │ DebridManager         │  │
   Android/Fire TV ────┼──/─────┼─▶│ REST API  │──▶│  ├─ Real-Debrid       │──┼──▶ api.real-debrid.com
                       │  HTTP  │  │ JWT+RBAC  │   │  ├─ AllDebrid         │──┼──▶ api.alldebrid.com
   Apple TV (SwiftUI) ─┤        │  └─────┬─────┘   │  ├─ Premiumize        │──┼──▶ premiumize.me/api
                       │        │        │         │  └─ Torbox            │──┼──▶ api.torbox.app
   Desktop (Tauri) ────┘        │        │         └───────────────────────┘  │
                                │  ┌─────▼─────┐   ┌───────────────────────┐  │
                                │  │  Prisma   │   │ Torznab search client │──┼──▶ your Jackett / Prowlarr
                                │  │  SQLite   │   └───────────────────────┘  │
                                │  └───────────┘                              │
                                └─────────────────────────────────────────────┘
```

Phosphor has no admin-curated catalog. The browsing model is: search your
configured indexers → add a magnet to your debrid provider → play once
resolved. Every client (web, TV, desktop) is a thin REST consumer of the
same API; nothing except the backend ever talks to a debrid provider or
indexer directly.

## Backend (`/phosphor/server`)

Node.js + TypeScript + Express, Prisma over SQLite (Postgres-ready by
switching the datasource provider). Structurally similar to the sibling
StreamRD project in this monorepo, but with a different domain model:

| Layer | Files | Responsibility |
|---|---|---|
| Data | `prisma/schema.prisma` | Users, DebridConfig, IndexerConfig, DownloadJob, LogEvent, Setting |
| Settings | `src/settings.ts` | Mutable server/provider settings persisted as JSON in a key/value table |
| Providers | `src/providers/*` | `DebridProvider` interface, four implementations, registry, `DebridManager` |
| Indexers | `src/indexers/*` | Torznab XML client (Jackett/Prowlarr-compatible) |
| Auth | `src/auth/*` | bcrypt password hashing, JWT sessions carrying `role`, Express middleware |
| Routes | `src/routes/*` | REST endpoints; `/api/admin/*` guarded by `requireAdmin` |
| Observability | `src/logger.ts`, `src/metrics.ts` | Structured event log and download counters/stats |

### The debrid provider layer

Same `DebridProvider` interface as the sibling project (`getUserInfo`,
`unrestrictLink`, `addTorrent`, `getTorrentStatus`, `listTorrents`),
implemented for Real-Debrid, AllDebrid, Premiumize.me, and **Torbox**.
Torbox is the odd one out: it exposes separate torrent and web-download
pipelines rather than one generic "unrestrict a link" call, so its
`unrestrictLink` dispatches on a pseudo-URL scheme
(`torbox://torrent/<id>/<fileId>` or `torbox://webdl/<id>/<fileId>`) that
its own `addTorrent`/`getTorrentStatus` produce — the rest of the system
never needs to know about this; see `src/providers/torbox.ts`.

`DebridManager` resolves a job through the user's primary provider (no
automatic multi-provider fallback mid-job the way StreamRD's playback did —
Phosphor's download-job model is simpler: one job is submitted to one
provider, chosen at add-time, and polled to completion).

### The Torznab indexer layer

Indexers are server-wide, admin-managed `IndexerConfig` rows: a name, a
**Torznab endpoint URL**, and an API key. Both Jackett (per-indexer or its
"all" aggregate feed) and Prowlarr (per-indexer Torznab URL) speak the same
protocol, so the admin just pastes whichever URL their tool provides —
Phosphor doesn't need to know which one generated it. `src/indexers/torznab.ts`
queries `?t=search&q=<query>&apikey=<key>`, parses the RSS/Torznab XML
response with `fast-xml-parser`, and normalizes each `<item>` into an
`IndexerSearchResult` (title, magnet-or-torrent-file link, size, seeders,
peers). `GET /api/search` fans out to every enabled indexer in parallel,
merges, filters, and sorts.

### Download jobs

A `DownloadJob` tracks one add-to-provider attempt: a magnet is submitted
via `addTorrent` and polled via `/api/downloads/:id/refresh` until the
provider reports it finished, at which point `unrestrictLink` resolves a
playable `streamUrl`. A direct hoster link (rather than a magnet) skips
straight to `unrestrictLink`. Every job belongs to one user; there is no
shared/curated content model.

### RBAC

Identical model to the sibling project: `user`/`admin` roles embedded in the
JWT, re-checked from the DB on every request so deactivation/promotion take
effect immediately. The first account on an empty server becomes admin.
Admin-only actions are managing indexers, users, global provider/server
settings, and viewing logs — not managing a catalog, since there isn't one.

## Web (`/phosphor/web`)

Next.js App Router. Search is the home screen; a download queue page polls
active jobs every few seconds until they resolve or fail; a full-screen
`<video>` player plays the resolved `streamUrl`. Retro terminal / CRT theme:
green phosphor text, scanline overlay, monospace font, glow effects — see
`src/app/globals.css`. Middleware gates `/admin`, `/account`, `/downloads`
for a nicer UX; the API enforces the real RBAC regardless.

## TV (`/phosphor/tv`) and Desktop (`/phosphor/desktop`)

- `tv/android-tv` — react-native-tvos, remote-first focus navigation, same
  retro theme, same screens (settings, login, search, queue, player).
- `tv/apple-tv` — SwiftUI + AVKit, same screens and theme.
- `desktop` — a thin Tauri wrapper: on first launch it asks for the URL
  where your Phosphor **web app** is reachable, then loads it directly in a
  native window. It does not reimplement the UI — the web app already runs
  natively inside the wrapper.

## Networking modes

Same three modes as the sibling project: LAN (`http://<lan-ip>:61337`),
reverse proxy with HTTPS (Caddy bundled, Nginx example provided), or VPN
(WireGuard/Tailscale, treated like LAN). See [deployment.md](deployment.md).
