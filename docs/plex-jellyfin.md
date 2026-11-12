# Plex and Jellyfin symlink libraries

Both StreamRD and Phosphor can export mounted media into a library that Plex and
Jellyfin scan as normal movie and episode files. This is optional: normal debrid
URL playback remains available without a filesystem mount.

## What you need

A local filesystem view of your media, such as an rclone/Zurg mount, is required
for symlink export. Configure that tool with your own account separately. StreamRD
and Phosphor do not mount debrid, implement WebDAV/FUSE, or turn HTTPS URLs into
filesystem paths. Provider URLs can expire; they are never written into symlinks.
Export a file only after it exists on the mount. The mount serves bytes when
Plex/Jellyfin opens the symlink, so no duplicate media copy is created.

Exports are reviewed under **Admin → Plex / Jellyfin** in either app.
Browse mounted folders, select up to 100 videos, and review the suggested movie/
series name, year, and season/episode numbers before exporting. You can also enter
a relative file path manually and add it to review. This deliberate mapping avoids guessing which files in a
provider pack correspond to a catalog title or download. The browser lists existing mounted files; provider-to-mount matching and scanner
API integration remain manual. Filename guesses are not metadata verification.

## Built-in Jellyfin and Plex

With the one-command install you can have the media server set up for you. Choose it in the installer's Advanced menu, or:

```bash
bash install.sh --media-server jellyfin     # or plex, or both; --media-server none removes them (their settings are kept)
bash install.sh --media-server plex --plex-port 32400 --plex-claim TOKEN   # claim token optional: https://plex.tv/claim
```

It adds `docker-compose.jellyfin.yml` and/or `docker-compose.plex.yml` to your install folder and lists them in `COMPOSE_FILE`, so
`docker compose pull && docker compose up -d` keeps them updated. Everything is already mapped, read-only:

| Inside Jellyfin / Plex | Is | Why |
|---|---|---|
| `/library/streamrd`, `/library/phosphor` | the folders StreamRD and Phosphor export (`config/streamrd/library`, `config/phosphor/library`) | the Movies and TV Shows you add as libraries |
| `/data` | your downloads (`data/`) | the exported links point at `/data/downloads/...`, so the same path must exist |
| `/mnt/zurg` | your Real-Debrid mount, when Zurg is on | same reason |

In the media server's own setup add **Movies** with folder `/library/streamrd/Movies` and **TV Shows** with `/library/streamrd/TV Shows` (and the
same under `/library/phosphor` if you export from Phosphor), then scan. Jellyfin is at `http://YOUR_SERVER:8096`, Plex at `http://YOUR_SERVER:32400/web`.
Their settings and caches live in `config/jellyfin` and `config/plex`, so backing up `config/` keeps them. Plex discovery on your LAN (DLNA, GDM)
is limited by Docker's bridge network; set `network_mode: host` on the `plex` service in `docker-compose.plex.yml` if you need it (then remove its `ports`).

## Start Plex or Jellyfin from StreamRD's Setup page

Instead of choosing at install time, you can start them later from **Setup → Plex or Jellyfin** (Admin → Plex / Jellyfin). Enter the port and the
tokens, press **Launch**, and the server starts next to StreamRD with the same mappings as above. This needs the media manager helper, which
the installer includes unless you decline it. An install from before the helper existed gets it by running the installer once more:

```bash
bash install.sh                        # add --media-manager if you declined the helper earlier
```

What you enter on the page:

| Field | Where it comes from | What it is used for |
|---|---|---|
| **Plex claim token** | plex.tv/claim (valid for 4 minutes) | Passed to the Plex container once at launch to link it to your Plex account. Never stored, logged or shown again. |
| **Plex token** | Plex Web: open an item, Get Info, View XML; the `X-Plex-Token` in the address | Stored encrypted. Lets StreamRD ask Plex to rescan the libraries under `/library` (**Rescan libraries**) and test the connection. |
| **Jellyfin API key** | Jellyfin: Dashboard, API Keys, add one | Stored encrypted. The same two things for Jellyfin. |
| **Port** | You choose (defaults 8096 and 32400) | The port the server is published on. |

**The deploy log.** Once the helper is installed, each server card has **Show deploy log**: a live log of what happened when you pressed Launch (the image
download with its progress, the container being created and started, any error Docker gave) followed by the server's own output, refreshed every few
seconds while it starts. **Copy log** puts it on the clipboard for a bug report. Plex claim tokens, Plex tokens and Jellyfin API keys are blanked in it
before it leaves the helper.

**What the media manager is, and why it is separate.** Starting a container needs access to the Docker socket, which is the same as root on the
machine. StreamRD never gets it. The installer adds a tiny helper container (`streamrd-media-manager`) that holds the socket and does exactly
three things: start, stop and remove the containers `streamrd-jellyfin` and `streamrd-plex`, plus one more since v0.23.0: replace the StreamRD container with a newer image of itself when you press **Update** in Admin → System (with an automatic rollback). It listens only on the internal Docker network (no published
port), answers only requests carrying a secret generated into your `.env`, and the image, the folders mounted (your libraries and downloads, read-only, and
each server's own settings under `config/`), the user and every other container setting are fixed in the helper, not chosen by the caller. It runs
read-only with all capabilities dropped. Even so, anyone who can control the helper controls Docker on that machine, so you can decline it:
`bash install.sh --no-media-manager` removes it and keeps it off on later runs, until you pass `--media-manager`. Containers it started keep running (stop them from Setup first, or `docker rm -f streamrd-plex streamrd-jellyfin`);
their settings stay in `config/jellyfin` and `config/plex`.

Without the helper the page still saves your tokens, rescans and tests connections for a Plex or Jellyfin you started another way (set `PLEX_URL` or
`JELLYFIN_URL` on the StreamRD container if it is not reachable as `plex` or `jellyfin`).

## Optional Docker mounts

Use a different export directory for each product. The source mount can be shared.
The following example assumes a working host mount at `/mnt/debrid` and StreamRD's
own empty output directory at `/srv/streamrd-library`:

```bash
# Create a dedicated output directory; do not change source-mount ownership.
sudo mkdir -p /srv/streamrd-library
sudo chown 1000:1000 /srv/streamrd-library
# From StreamRD's infra/ (or Phosphor's phosphor/infra/):
# Add these non-secret paths to the project's .env:
# MEDIA_MOUNT_PATH=/mnt/debrid
# MEDIA_EXPORT_PATH=/srv/streamrd-library

docker compose -f docker-compose.yml -f docker-compose.media.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.media.yml up -d --build backend web
```

The optional override mounts source media read-only at `/media/debrid` and the
export directory read-write at `/media/library`. Both host directories must
already exist; Docker refuses to create an empty replacement for a missing mount.
Mount the media before starting the backend. Linux bind propagation is `rslave`;
Docker Desktop or storage setups without propagation support may need that option
removed and containers restarted after remounting. Configure rclone/Zurg/FUSE
permissions so UID 1000 and the scanner can list and read the files, using the
mount tool's documented permissions options. Do not make provider credentials
public to solve media-read access.

For a direct Node deployment, set `MEDIA_SOURCE_ROOT` and `MEDIA_LIBRARY_ROOT` to
separate absolute local directories. Leave both empty to disable export. Changing
the mount's container path after exports exist requires restoring the original
path; repair refuses to overwrite existing links pointing elsewhere.

## Scanner mounts and libraries

Every symlink points to an absolute path under `/media/debrid`. Plex and Jellyfin
must see that same source mount at **exactly `/media/debrid`** inside their own
container, in addition to the exported directory. Mount both read-only for the
scanner. For example, add these bind mounts to each existing scanner service:

```yaml
volumes:
  - type: bind
    source: /mnt/debrid
    target: /media/debrid
    read_only: true
    bind:
      create_host_path: false
      propagation: rslave
  - type: bind
    source: /srv/streamrd-library
    target: /library
    read_only: true
    bind:
      create_host_path: false
```

Keep each scanner's existing config/cache volumes. With a host-installed scanner,
use the same absolute source path as the backend instead. The export directory
may have a different scanner path; symlink targets must keep the same path.

Add **Movies** with folder `/library/Movies`, and **TV Shows** with folder
`/library/TV Shows`. In Plex choose Movies and TV Shows library types; in Jellyfin
choose Movies and Shows. Use separate libraries rather than mixed content, then
run **Scan Library Files** (Plex) or **Scan All Libraries** (Jellyfin).

Naming follows the common layouts:

```text
Movies/Example (2024)/Example (2024).mkv
TV Shows/Example Show (2024)/Season 01/Example Show - S01E02.mkv
TV Shows/Example Show (2024)/Season 00/Example Show - S00E01.mkv
```

Year is optional; season zero supports specials. Metadata matching remains the
scanner's responsibility. Use canonical names and years and correct a match in
Plex/Jellyfin if ambiguous. The exporter supports `.mkv`, `.mp4`, `.m4v`, `.avi`,
`.mov`, `.ts`, `.m2ts`, `.webm`, `.mpg`, and `.mpeg`; scanner/browser codec support
still depends on your media and server's own playback/transcoding capabilities.
Subtitle sidecars, artwork, multi-episode naming, and multi-version naming are not
exported in this version.

## Managing exports

The admin page shows source/link health, offers **Check / repair links**, and lets
you remove an export. Missing links can be recreated; conflicting existing files
are never overwritten. Removing an export unlinks only the managed symlink and
keeps the source file and directories. Repeat exports to the same source/scanner
path are idempotent. Give two different editions distinct names or remove the old
mapping explicitly before replacing it.

A private `.media-library.json` in the export root records ownership and metadata.
Back it up together with the symlink tree and your mount configuration, separately
from the application's SQLite backup. Only one backend process may write each
export root. Local source/output filesystems are trusted operator-managed storage;
do not grant other users write access to library directories or manifest files.

If a mount disappears, the exporter keeps its manifest and existing links and
refuses destructive cleanup. Plex/Jellyfin can still treat unavailable targets as
missing: disable automatic trash emptying/removal while using a transient mount,
and pause scheduled scans during outages. Repair after the mount returns, then
scan again. Deleting a catalog title or Phosphor job does not delete its export;
manage the shared external library explicitly as an administrator. App user/profile
permissions do not transfer to Plex/Jellyfin accounts.

## API

All endpoints require an authenticated administrator, in either product:

- `GET /api/admin/library`: enabled state, configured roots, export entries and
  source/link health. With export disabled returns `enabled: false`.
- `POST /api/admin/library/entries`: `{name, year?, type: "movie" | "episode",
  sourcePath, season?, episode?}`. `sourcePath` is relative to the configured mount.
  TV entries require both season and episode. Returns `201` with `entry`.
- `POST /api/admin/library/repair`: per-entry `ready`, `repaired`, `unavailable`, or
  `conflict` status; never overwrites conflicting files.
- `DELETE /api/admin/library/entries/:id`: removes only the owned export link.

Missing configuration/mount access returns `503`; invalid paths or metadata return
`400`; collisions/changed files return `409`. Output parent symlinks and source
links escaping the source root are rejected. No schema change is needed for this
feature. It does not add `.strm` URL files, which Plex does not handle as ordinary
local video files.

## Community edition browsing and batches

The mounted-file browser uses bounded pages with root/directory-scoped cursors.
Unreadable children, hidden entries, unsupported file types, and escaping source
symlinks are skipped. No source files or scanner links are changed by browsing.
Large directories are still enumerated on each page, so a remote mount can affect
latency; retained pagination candidates are bounded.

Selections remain in review until Export is pressed. Check inferred movie years
and TV episode numbers, including specials; ambiguous filenames need manual edits.
Export processes up to 100 selected entries sequentially and reports per-file
outcomes. Successful files leave review; unsuccessful files stay editable so a
collision or missing source does not discard the rest of your work.

Search the exported library by name/path or filter Ready/Needs attention. Check /
repair recreates missing owned links; removal asks for confirmation and preserves
source media. Refresh the library status after resolving a mount outage.
