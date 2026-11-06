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

Exports are managed manually under **Admin → Plex / Jellyfin** in either app.
Provide a movie/series name, optional year, relative mounted video path, and season/
episode numbers for TV. This deliberate mapping avoids guessing which files in a
provider pack correspond to a catalog title or download. There is no automatic
mount-file discovery, provider-to-mount matching, or scanner API integration.

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
