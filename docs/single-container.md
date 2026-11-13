# One container for the complete application

The root Dockerfile bundles StreamRD, Phosphor and qBittorrent in one image and
runs them in one container (Phosphor only when it is turned on). The web interfaces, their APIs, background workers,
SQLite databases and the local download client are included. There is nothing else to start: the pages start Plex and Jellyfin, update StreamRD and
restart it. For that, the installer gives the container Docker's socket and runs one small helper inside it; read
[Docker control](plex-jellyfin.md#docker-control) for what that means, and decline it with `--no-media-manager` if you would rather not.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Installation-04/StreamRD/main/install.sh | bash
```

This creates `~/streamrd` with one `docker-compose.yml`, a small `.env`, and two folders:

| Folder | Mounted at | Holds |
|---|---|---|
| `config/` | `/config` | Everything that is *settings*: both databases and their backups/snapshots, signing keys and generated passwords, the download client's settings |
| `data/` | `/data` | Downloads and media: `data/downloads` by default, and anything you mount for Plex/Jellyfin exports |

On a bare Linux machine this one command is enough: it first installs what is missing (see
[What the installer does to the machine](#what-the-installer-does-to-the-machine)). Run from a terminal on a first install, the script asks how you want it: **Default**, or **Advanced** (folder, every port, Phosphor
and qBittorrent on or off, Jellyfin and/or Plex, Zilean, Zurg, the reserved administrator email) and shows a summary to confirm.
Options you pass skip their question; `--yes`, or running without a terminal, skips all of them.

Open StreamRD at `http://YOUR_SERVER:8080` (use `--port` to change it, `--no-qbittorrent` to leave the download client out).
Phosphor is off unless you ask for it: add `--phosphor` (and `--phosphor-port` to change its port, default 8081) to the install, or run the
installer again with `--phosphor` later; `--no-phosphor` turns it off again, and its data is kept.
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

The container runs as UID/GID 1000, so `config` and `data` must be writable by it (`install.sh` does this for you).
Only `CONFIG_DIR=/config` is new compared with the first all-in-one release: without it everything lives under
`/data`, exactly as before.

## What the installer does to the machine

StreamRD needs Docker with the Compose plugin, and `curl` and `tar` for the installer itself. On **Linux** the installer installs whatever is
missing, so a machine with nothing on it needs only the one command above:

1. **`curl`, `tar` and the certificates**, with the machine's package manager (apt, dnf, yum, zypper, pacman or apk).
2. **Docker Engine and the Compose plugin.** On Debian, Ubuntu, Raspberry Pi OS, Fedora and CentOS/RHEL and their relatives it runs
   [Docker's own installation script](https://get.docker.com) (as root: the same thing as `curl -fsSL https://get.docker.com | sudo sh`). Where
   that script does not support the system, or fails, it uses the distribution's own packages (Docker, plus the Compose plugin; on Arch and
   Alpine these are the only route). If the Compose plugin is still missing it downloads Docker's release of it and installs it only if it
   matches the checksum published beside it.
3. **The Docker service**, started now and set to start with the machine (systemd, OpenRC or `service`).
4. **FUSE**, only if you choose Zurg and `/dev/fuse` is missing.

**Who is asked.** In a terminal, you are asked once, before anything is installed (`[Y/n]`; sudo may ask for your password). With `--yes`, or when
there is no terminal, it goes ahead without asking, so long as it can get root: as root, or through a `sudo` that works from where the script runs.
Otherwise it stops and says so, having installed nothing.

**Say no.** `--no-install-docker` (or `STREAMRD_NO_INSTALL_DOCKER=1`) installs nothing and starts nothing: it stops with what is missing and a
link to Docker's instructions. `--uninstall` never installs anything. `--prepare` installs and starts what the machine needs, then stops before it
makes any of StreamRD's folders, which is a way to prepare a machine without installing StreamRD yet.

**What it does not do.** It does not add you to the `docker` group, because membership is the same as root on that machine. When Docker answers only to root,
the installer runs Docker through `sudo` for that run, and the commands it prints at the end start with `sudo docker`. It does not open firewall
ports or set up HTTPS, and it does not install anything from a source other than the ones above.

**Mac and Windows.** Docker Desktop cannot be installed without a person at the screen (its licence and its first start), so on a Mac or Windows
machine the installer says what to install and stops. On Windows run it from a WSL 2 terminal with Docker Desktop's WSL integration on.

**Checked** against bare Ubuntu 24.04 and Debian 12 images in CI (`installer-bare` in `.github/workflows/single-container.yml`): the script installs curl,
tar, Docker and the Compose plugin, starts Docker, and `docker info` answers. Every decision it makes (root, sudo, each package manager, a failed script,
the checksum, refusing) is exercised by `infra/test-install-script.sh` against recording stand-ins. **Not run on a real machine:** Fedora, CentOS,
RHEL, openSUSE, Arch and Alpine, and a Raspberry Pi; those use the same code paths but their package names and services were not tried.

## Updating

```bash
cd ~/streamrd
docker compose pull && docker compose up -d
```

That is all: the new image replaces the old container, and `config/` and `data/` are not modified. On start the
server snapshots each database (verified) before applying any migration. You can also just re-run `install.sh`, which
does the same and keeps your ports and settings. To go back, set `STREAMRD_TAG=0.8.1` (an earlier version) in `.env` and run
`docker compose up -d`; restore the snapshot from `config/streamrd/backups/` if a release changed the database (including 0.10, which encrypts stored credentials; the key stays in `config/secrets`).

**One click.** With Docker control (part of every install unless you declined it; running `bash install.sh` again adds it to an older one),
**Admin → System → Updates** shows an **Update** button. It takes a verified backup, downloads the new image, replaces the StreamRD container with
it (same ports, folders, settings and network), waits until it is healthy and removes the old one. If the new version does not start, the old
container is put back automatically and the page says so. The helper can only replace the StreamRD container it lives in and only with a newer
image of the reference it already runs; the replacement is done by a short-lived updater container, so a plain `docker compose pull && docker compose up -d`
does the same thing and the two never disagree. The helper is part of the image, so every update brings the new helper with it.

**The programs started next to StreamRD** (Prowlarr, Jellyfin, Plex) are separate containers with their own releases, so a StreamRD update does not
change them. **Admin → System → Add-ons** checks each one for a newer version and updates it on request, or by itself at night if you turn that on for
that module: see [Updating Prowlarr, Jellyfin and Plex](plex-jellyfin.md#updating-prowlarr-jellyfin-and-plex).

Without Docker control, updates are not applied by the app itself. **Admin → System** tells you when
a newer release exists and shows the command. For automatic updates run
[Watchtower](https://containrrr.dev/watchtower/): the compose file already carries its opt-in label
(`com.centurylinklabs.watchtower.enable`). Watchtower can also serve an HTTP update endpoint; point
`UPDATE_WEBHOOK_URL` and `UPDATE_WEBHOOK_TOKEN` at it and Admin → System shows a one-click **Update** button
(it takes a verified backup first).

## Optional add-ons

The installer turns on Docker control (unless you pass `--no-media-manager`) so **Setup → Plex or Jellyfin** can start them later, with a place for the Plex claim token, the Plex token and the Jellyfin API key; see [Start Plex or Jellyfin from StreamRD's Setup page](plex-jellyfin.md#start-plex-or-jellyfin-from-streamrds-setup-page) and [Docker control](plex-jellyfin.md#docker-control) for what it can and cannot do (it uses the Docker socket, so read it before exposing the server to the internet).

`install.sh --media-server jellyfin|plex|both` runs [Jellyfin and/or Plex](plex-jellyfin.md#built-in-jellyfin-and-plex) in the same Compose project, already mapped to the
libraries StreamRD and Phosphor export and to your downloads, with their own settings kept under `config/jellyfin` and `config/plex`. Choose their ports with
`--jellyfin-port` and `--plex-port` (defaults 8096 and 32400).

`install.sh --zilean` runs [Zilean](zilean-zurg.md#zilean-an-indexer-of-debrid-media-managers-cached-torrents) as a Torznab indexer for Phosphor, and
`install.sh --zurg --rd-token …` mounts your Real-Debrid movies and shows. Both are optional Compose overlays kept in your install folder; see
[Movies and shows only, plus Zilean and Zurg](zilean-zurg.md) for what they do and what is and is not verified. Account scans also skip games,
software and other non-movie items.

## Prebuilt image

Each version tag publishes the image to this repository's GitHub Container Registry (`publish-image.yml`),
for `linux/amd64` only. The package is private until you make it public in the repository's package settings;
until then `install.sh` falls back to building from source. Pin a version tag in production if you do not want
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
   curl -fsSL https://raw.githubusercontent.com/Installation-04/StreamRD/main/install.sh | bash -s -- \
     --port 3000 --no-qbittorrent --import-db ~/streamrd-import.db --jwt-secret 'YOUR_OLD_JWT_SECRET'
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
| `/config/secrets` | Stable session signing keys, the keys that encrypt stored credentials, and the local client's generated password |
| `/data/downloads` | Default local download location |

**Credentials are encrypted in the databases.** Debrid keys (both products), Phosphor's indexer API keys and the qBittorrent
connection password are stored with AES-256-GCM, using a key generated into `config/secrets/streamrd-data-key` and
`phosphor-data-key` (or `STREAMRD_DATA_KEY` / `PHOSPHOR_DATA_KEY`; split installs set `DATA_ENCRYPTION_KEY`, or the key is derived
from `JWT_SECRET`). A database backup alone no longer exposes those credentials, but it also cannot be read without the key:
**keep `config/secrets` with your backups.** If the key is lost or changed, the affected credentials read as "not configured" and
you enter them again. Plaintext values from earlier versions are encrypted automatically the first time version 0.10 starts.

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
| `ENABLE_PHOSPHOR` | Off unless set to `true`. A new install written by `install.sh` has `false` in `.env`. Left empty, a configuration folder that already holds Phosphor's data keeps it running |
| `ENABLE_QBITTORRENT` | `true`; set `false` for cloud-only use |
| `ADMIN_EMAIL` | Optional administrator email for both products |
| `STREAMRD_ADMIN_EMAIL`, `PHOSPHOR_ADMIN_EMAIL` | Product-specific administrator overrides |
| `STREAMRD_JWT_SECRET`, `PHOSPHOR_JWT_SECRET` | Optional explicit signing keys, at least 32 characters; changing one invalidates old sessions |
| `QBIT_USERNAME` | `admin`; use letters, numbers, dot, underscore or hyphen |
| `QBIT_PASSWORD` | Optional explicit password of at least 16 characters; otherwise generated and persisted |
| `CONFIG_DIR` | Where settings and databases live (`/config` in the provided compose file); unset keeps everything under `DATA_DIR` |
| `MEDIA_SOURCE_ROOT` | `/data/downloads`; may point to a separately mounted media directory |
| `STREAMRD_DATA_KEY`, `PHOSPHOR_DATA_KEY` | Optional explicit keys (at least 16 characters) for encrypting stored credentials; otherwise generated under `/config/secrets` |
| `LINK_HEALTH` | Set to `false` to turn off the background check of every imported link (on by default). Also a choice in **Admin → Server**; a choice saved there takes the place of this variable |
| `LINK_HEALTH_BATCH` | How many imports are checked per minute (default 3, at most 20) |
| `TRANSCODE` | Set to `false` to stop converting files a browser cannot play (on by default). Like the three below, also a choice in **Admin → Server**, in force at once; a choice saved there takes the place of the variable |
| `TRANSCODE_VIDEO` | Set to `false` to allow only the light conversions (repackaging and audio), never re-encoding video |
| `TRANSCODE_MAX` | How many videos may be converted at once (default 2, at most 8); more get a "try again" |
| `TRANSCODE_ALLOW_PRIVATE_HOSTS` | Set to `true` only if your media links are on your own network (a local address); off by default |
| `HOME_TRAILERS` | Set to `false` to remove trailers (played in the viewer's browser from YouTube, only after they opt in) from the home page carousel |
| `HOME_EXTERNAL_LISTS` | Set to `false` to hide the trending and popular rows on the home page, which are fetched from public Cinemeta catalogues and cached |
| `TMDB_DEFAULT_API_KEY` | Optional TMDB key (API key or read access token) shared by everyone on this server; used only until an administrator saves a key in Admin → Metadata |
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
