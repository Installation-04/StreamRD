# Deployment

For existing installations, read the [production upgrade and backup guide](../../docs/production-runtime.md)
before replacing images: runtime containers now use UID 1000.

The backend is one container with a SQLite volume; the web client is a
second container (or `npm run start` anywhere Node runs). TV/desktop clients
are installed on devices and pointed at your server/web URL.

## 0. One-line installer (Debian/Ubuntu)

```bash
git clone https://github.com/installation-04/streamrd.git
cd streamrd/phosphor/infra
sudo ./install.sh
```

Installs Docker if it isn't already present, picks a free host port for the
API and web app (starting from 61337/3100, walking upward if either is
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
cd streamrd/phosphor/infra
cp ../server/.env.example .env         # edit JWT_SECRET at minimum
docker compose up -d --build
```

| Service | Port | Notes |
|---|---|---|
| `backend` | 61337 | Express API; SQLite persisted in the `backend-data` volume |
| `web` | 3100 | Next.js UI; `NEXT_PUBLIC_API_BASE_URL` is baked at build time |
| `proxy` | 80/443 | Caddy; automatic HTTPS when `DOMAIN` is a public hostname |
| `jackett` (optional) | 9117 | Uncomment in `docker-compose.yml` to run an indexer aggregator alongside Phosphor |

Then: sign up on the web app (first account becomes admin), add indexers
under Admin → Indexers (see [indexers.md](indexers.md)), add your debrid
API keys under Account → Debrid.

## 2. LAN mode

Skip the proxy (comment it out of `docker-compose.yml`). Clients use:

- Web: `http://<lan-ip>:3100` (build with `API_BASE_URL=http://<lan-ip>:61337`)
- TV/Desktop: point at `http://<lan-ip>:61337` (TV apps) or
  `http://<lan-ip>:3100` (desktop wrapper, which loads the web app directly)

## 3. Reverse proxy + HTTPS

**Caddy** (bundled): set `DOMAIN=phosphor.example.com` in `infra/.env`,
point DNS at the host, open ports 80/443, `docker compose up -d`. Set
`API_BASE_URL=https://phosphor.example.com` so the web build calls the API
through the same origin.

**Nginx**: `infra/reverse-proxy/nginx.conf` + certbot. Keep
`proxy_buffering off` — stream URLs and Torznab search responses should
pass through promptly.

## 4. VPN

WireGuard or Tailscale on the host, treated exactly like LAN with the
tunnel IP.

## Environment variables

Backend (`phosphor/server/.env`):

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | API port | `61337` |
| `DATABASE_URL` | Prisma datasource | `file:./data/phosphor.db` |
| `JWT_SECRET` | Stable session signing key, at least 32 bytes in production | required in production |
| `JWT_EXPIRES_IN` | Session lifetime | `7d` |
| `API_BASE_URL` / `LAN_URL` / `PUBLIC_URL` | Reachability hints | localhost |
| `CORS_ORIGINS` | Comma-separated allowed origins or `*` | `*` |
| `ADMIN_EMAIL` | Auto-promote this account to admin | empty |

Web (`phosphor/web/.env` or build arg): `NEXT_PUBLIC_API_BASE_URL` — the URL
**the browser** uses, not a Docker-internal hostname.

## Backups

Admin → Server → **Export config** downloads server settings, provider
settings, and indexer configs (including plaintext API keys — keep the
file private) as JSON, re-importable via the same page. User accounts,
debrid keys, and download history live in the SQLite database file — back
that up separately with
`docker compose exec backend node scripts/backup-db.cjs /app/data/backup-unique.db`,
then copy that verified snapshot off-host. See the production guide for restore checks.

## Health checks

`GET /api/health` is unauthenticated and returns `503` when the database is
unreachable — used by the Docker healthcheck and every client's "test
connection" action.
