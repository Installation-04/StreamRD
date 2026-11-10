# One container for the complete application

The root Dockerfile bundles StreamRD, Phosphor and qBittorrent in one image and
runs them in one container. Both web interfaces, their APIs, background workers,
SQLite databases and the local download client are included. No Docker socket or
Docker-in-Docker service is needed inside the application.

The quickest route is the one-line installer in the [README](../README.md#quick-install)
(`get.sh`). Otherwise, from a checkout of the release:

```bash
docker compose up -d --build
```

Open StreamRD at `http://YOUR_SERVER:8080` and Phosphor at
`http://YOUR_SERVER:8081`. Each interface sends API calls to its own browser origin;
you do not need to expose ports 47821 or 61337, or compile a public API hostname.
The products keep separate accounts, sessions and databases.

The Compose file starts exactly one service and mounts a named volume at `/data`.
It also publishes qBittorrent's peer port 6881 over TCP and UDP. The internal
qBittorrent Web UI binds to loopback port 8082 and is not published to the host.
Plex, Jellyfin, debrid subscriptions, metadata providers and external indexers are
integrations rather than software bundled in this image.

## Prebuilt image

Each version tag also publishes the image to this repository's GitHub Container
Registry (`publish-image.yml`), for `linux/amd64` only:

```bash
docker pull ghcr.io/installation-04/streamrd:latest   # or a version such as :0.8.0
```

To run it instead of building, set `image:` to that name in
`infra/docker-compose.single.yml`. The package is created private by default; make it
public in the repository's package settings if you want anonymous pulls. Pin a
version in production and use **Admin → System** or your updater to move forward.
The image is built from the tagged source by GitHub Actions; it is not signed.

## Persistent data

| Path inside the container | Purpose |
|---|---|
| `/data/streamrd` | StreamRD SQLite database, migration snapshots and scanner exports |
| `/data/phosphor` | Phosphor database, snapshots and exports |
| `/data/qbittorrent` | qBittorrent configuration, resume data and transfer state |
| `/data/downloads` | Default local download location |
| `/data/secrets` | Stable session signing keys and the local client's generated password |

Keep the volume when updating or recreating the container. `docker compose down`
keeps it; adding `-v` deletes it. Generated secrets are private files, not values
baked into the image. Back up the whole volume with the container stopped for a
consistent copy of application and downloader state. Existing API-level SQLite
backup/restore tools remain available under `/opt/streamrd/server/scripts` and
`/opt/phosphor/server/scripts`.

The runtime user has UID/GID 1000. Named volumes inherit the image's permissions.
For bind mounts, prepare writable directories for that UID before starting.
Do not point this new layout at an old database directory without first backing
it up and arranging the documented product-specific paths.

## Enable local requests

Create your administrator account, then open **Admin → Download settings**.
Configure the bundled qBittorrent connection with:

- Web UI URL: `http://127.0.0.1:8082`
- Username: `admin`, unless `QBIT_USERNAME` was set
- Password: the generated value stored in `/data/secrets/qbittorrent-password`

The container operator can retrieve the password when configuring the app:

```bash
docker compose exec streamrd cat /data/secrets/qbittorrent-password
```

Save and test the connection. It stays on the server; viewers never receive the
password. Requests still require administrator approval. Completed local downloads
remain awaiting library import rather than receiving an invented Play link. See
[requesting and tracking media](media-requests.md).

For optional Plex/Jellyfin exports, mount the same data volume at `/data` in the
scanner's container so absolute symlink targets remain valid. Configure the
scanner to read the appropriate `/data/streamrd/library` or Phosphor export
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
| `MEDIA_SOURCE_ROOT` | `/data/downloads`; may point to a separately mounted media directory |
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
