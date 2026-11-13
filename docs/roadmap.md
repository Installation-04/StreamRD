# Roadmap

Where StreamRD and Phosphor go from here. Each phase is one or more releases; every release upgrades from any earlier version without
losing data. Sizes are rough (S = days, M = a week or two, L = several weeks of focused work).

## Status

Shipped: one Library page and library sharing (v0.11.0), the home page (v0.12.0, v0.13.0), viewing limits for kids' accounts (v0.14.0),
invitations that carry library access (v0.15.0), the full-page player (v0.16.0), one card per title with versions (v0.17.0), a single
administrator-managed library (v0.18.0), link health checks (v0.19.0), My List (v0.20.0), watched marks (v0.21.0), conversion while you
watch (v0.22.0), the Update button (v0.23.0), and converted playback that works, with the whole product tested in a real browser (v0.23.2).

The remaining data-model decisions are in [library-model.md](library-model.md).

## Now: the server is run from its web page, in one container

After the one-time install, nothing should need a command or a file on the server.

| Release | What changes for the owner | Size | Database |
|---|---|---|---|
| v0.24.0 | Server settings that were environment variables are choices in Admin → Server; Restart from Admin → System; Plex and Jellyfin start again with the machine, or not, as chosen; the launch shows a live log | M | none |
| v0.24.0 | The helper that launches Plex and Jellyfin and runs updates lives inside the StreamRD container: one container, no extra script, updates from the page or with plain Docker (an install with the helper in a second container is moved by running the installer again) | L | none |
| v0.25.1 | Prowlarr, Jellyfin and Plex are checked for a newer version and updated from Admin → System, whenever their own release comes out and not only with a StreamRD release; each can be left to update itself at night | M | none |
| v0.25.2 | The installer installs what a bare Linux machine lacks: curl, tar, Docker Engine and the Compose plugin, with Docker started and set to start with the machine, so one command is enough; `--no-install-docker` refuses, `--prepare` stops after preparing the machine | M | none |
| v0.25.3 | Phosphor is off unless asked for (`install.sh --phosphor`); an install already running it keeps it | S | none |
| v0.26.0 | Admin → Add-ons: Sonarr, Radarr, Lidarr, Bazarr, Seerr, Tautulli, Prowlarr, FlareSolverr and Maintainerr installed, stopped, updated and removed with one button each, with a log box | M | none |
| next | Add-ons sign themselves in and link to each other: logins and API keys, Prowlarr to Sonarr and Radarr, a download client, Bazarr and Seerr to their sources | M | none |
| next | Requests work like Seerr: one search for movies and shows, one click to request, a season and episode choice, plain statuses | M | none |
| next | TV shows work like Plex: seasons grouped under their show when the Real-Debrid account is scanned, with an episode browser | L | additive |
| next | Zilean and Zurg started and stopped from the page, and updated the same way; Phosphor and the bundled download client switched on and off from the page | M | none |

Plex and Jellyfin stay in containers of their own, started from the page: they are large separate programs with their own releases.
What cannot move to the page: the first install, and adding access to Docker to an install that was made without it.

## Phase 1: playback you can rely on

Playing a video is the product, so it comes first.

| Release | What changes for the viewer | Size | Database |
|---|---|---|---|
| v0.23.2 | A converted video no longer stops when resumed or sought; a refused stream says why | S | none |
| v0.25.0 | The sound follows the picture after a skip; converted video has a real length, a buffer and a buffering indicator through the browser's streaming API (Chrome, Firefox, Safari on a computer or iPad); requests approve themselves; Prowlarr by default; poster menu | L | none |
| v0.26.0 | Segment-based delivery (a playlist that knows the full length, segments made ahead of the viewer) for instant seeking everywhere, including an iPhone, and for audio-track choice | L | none |
| v0.25.x | Choose the audio track; subtitles; a quality menu (Original, 1080p, 720p, 480p) | M | none |
| v0.25.x | The administrator sees who is watching and can stop a stream; a limit per viewer | S | none |
| later | Optional hardware acceleration and correct colours for HDR sources | M | none |

How v0.25.0 is built, in pull requests:
1. The browser tells the server what it can decode; the server decides between playing the file as it is, repackaging it, converting the
   audio, or converting the picture, and logs the reason.
2. Converted video is delivered in short segments with a playlist that knows the full length. Segments are made on demand, a little
   ahead of the viewer, kept in a temporary folder with a size limit, and removed when the viewer stops.
3. The player uses those segments; seeking jumps to a segment instead of restarting the conversion.
4. Audio-track choice and text subtitles.
5. Now-playing list, stop action and the per-viewer limit.
6. A set of test files (MP4 H.264/AAC, MKV H.264/DTS, MKV HEVC 10-bit/TrueHD, MKV H.264/AC-3 with image subtitles, AVI Xvid/MP3) played
   in a browser with real decoders on every pull request.

Risk: delivery changes completely while the old path still works. The old path stays behind a setting for one release.
Not verifiable in CI: Safari, hardware acceleration. Those are recorded manual runs and stated in the release notes.

## Phase 2: security baseline

| Pull request | What it does | Size |
|---|---|---|
| Security policy and threat model | How to report a problem; what is protected and from whom | S |
| One guarded client for outbound requests | Every request the server makes to providers, indexers, metadata sources and media servers goes through one client that refuses private addresses unless allowed, fixes the resolved address, limits size and time, and never forwards credentials across redirects | M |
| Content-Security-Policy | Both web apps send a strict policy, tested on every pull request | M |
| Rate limiting that survives a restart | Stored in the database, per account as well as per address | S |
| Dependency and code scanning | Scheduled and on every pull request; build actions pinned to exact commits; grouped dependency updates | S |
| Signed images | Each published image carries a signature, a list of its contents and a record of how it was built | S |
| Encryption key rotation | A command that re-encrypts stored credentials under a new key | S |

Database: one additive table for rate limiting. Release: v0.27.0.

## Phase 3: one codebase, one API description

- Shared code moves into workspace packages that both products import; the copy-and-check script is removed when nothing depends on it. L, no behaviour change.
- An OpenAPI description generated from the request schemas, served at `/api/openapi.json`, with a generated client for the web apps. M.
- A formatter and a linter, applied in one mechanical pull request. M.
- One runner for background work (scans, metadata, link checks, requests) with retries and an admin view. M, one additive table.
- Configuration validated at start, with one generated settings table in the docs. S.

## Phase 4: shows, seasons and episodes

- One release-name reader used for importing, grouping and searching, tested on at least 500 names. M, no migration.
- Shows, seasons, episodes and their files as records of their own, with external ids. Written alongside today's records for one
  release, back-filled, then read from. L, additive migration, tested on a copy of real data before release.
- Watched marks and resume per episode; "Next up" per show; Continue watching that mixes films and episodes. M.
- Collections, and one tool to fix a match, merge versions or split them. M.

Risk: the largest in this roadmap. Nothing is dropped or rewritten; the earlier records stay.

## Phase 5: requests that look after themselves

Quality profiles with scores; releases already available on the debrid service preferred; a blocklist with retry on the next candidate;
automatic approval and quotas per person; requests per season; notifications by e-mail, Discord, ntfy and webhooks; indexer health.
Additive migrations only.

## Phase 6: identity

Sign-in through an OpenID Connect provider with group-to-role mapping, respecting the invitation policy; two-step sign-in with recovery
codes; passkeys; a device list with revoke; profiles under one account with an optional PIN and their own watch state; permissions
finer than two roles. Additive migrations only.

## Alongside, as they unblock other work

| Item | Size | Notes |
|---|---|---|
| French and English interface | M | Dates and numbers localised |
| Accessibility checks in the browser journeys, then fixes | M | Target: WCAG 2.2 AA |
| Shared interface components, inline styles removed | M | Needed before the Content-Security-Policy can be strict about styles |
| `arm64` image | M | Tested on both architectures |
| User and group ids for file ownership on NAS volumes | S | Existing installs keep today's behaviour |
| Scheduled backups with retention; a restore rehearsal on every pull request | S | |
| Stable and beta channels on the Update button | S | |
| Metrics endpoint and a dashboard | S | |
| Reverse-proxy and tunnel examples | S | |
| Test coverage reported, then held above a floor | S | |
| Check Zilean and Zurg against a real debrid account | S | Only configuration and start-up were tested; see [zilean-zurg.md](zilean-zurg.md) |
| PostgreSQL as an option | L | Only if wanted: it doubles the migration and test work |
| A documentation site built from `docs/` | M | |

## What needs the owner

- A debrid account, a GPU, an Apple device: features that depend on them ship with what was and was not verified.
- Product choices: who can see what, quotas, which sign-in providers to support, whether PostgreSQL is worth its cost.
