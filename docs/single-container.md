# One container for the complete application

The root Dockerfile bundles StreamRD, Phosphor and qBittorrent in one image and
runs them in one container. Both web interfaces, their APIs, background workers,
SQLite databases and the local download client are included. No Docker socket or
Docker-in-Docker service is needed inside the application.

## Install (the Radarr/Sonarr way)

```bash
curl -fsSL https://raw.githubusercontent.com/Installation-04/StreamRD/main/get.sh | bash
```

This creates `~/streamrd` with one `docker-compose.yml`, a small `.env`, and two folders:

| Folder | Mounted at | Holds |
|---|---|---|
| `config/` | `/config` | Everything that is *settings*: both databases and their backups/snapshots, signing keys and generated passwords, the download client's settings |
| `data/` | `/data` | Downloads and media: `data/downloads` by default, and anything you mount for Plex/Jellyfin exports |

Open StreamRD at `http://YOUR_SERVER:8080` and Phosphor at `http://YOUR_SERVER:8081` (use
`--port` and `--phosphor-port` to change them, `--no-phosphor` / `--no-qbittorrent` to leave a part out).
Each interface sends API calls to its own browser origin, so ports 47821 and 61337 are never exposed.
The products keep separate accounts, sessions and databases. Plex, Jellyfin, debrid subscriptions, metadata
providers and indexers are integrations, not software inside this image.

Prefer to write the compose file yourself? This is the whole thing:

```yaml
services:
  streamrd:
    image: ghcr.io/installation-04/streamrd:latest
    container_name: streamrd
    restart: unless-stopped
    ports: ["8080:8080", "8081:8081", "6881:6881/tcp", "6881:6881/udp"]
    environment:
      CONFIG_DIR: /config
      TZ: UTC
    volumes:
      - ./config:/config
      - ./data:/data
```

The container runs as UID/GID 1000, so `config` and `data` must be writable by it (`get.sh` does this for you).
Only `CONFIG_DIR=/config` is new compared with the first all-in-one release: without it everything lives under
`/data`, exactly as before.

## Updating

```bash
cd ~/streamrd
docker compose pull && docker compose up -d
```

That is all: the new image replaces the old container, and `config/` and `data/` are not modified. On start the
server snapshots each database (verified) before applying any migration. You can also just re-run `get.sh`, which
does the same and keeps your ports and settings. To go back, set `STREAMRD_TAG=0.8.1` (an earlier version) in `.env` and run
`docker compose up -d`; restore the snapshot from `config/streamrd/backups/` if a release changed the database.

Updates are never applied by the app itself, as with Radarr and Sonarr in Docker. **Admin → System** tells you when
a newer release exists and shows the command. For automatic updates run
[Watchtower](https://containrrr.dev/watchtower/): the compose file already carries its opt-in label
(`com.centurylinklabs.watchtower.enable`). Watchtower can also serve an HTTP update endpoint; point
`UPDATE_WEBHOOK_URL` and `UPDATE_WEBHOOK_TOKEN` at it and Admin → System shows a one-click **Update** button
(it takes a verified backup first).

## Optional add-ons

`get.sh --zilean` runs [Zilean](zilean-zurg.md#zilean-an-indexer-of-debrid-media-managers-cached-torrents) as a Torznab indexer for Phosphor, and
`get.sh --zurg --rd-token …` mounts your Real-Debrid movies and shows. Both are optional Compose overlays kept in your install folder; see
[Movies and shows only, plus Zilean and Zurg](zilean-zurg.md) for what they do and what is and is not verified. Account scans also skip games,
software and other non-movie items.

## Prebuilt image

Each version tag publishes the image to this repository's GitHub Container Registry (`publish-image.yml`),
for `linux/amd64` only. The package is private until you make it public in the repository's package settings;
until then `get.sh` falls back to building from source. Pin a version tag in production if you do not want
unattended major changes. The image is built from the tagged source by GitHub Actions and is not signed.

## Moving from a split install (`infra/`, separate backend and web containers)

1. In the old install folder take a verified backup and copy it out:
   ```bash
   docker compose exec backend node scripts/backup-db.cjs /app/data/migrate.db
   docker compose cp backend:/app/data/migrate.db ~/streamrd-import.db
   ```
2. Note your old `JWT_SECRET` from its `.env`.
3. Install with the import (the same web port as before keeps your bookmarks working):
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Installation-04/StreamRD/main/get.sh | bash -s -- \
     --port 3000 --no-phosphor --no-qbittorrent --import-db ~/streamrd-import.db --jwt-secret 'YOUR_OLD_JWT_SECRET'
   ```
   Stop the old stack first (`docker compose down`, without `-v`) so the port is free. Your accounts, provider
   keys, libraries and metadata come across, and existing logins stay valid because the signing key is the same.
   `--import-db` only works on a first install and never overwrites an existing database. Keep the old volume until
   you have checked everything.

## Moving from the first all-in-one layout (one `/data` volume)

Nothing changes if you keep running it. To adopt `config/` and `data/`, stop the container and move
`secrets`, `streamrd`, `phosphor` and `qbittorrent` from the old volume into `config/`, and `downloads` into `data/`, then
start with `CONFIG_DIR=/config`. Back the volume up first.

## Persistent data

| Path | Purpose |
|---|---|
| `/config/streamrd` | StreamRD SQLite database, `backups/` and migration snapshots, scanner exports |
| `/config/phosphor` | Phosphor database, snapshots and exports |
| `/config/qbittorrent` | qBittorrent configuration, resume data and transfer state |
| `/config/secrets` | Stable session signing keys and the local client's generated password |
| `/data/downloads` | Default local download location |

Back up `config/` (with the container stopped for a copy that includes the downloader's state, or use the
**Admin → System** backup for the databases). `docker compose down` keeps both folders. Generated secrets are private
files, not values baked into the image. The API-level SQLite backup/restore tools remain available under
`/opt/streamrd/server/scripts` and `/opt/phosphor/server/scripts`.

## Enable local requests

Create your administrator account, then open **Admin → Download settings**.
Configure the bundled qBittorrent connection with:

- Web UI URL: `http://127.0.0.1:8082`
- Username: `admin`, unless `QBIT_USERNAME` was set
- Password: the generated value stored in `/config/secrets/qbittorrent-password`

The container operator can retrieve the password when configuring the app:

```bash
docker compose exec streamrd cat /config/secrets/qbittorrent-password
```

Save and test the connection. It stays on the server; viewers never receive the
password. Requests still require administrator approval. Completed local downloads
remain awaiting library import rather than receiving an invented Play link. See
[requesting and tracking media](media-requests.md).

For optional Plex/Jellyfin exports, mount the same `config` and `data` folders at `/config` and `/data` in the
scanner's container so absolute symlink targets remain valid. Configure the
scanner to read the appropriate `/config/streamrd/library` or Phosphor export
folder. Source preservation and mounted-library rules remain unchanged.

## Configuration

| Variable | Default / effect |
|---|---|
| `ENABLE_PHOSPHOR` | `true`; set `false` to omit the companion processes and port listener |
| `ENABLE_QBITTORRENT` | `true`; set `false` for cloud-only use |
| `ADMIN_EMAIL` | Optional administrator email for both products |
| `STREAMRD_ADMIN_EMAIL`, `PHOSPHOR_ADMIN_EMAIL` | Product-specific administrator overrides |
| `STREAMRD_JWT_SECRET`, `PHOSPHOR_JWT_SECRET` | Optional explicit signing keys, at least 32 characters; changing one invalidates old sessions |
| `QBIT_USERNAME` | `admin`; use letters, numbers, dot, underscore or hyphen |
| `QBIT_PASSWORD` | Optional explicit password of at least 16 characters; otherwise generated and persisted |
| `CONFIG_DIR` | Where settings and databases live (`/config` in the provided compose file); unset keeps everything under `DATA_DIR` |
| `MEDIA_SOURCE_ROOT` | `/data/downloads`; may point to a separately mounted media directory |
| `CORS_ORIGINS` | Empty (same-origin only); comma-separated origins if another web app calls the APIs |
| `SQLITE_WAL` | `true`; set `false` only if the data folder is on a network file system |
| `TRUST_PROXY` | `false`; enable only behind your own trusted HTTPS reverse proxy to honor its protocol header |

Use your usual HTTPS reverse proxy in front of the published UI ports when exposing
this server publicly. Keep direct access to the gateway restricted when trusting
proxy headers. The image itself provides HTTP and does not manage certificates.

## Startup and recovery

Both databases are migrated before normal services start, with the existing
verified snapshot policy. A failed migration prevents startup. Tini reaps child
processes; the supervisor forwards shutdown signals to the apps and downloader.
If an essential process exits, the container stops rather than presenting a
partially working installation. Compose's restart policy can then recover it.

The Docker health check verifies both enabled web/API pairs and the downloader's
listener. Use a 30-second stop grace period so qBittorrent can flush its resume
state. No provider content is deleted by shutdown, health checks or restart.

For a normal build, `docker build -t streamrd-all-in-one .` is sufficient. Managed
cloud environments that inspect TLS can pass their supplied CA using BuildKit's
`--secret id=proxy_ca,src=...`; no such certificate is copied into the image.
