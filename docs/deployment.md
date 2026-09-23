# Deployment

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
`JWT_SECRET`, writes `.env`, and starts the backend + web containers. Prints
the URLs to open when it's done. Override the starting ports with
`--api-port`/`--web-port` if you want specific ones tried first.

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

The backend runs `prisma db push` on boot, so the schema is applied
automatically. Seed demo titles with:

```bash
docker compose exec backend npx tsx prisma/seed.ts   # or: npm run db:seed in dev
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

## 3b. Web client on Netlify

Netlify hosts the Next.js frontend (`web/`) only — it can't run the
Express/Prisma/SQLite backend, so run the backend anywhere reachable over
HTTPS first (steps 0–1 above, a VPS, etc.) and point the web build at it.

`web/netlify.toml` is already set up (build command, publish dir,
`@netlify/plugin-nextjs`, which turns API routes/middleware into Netlify
Functions/Edge Functions). To deploy:

**Via the Netlify UI** — New site from Git → pick this repo → set
**Base directory** to `web` (Netlify then picks up `web/netlify.toml`
automatically) → add the `NEXT_PUBLIC_API_BASE_URL` environment variable
(your backend's public URL, e.g. `https://api.example.com`) → Deploy.

**Via the CLI**:

```bash
cd web
npx netlify init          # link to a new or existing Netlify site
npx netlify env:set NEXT_PUBLIC_API_BASE_URL https://api.example.com
npx netlify deploy --build --prod
```

Also set `CORS_ORIGINS` on the backend to your Netlify site's URL (or keep
it `*`) so the browser can call the API cross-origin — Netlify and the
backend are different origins unless you put both behind the same reverse
proxy/domain.

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
| `JWT_SECRET` | Session signing key — **change it** | dev value |
| `JWT_EXPIRES_IN` | Session lifetime | `7d` |
| `API_BASE_URL` / `LAN_URL` / `PUBLIC_URL` | Reachability hints for docs/clients | localhost |
| `CORS_ORIGINS` | Comma-separated allowed origins or `*` | `*` |
| `ADMIN_EMAIL` | Auto-promote this account to admin | empty |

Web (`web/.env` or build arg): `NEXT_PUBLIC_API_BASE_URL` — must be the URL
**the browser** uses, not a Docker-internal hostname.

## Backups

- Database: copy the SQLite file from the `backend-data` volume
  (`docker compose cp backend:/app/data/streamrd.db ./backup/`).
- Configuration & catalog: Admin → Server → **Export config**, or
  `GET /api/admin/export/config`; the JSON re-imports via
  `POST /api/admin/import/config` and versions nicely in git.

## Health checks

`GET /api/health` is unauthenticated and returns `503` when the database is
unreachable — suitable for Docker healthchecks (already wired in compose),
uptime monitors and every client's "Test connection" button.
