# Mounted-library validation — v0.2.0

## Automated regressions

Both backend suites run the same 15 real-filesystem/library API tests, plus their
existing product tests: **155 StreamRD + 101 Phosphor = 256 passing tests**.
Both server type checks and all four production Docker builds passed.

The library regressions cover recognized movie/episode paths and special season
zero, disabled URL-only deployments, absolute/URL/traversal rejection, escaping
source symlinks, non-file targets, overlapping roots, output-directory symlinks,
concurrent idempotent exports, private manifest permissions and restart persistence,
unmanaged files/symlinks and source collisions, repair, mount outages, safe removal,
externally changed files, corrupted manifests, Unicode filename lengths, and admin
API access/validation.

Both production container checks also passed: `infra/smoke-images.sh streamrd`
and `infra/smoke-images.sh phosphor`. They export a real filesystem fixture through
the admin API, read it via the symlink, and verify link/manifest persistence after
restart. Their separate SQLite-only restore runs without a media mount, confirming
that export is optional. Those checks do not start Plex/Jellyfin.

## Real scanner checks

Disposable Plex and Jellyfin servers scanned the same generated movie/episode
symlink tree, backed by a local 4,916-byte, 120-second H.264 MP4 test fixture. The
fixture contains synthetic video, not downloaded film content. Source and export
bind mounts were read-only in each scanner; each source target was mounted at the
same absolute path as the exporter used.

| Scanner | Tested image | Result |
|---|---|---|
| Plex 1.43.5.11079-b3b13e506 | `plexinc/pms-docker@sha256:6d778d41daae68f89115aa87a44ae14a96b23e71a2093da173b5a9aac4091336` | Movie and episode found; season 1 / episode 2 recognized; original media bytes served |
| Jellyfin 10.10.7 | `jellyfin/jellyfin@sha256:7ae36aab93ef9b6aaff02b37f8bb23df84bb2d7a3f6054ec8fc466072a648ce2` | Movie and episode found; season 1 / episode 2 recognized; original movie bytes served |

Exported layouts:

```text
Movies/StreamRD Scan Fixture (2024)/StreamRD Scan Fixture (2024).mp4
TV Shows/StreamRD Series Fixture (2024)/Season 01/StreamRD Series Fixture - S01E02.mp4
```

Plex used its local Personal Media agent and Movie/Series scanners on an unclaimed,
loopback-only test instance. Jellyfin used a fresh local administrator and empty
metadata/image fetcher lists for the test libraries. The checks added separate
movie/show libraries, requested scans, queried discovered media paths and episode
numbers, then requested each server's original-media endpoint and compared every
returned byte to the source fixture. No existing scanner installation was modified.

These are filesystem/scanning/original-file checks. They do not validate external
metadata matching, remote clients, transcoding, a live rclone/Zurg mount, or real
provider playback. The named scanner versions are evidence of compatibility, not
a recommendation to deploy an older server version.

## Screenshots

Eleven Chromium captures use the real production web applications and disposable
accounts, with no browser page errors. Both new admin library pages were exercised
by filling the export form and invoking link repair; the resulting links showed
**Ready to scan** and no entries needing attention. See
[screenshot provenance](screenshots/README.md).

## Repeating the checks

Run `npm test` and `npm run lint` in each backend. Build the four images and run
both production smoke scripts as described in [production-runtime.md](production-runtime.md).
For a manual scanner check, export a short local video and a TV episode using the
admin page, add the read-only mounts and separate movie/show libraries from
[plex-jellyfin.md](plex-jellyfin.md), scan, confirm season/episode numbers, and play
or download the original file. Compare its checksum with the mounted source.
