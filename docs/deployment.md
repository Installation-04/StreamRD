# Deployment

## Recommended: one container

From the repository root, run `docker compose up -d --build`. The default
`compose.yaml` starts one service with StreamRD on 8080, Phosphor on 8081 and
qBittorrent internally. Both APIs, workers, databases and downloader are bundled.
See the [single-container guide](single-container.md) for persistent data, generated
credentials, local requests and HTTPS.

## Existing split deployments

The remaining instructions describe the legacy topology under `infra/`. Its
installer and data volumes remain supported; do not replace an existing deployment
with the new data layout without a backup and explicit migration.

For existing installations, read the [production upgrade and backup guide](production-runtime.md)
before replacing images: runtime containers now use UID 1000.

The backend is one container with a SQLite volume; the web client is a second
container (or `npm run start` anywhere Node runs). Mobile/TV apps are
installed on devices and pointed at your server URL.

## 0. One-line installer (Debian/Ubuntu)

```bash
git clone https://github.com/installation-04/streamrd.git
cd streamrd/infra
sudo ./install.sh
```

Installs Docker if it isn't already present, picks a free host port for the
API and web app (starting from 47821/3000, walking upward if either is
already bound by something else on the box), generates a random
`JWT_SECRET`, writes a private `.env` on first install, and starts the backend + web containers. Prints
the URLs to open when it's done. Override the starting ports with
`--api-port`/`--web-port` on first install if you want specific ones tried first.
Reruns preserve the existing `.env`, signing secret, and public URLs; edit that
file explicitly to change an existing configuration.

To remove it: `sudo ./uninstall.sh` (add `--purge-data` to also delete the
database, or `--purge-images` to also remove the built images).

The installer skips the Caddy reverse-proxy/HTTPS service — see step 3
below to add that manually once you've picked a domain.

## 1. Docker Compose (manual)

```bash
git clone https://github.com/installation-04/streamrd.git
cd streamrd/infra
cp ../server/.env.example .env         # edit JWT_SECRET at minimum
docker compose up -d --build
```

Services:

| Service | Port | Notes |
|---|---|---|
| `backend` | 47821 | Express API; SQLite persisted in the `backend-data` volume |
| `web` | 3000 | Next.js UI; `NEXT_PUBLIC_API_BASE_URL` is baked at build time |
| `proxy` | 80/443 | Caddy; automatic HTTPS when `DOMAIN` is a public hostname |

The backend applies the schema on boot by default, without accepting data loss.
Set `APPLY_SCHEMA_ON_START=false` for a controlled, backed-up upgrade workflow
described in the production guide. Seed demo titles with:

```bash
docker compose exec backend node dist/prisma/seed.js   # or: npm run db:seed in dev
```

## 2. LAN mode

Skip the proxy (comment it out of `docker-compose.yml`). Clients use:

- Web: `http://<lan-ip>:3000` (build web with `API_BASE_URL=http://<lan-ip>:47821`)
- Mobile/TV: set Server URL to `http://<lan-ip>:47821` in the app settings

Remember `CORS_ORIGINS` should include the web origin (or stay `*`), and
plain-HTTP LAN URLs may need cleartext/ATS exceptions in production mobile
builds (dev builds and Expo Go are fine).

## 3. Reverse proxy + HTTPS

**Caddy** (bundled): set `DOMAIN=media.example.com` in `infra/.env`, point
the domain's DNS at your host, open ports 80/443, and `docker compose up -d`.
Caddy provisions Let's Encrypt certificates automatically and routes
`/api/*` → backend, everything else → web.

Set `API_BASE_URL=https://media.example.com` so the web build calls the API
through the same origin (no CORS involved), and use that URL in mobile/TV
settings.

**Nginx**: use `infra/reverse-proxy/nginx.conf` as a starting point together
with certbot for certificates. Keep `proxy_buffering off` for the API — it
returns redirect-style stream URLs quickly, but log streaming and large
exports benefit from unbuffered responses.

## 4. VPN

Run WireGuard or Tailscale on the host and treat it exactly like LAN with the
tunnel IP (`http://100.x.y.z:47821` for Tailscale). This is the easiest way to
get remote access without exposing anything publicly; HTTPS is optional
because the tunnel is already encrypted.

## Environment variables

Backend (`server/.env`):

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | API port | `47821` |
| `DATABASE_URL` | Prisma datasource (`file:` for SQLite) | `file:./data/streamrd.db` |
| `JWT_SECRET` | Stable session signing key, at least 32 bytes in production | required in production |
| `JWT_EXPIRES_IN` | Session lifetime | `7d` |
| `API_BASE_URL` / `LAN_URL` / `PUBLIC_URL` | Reachability hints for docs/clients | localhost |
| `CORS_ORIGINS` | Comma-separated allowed origins or `*` | `*` |
| `ADMIN_EMAIL` | Auto-promote this account to admin | empty |

Web (`web/.env` or build arg): `NEXT_PUBLIC_API_BASE_URL` — must be the URL
**the browser** uses, not a Docker-internal hostname.

## Backups

- Database: create a consistent, verified snapshot with
  `docker compose exec backend node scripts/backup-db.cjs /app/data/backup-unique.db`,
  then copy that snapshot off-host. See the production guide for restore checks.
- Configuration & catalog: Admin → Server → **Export config**, or
  `GET /api/admin/export/config`; the JSON re-imports via
  `POST /api/admin/import/config` and versions nicely in git.

## Health checks

`GET /api/health` is unauthenticated and returns `503` when the database is
unreachable — suitable for Docker healthchecks (already wired in compose),
uptime monitors and every client's "Test connection" button.

## Versioned database upgrades

Starting in v0.4.0, startup uses committed migrations and validates existing schema/history
before changes. Known existing databases receive verified pre-upgrade snapshots.
See the [upgrade and recovery guide](https://github.com/Installation-04/StreamRD/blob/main/docs/database-upgrades.md).
Admin → System reports actual readiness; it never applies changes from the browser.
