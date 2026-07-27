# StreamRD

Self-hosted, Netflix-style streaming for your own **debrid** accounts.
One backend, every screen: web, iOS/Android, Android TV / Fire TV, Apple TV.

```text
   Web (Next.js) ──────┐                ┌──────────────────────────────────┐
   Mobile (Expo RN) ───┤   HTTPS/HTTP   │ StreamRD backend (Node/TS)       │
   Android/Fire TV ────┼───────────────▶│  REST API · JWT + RBAC · Prisma  │
   Apple TV (SwiftUI) ─┘  LAN/proxy/VPN │  DebridManager ─┬─ Real-Debrid   │
                                        │   (fallback)    ├─ AllDebrid     │
                                        │                 └─ Premiumize.me │
                                        └──────────────────────────────────┘
```

You bring your own debrid subscriptions; StreamRD turns them into a private,
multi-user streaming service with a curated catalog. Use it within the
providers' terms of service and your local law.

## Features

- **Multiservice debrid** — Real-Debrid, AllDebrid and Premiumize.me behind
  one pluggable `DebridProvider` interface, with per-user primary provider
  and automatic fallback ordering (per-user or global).
- **Accounts & RBAC** — signup/login (JWT), `user`/`admin` roles, per-user
  debrid keys (stored server-side, returned only as redacted hints).
- **Admin dashboard** — users, catalog CRUD with debrid source mappings,
  global provider order/toggles, timeouts & retry caps, access toggles,
  connectivity tests, health stats, structured logs, config export/import.
- **Every screen** — Netflix-style web UI (dark theme, light toggle, i18n-ready),
  Expo mobile app, remote-first Android TV / Fire TV app, SwiftUI Apple TV app.
- **Deploy anywhere** — Dockerized backend + web, Caddy/Nginx reverse-proxy
  examples with HTTPS, works identically over LAN or VPN; every client has a
  server-URL setting with a connectivity test.
- **Operable** — structured event log (stdout + queryable via admin API),
  playback metrics per provider, `/api/health` for probes, JSON config backup.

## Tech stack

| Piece | Stack |
|---|---|
| Backend (`/server`) | Node.js 22, TypeScript, Express, Prisma + SQLite (Postgres-ready), JWT + bcrypt, Zod, Vitest + Supertest |
| Web (`/web`) | Next.js (App Router), React, TypeScript, cookie session + middleware RBAC gates |
| Mobile (`/mobile`) | Expo / React Native (iOS + Android), expo-av playback |
| TV (`/tv`) | react-native-tvos (Android TV / Fire TV), SwiftUI + AVKit (tvOS) |
| Infra (`/infra`) | Docker, docker-compose, Caddy & Nginx configs, GitHub Actions CI |

## Quick start

Prerequisites: Docker (for the stack) or Node.js ≥ 20 (to run pieces directly).

```bash
git clone https://github.com/installation-04/streamrd.git
cd streamrd

# Backend + web + HTTPS proxy
cd infra
cp ../server/.env.example .env    # set JWT_SECRET (openssl rand -hex 32)
docker compose up -d --build

# Optional demo catalog
docker compose exec backend npx tsx prisma/seed.ts
```

Open http://localhost:3000, **sign up — the first account becomes admin**,
add your debrid API keys under Account → Debrid services, then add titles in
Admin → Catalog.

Run pieces directly during development:

```bash
# API on :47821
cd server && npm install && npx prisma generate && npx prisma db push && npm run dev

# Web on :3000
cd web && npm install && npm run dev

# Mobile (Expo) — see mobile/README.md
cd mobile && npm install && npm start

# TV — see tv/android-tv/README.md and tv/apple-tv/README.md
```

## Configuration

**Backend** (`server/.env`, see `.env.example`): `PORT`, `DATABASE_URL`,
`JWT_SECRET`, `JWT_EXPIRES_IN`, `API_BASE_URL`/`LAN_URL`/`PUBLIC_URL`,
`CORS_ORIGINS`, `ADMIN_EMAIL`.

**Web**: `NEXT_PUBLIC_API_BASE_URL` — the URL the *browser* uses to reach the
API (LAN IP, proxied domain, or VPN address).

**Mobile & TV**: set the Server URL in each app's settings screen and hit
*Test connection* (probes `/api/health`).

**Debrid providers**: each user pastes their own keys in
Account → Debrid services — Real-Debrid ([apitoken](https://real-debrid.com/apitoken)),
AllDebrid ([apikeys](https://alldebrid.com/apikeys)),
Premiumize ([account](https://www.premiumize.me/account)) — picks a primary
provider, and can test each connection. Details: [docs/providers.md](docs/providers.md).

## Admin guide

The first account on an empty server is admin (or set `ADMIN_EMAIL`). Visit
`/admin` on the web app for users, catalog, server settings, providers,
logs, and config export/import. Full walkthrough:
[docs/admin-guide.md](docs/admin-guide.md).

## Architecture & API

- [docs/architecture.md](docs/architecture.md) — system design, provider
  layer, RBAC, client model
- [docs/api-schema.md](docs/api-schema.md) — every endpoint with
  request/response examples and role requirements

## Deployment

[docs/deployment.md](docs/deployment.md) covers the three reachability modes:

- **LAN** — expose ports, point clients at `http://<lan-ip>:47821`
- **Reverse proxy + HTTPS** — bundled Caddy (automatic Let's Encrypt) or the
  Nginx example in `infra/reverse-proxy/`
- **VPN** — WireGuard/Tailscale; treat tunnel IPs like LAN

## Tests & CI

```bash
cd server && npm test    # RBAC, provider units (mocked HTTP), auth/catalog/playback integration
```

GitHub Actions (`.github/workflows/ci.yml`) typechecks + tests the server,
builds the web app, and smoke-builds both Docker images.

## Contributing

PRs welcome. Keep it small and focused; match the surrounding code style
(TypeScript strict, no default exports in the backend); add or update tests
for behavior changes (`npm test` in `server/` must pass); run `npm run lint`
in the workspace you touched. For a new debrid provider, follow
[docs/providers.md](docs/providers.md#adding-another-provider).

## Related projects

This monorepo also hosts **[Phosphor](phosphor/README.md)** — a separate,
retro terminal-styled debrid app: instead of an admin-curated catalog, you
search your own Torznab indexers (Jackett/Prowlarr) and one-click add
results to Real-Debrid, AllDebrid, Premiumize, or Torbox. Own server, own
clients, own port (61337) — see `phosphor/README.md` to get started.

## License

[MIT](LICENSE).
