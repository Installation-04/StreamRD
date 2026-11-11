# Import your existing debrid library

The v0.5.0 update adds a private **My library** to StreamRD and Phosphor. Connecting
your own debrid account can scan entries already stored there and bring them into
the web app. Imported titles belong to your user account; they do not enter the
shared administrator-curated catalog or another user's library.

## First connection

1. Sign in and open **Setup → Connect a debrid account**.
2. Enter your provider key in **Account → Debrid**. Leave **Automatically scan
   existing torrents after connecting** enabled, then save.
3. Return to Setup or open **My library**. The scan panel shows each connected
   provider's progress, imported items, duplicates and any errors.
4. Open a title and press **Play from my account**. For a torrent with multiple
   videos, select the movie or episode to play.

Saving credentials queues work locally; the background worker makes the provider
requests. Existing connected accounts can start their first scan from Setup.
Refreshing the checklist itself reads local state. Completed or cancelled scans
are not restarted by each page visit. Use **Scan connected accounts** or a
provider's scan button when you want another scan.

Automatic import can be disabled on the Debrid settings page. Explicit manual
rescans remain available. **Stop** cancels future pages and prevents an in-flight
page from adding late results. Already imported items remain in your library.

## Providers and limits

| Provider | Existing content scanned |
|---|---|
| Real-Debrid | Existing torrents, following account pages until the list ends |
| AllDebrid | Existing magnets, processed in bounded batches |
| Premiumize | Existing cloud video files, including nested folders |
| Torbox, Phosphor only | Existing account torrents |

Scans read account listings. They do not create torrents, select provider files,
remove transfers, download videos, or copy media. Repeating a scan updates the
existing account references instead of creating duplicates. Finished imports
bound to a current enabled account count as usable onboarding content; a search
indexer or shared catalog is optional when your own imported library is ready.

One worker processes at most 100 entries per page. Jobs retain their cursor and
progress in SQLite and can recover an expired lease after a restart. Failed pages
have bounded retries; previous imports are kept. A repeated page, unsupported
listing, unusually deep folder tree or safety limit produces an incomplete-scan
error rather than claiming that the entire account was imported. Correct the
connection or account organization, then rescan.

Provider response limits include an 8 MiB body cap, at most six requests per page,
and a bounded operation deadline. Premiumize traversal supports 32 nested folders
with an 8 KiB cursor. Unpaginated provider lists are limited to 10,000 entries;
scan jobs stop with an incomplete result after 2,000 pages. These bounds protect
self-hosted servers; large or changing collections can need another scan.

## Artwork and title information

With [automatic metadata](metadata-automation.md) configured by the administrator,
new imports queue movie/series matching. Filename hints provide initial names,
years and media types; confident metadata matches add artwork, synopsis, cast,
runtime, ratings and IMDb references. Ambiguous results need review.

Each user can open **Find metadata** or **Fix metadata match** on their own title,
search by title or IMDb ID, inspect a preview, then confirm the match. Provider
credentials remain on the server. Private matching records and totals are
excluded from the shared administrator matching activity. Manual matches do not
change the provider reference or source media.

## Playback and account changes

The database stores stable provider references, not signed stream URLs. A temporary
URL is resolved only after an authenticated owner presses Play. Listing the library
or opening a title does not unrestrict a link. File selection filters out non-video
files and uses opaque choices bound to the current provider credentials. A maximum
of 100 videos can be offered for one item.

An imported transfer can still be downloading or unavailable. The player reports
pending progress and offers a readiness retry. Browser playback depends on the
file's container and codecs. A server with ffmpeg (the official image) converts what a browser
cannot play while you watch (see [v0.22.0](releases/v0.22.0.md)); where that is off or fails, a
temporary-stream link can be opened in a compatible external player.

Changing credentials invalidates in-flight work. Rescan after reconnecting so
imports are verified against the current account before playback. Disabled or
deactivated accounts cannot continue scans or resolve a new stream. Deleting a
local library item does not remove it from the provider account; a later rescan
can discover it again. Deleting the user cascades their imports, scan state and
private metadata.

## Plex and Jellyfin

This account scanner imports a web library. A stream URL cannot become a
filesystem symlink. Optional [Plex/Jellyfin exports](plex-jellyfin.md) still use real
videos available through a local mount such as rclone or Zurg, with the existing
reviewed export workflow. Automatic provider-to-mount path matching is not included.

## Upgrading and verification

The additive migration `20261107000000_account_library` follows the metadata
migration. It adds private account imports/scan state, the automatic-import
preference, and nullable metadata ownership with deletion cascades. Follow the
[database upgrade guide](database-upgrades.md); preserve configuration and verified
snapshots before changing an installation.

Tests use mocked provider protocols and disposable local containers. The browser
runner preloads test-only provider responses into fresh volumes and plays an
original one-second color video. It never scans a real debrid account. Live account
coverage and real-provider playback require the operator's own credentials.
