# Architecture

## System overview

```text
                                ┌───────────────────────────────────────────┐
                                │              StreamRD backend             │
   Web (Next.js) ──────┐        │  ┌───────────┐   ┌─────────────────────┐  │
                       │  HTTPS │  │ Express   │   │ DebridManager       │  │
   Scripts / API ──────┼──/─────┼─▶│ REST API  │──▶│  ├─ Real-Debrid     │──┼──▶ api.real-debrid.com
                       │  HTTP  │  │ JWT+RBAC  │   │  ├─ AllDebrid       │──┼──▶ api.alldebrid.com
                       │        │  └─────┬─────┘   │  └─ Premiumize      │──┼──▶ premiumize.me/api
                       │        │        │         └─────────────────────┘  │
                       ┘        │  ┌─────▼─────┐                            │
                                │  │  Prisma   │──▶ SQLite (or PostgreSQL)  │
                                │  └───────────┘                            │
                                └───────────────────────────────────────────┘

   Reachability options (same API for every client):
     LAN            http://192.168.x.x:47821
     Reverse proxy  https://media.example.com   (Caddy/Nginx → backend + web)
     VPN            http://10.x.x.x:47821        (WireGuard/Tailscale tunnel)
```

Every client is a thin REST consumer: the browser, phones and TVs all speak
the same JSON API, and playback URLs are resolved server-side so debrid API
keys never leave the backend (clients only submit them once when the user
saves settings).

## Backend (`/server`)

Node.js + TypeScript + Express, with Prisma over SQLite (Postgres-ready by
switching the datasource provider).

Layers, bottom-up:

| Layer | Files | Responsibility |
|---|---|---|
| Data | `prisma/schema.prisma`, `src/db.ts` | Users, DebridConfig, Profiles, Titles, PlaybackLog, LogEvent, Settings |
| Settings | `src/settings.ts` | Mutable server/provider settings persisted as JSON in a key/value table |
| Providers | `src/providers/*` | `DebridProvider` interface, three implementations, registry, `DebridManager` |
| Auth | `src/auth/*` | bcrypt password hashing, JWT sessions carrying `role`, Express middleware (`attachSession`, `requireAuth`, `requireAdmin`) |
| Routes | `src/routes/*` | REST endpoints; `/api/admin/*` guarded by `requireAdmin` |
| Observability | `src/logger.ts`, `src/metrics.ts` | Structured event log (stdout + DB) and playback counters/stats |

### The debrid provider layer

`DebridProvider` is the extension point:

```ts
interface DebridProvider {
  getUserInfo(creds): Promise<DebridUserInfo>;
  unrestrictLink(creds, url): Promise<UnrestrictedLink>;
  addTorrent(creds, magnetOrTorrentUrl): Promise<TorrentStatus>;
  getTorrentStatus(creds, id): Promise<TorrentStatus>;
  listTorrents(creds): Promise<TorrentStatus[]>;
}
```

Provider responses are normalized into shared shapes (`DebridUserInfo`,
`TorrentStatus`, `UnrestrictedLink`) so callers never see provider-specific
payloads. Adding a service = one new class + one registry entry + one id in
`PROVIDER_IDS` (see [providers.md](providers.md)).

`DebridManager` decides *which* provider handles a request:

1. Start from the user's **primary provider**.
2. Continue with the user's personal fallback order, or the **global order**
   set by the admin if the user has none.
3. Skip providers that are globally disabled or missing an API key.
4. Cap attempts at the admin-configured `maxPlaybackAttempts`.

Every attempt increments metrics; failures are written to the event log, and
each play (success or not) creates a `PlaybackLog` row.

### RBAC

Roles are `user` and `admin`, stored on the `User` row and embedded in the
JWT. `requireAuth` re-reads the user on every request, so deactivation and
role changes apply immediately rather than at token expiry. `requireAdmin`
guards the whole `/api/admin` router. The first account created on an empty
database becomes admin (also `ADMIN_EMAIL`, if set).

## Web (`/web`)

Next.js App Router + React, all client components talking to the API with a
small fetch wrapper (`src/lib/api.ts`). The JWT is kept in a cookie so
`middleware.ts` can redirect anonymous users off `/account/*` and non-admins
off `/admin/*` — a UX convenience; the API enforces the real RBAC. Dark theme
is default with a light toggle, and UI strings route through a minimal i18n
dictionary (`src/lib/i18n.ts`) ready for more locales.

## Other clients

The repository no longer ships native apps: the Expo mobile app, the Android TV / Fire TV and Apple TV apps and the Phosphor desktop wrapper were unmaintained, not built in CI and targeted an older API, so they were removed after v0.10.1 (they remain in git history, for example at the `v0.8.1` tag). The REST API in [api-schema.md](api-schema.md) is unchanged, so any client that sends a Bearer token can still use it.

## Networking modes

The backend binds one port; how clients reach it is deployment choice:

- **LAN** — expose port 47821, clients use `http://<lan-ip>:47821`.
- **Reverse proxy** — Caddy or Nginx terminates TLS on a domain and routes
  `/api/*` to the backend and everything else to the web app
  (`/infra/reverse-proxy/`).
- **VPN** — WireGuard/Tailscale; identical to LAN with tunnel IPs.

See [deployment.md](deployment.md) for concrete setups.
