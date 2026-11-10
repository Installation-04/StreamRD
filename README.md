<p align="center">
  <img src="docs/assets/logo.svg" alt="StreamRD logo" width="96">
</p>

<p align="center">
  <img src="docs/assets/readme/hero.jpg" alt="StreamRD in black and orange: the home page with a featured carousel, on desktop, light theme, a phone, and next to Phosphor" width="100%">
</p>

<p align="center">
  <a href="https://github.com/Installation-04/StreamRD/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/Installation-04/StreamRD?style=flat-square&color=ff8a1f"></a>
  <a href="https://github.com/Installation-04/StreamRD/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/Installation-04/StreamRD/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/Installation-04/StreamRD?style=flat-square"></a>
  <a href="https://github.com/Installation-04/StreamRD/pkgs/container/streamrd"><img alt="Container image" src="https://img.shields.io/badge/ghcr.io-streamrd-2496ED?style=flat-square&logo=docker&logoColor=white"></a>
</p>

<p align="center">
  <a href="#-quick-install">Quick install</a> ·
  <a href="#-screenshots">Screenshots</a> ·
  <a href="#-features">Features</a> ·
  <a href="#-documentation">Docs</a> ·
  <a href="docs/roadmap.md">Roadmap</a> ·
  <a href="https://github.com/Installation-04/StreamRD/wiki">Wiki</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

**StreamRD** is a self-hosted, streaming-style web app for your own **debrid** accounts
(Real-Debrid, AllDebrid, Premiumize.me). Connect an account and StreamRD finds the movies and shows already
in it, matches artwork and details, and gives you, your family and friends a private place to browse and watch.
You decide who joins and what they can see, and nobody else needs a debrid subscription.

- 🎬 **Your collection, nicely browsed.** Imports only movies and shows (games, software and music are skipped), with posters and details that work with no account or API key (add your own TMDB or OMDb key for richer results).
- 👥 **Libraries.** Create libraries such as Movies and TV Shows, choose who sees each one (everyone or chosen people), and invite people with a link. Everyone gets their own resume positions, and playback uses your account so nobody else needs a key.
- 🔎 **Find and request more.** Search TMDB, request a title, and follow it from approval to download.
- 🐳 **One container.** Settings in `config/`, downloads in `data/`; updating is `docker compose pull && docker compose up -d`.
- 🔒 **Careful with your secrets.** Stored keys are encrypted, sessions are HttpOnly, backups are verified.

## 🖼 Screenshots

<table>
  <tr>
    <td align="center" width="50%"><img src="docs/assets/readme/discover-dark.png" alt="Home page with a featured carousel and trending row in the black and orange theme"><br><sub><b>Home</b>: a featured carousel (optional trailers), then Continue watching, New in your libraries, Popular and Trending</sub></td>
    <td align="center" width="50%"><img src="docs/assets/readme/discover-light.png" alt="Home page in the light theme"><br><sub><b>Light, dark or system theme</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/assets/readme/libraries.png" alt="A library as seen by an invited viewer"><br><sub><b>Library</b>: what an invited viewer sees</sub></td>
    <td align="center"><img src="docs/assets/readme/libraries-admin.png" alt="Admin page for creating libraries and choosing who can see them"><br><sub><b>Libraries</b>: visible to everyone or chosen people</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/assets/readme/find-media.png" alt="Searching TMDB for a movie to request"><br><sub><b>Find media</b>: search TMDB and request what you want</sub></td>
    <td align="center"><img src="docs/assets/readme/requests.png" alt="Request list with measured download progress"><br><sub><b>Requests</b>: real download progress, cloud or local</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/assets/readme/imports.png" alt="Imports page with artwork matching status"><br><sub><b>Imports</b>: pulled from your debrid account, matched automatically</sub></td>
    <td align="center"><img src="docs/assets/readme/people-access.png" alt="Admin page for members, invitations and registration policy"><br><sub><b>People &amp; access</b>: invitations, members, sign-out everywhere</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/assets/readme/invitations.png" alt="Creating an invitation that carries library access and a viewing limit"><br><sub><b>Invitations</b>: pick the libraries and a viewing limit; works over your LAN or Tailscale</sub></td>
    <td align="center"><img src="docs/assets/readme/kids-library.png" alt="A library as a kids account sees it"><br><sub><b>Kids accounts</b>: an age-rating limit hides everything above it</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/assets/readme/viewing-limits.png" alt="Per-member viewing limit in People and access"><br><sub><b>Viewing limits</b>: set per member, applied at once</sub></td>
    <td align="center"><img src="docs/assets/readme/player.png" alt="The full-page player"><br><sub><b>Player</b>: its own page with keyboard shortcuts</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/assets/readme/system.png" alt="Admin system page with updates and backups"><br><sub><b>System</b>: update checks, verified backups and restore</sub></td>
    <td align="center"><img src="docs/assets/readme/discover-mobile.png" alt="StreamRD on a phone" height="420"><br><sub><b>Phones and tablets</b>: responsive everywhere</sub></td>
  </tr>
</table>

<p align="center"><sub>More in the <a href="https://github.com/Installation-04/StreamRD/wiki/Screenshots">screenshot gallery</a>. All screenshots use demo data; the trending and popular rows are live public lists.</sub></p>

## 🚀 Quick install

You need Docker with the Compose plugin. Then run:

```bash
curl -fsSL https://raw.githubusercontent.com/Installation-04/StreamRD/main/install.sh | bash
```

Run in a terminal, it asks how you want it: **Default** (StreamRD on 8080, Phosphor on 8081, the download client) or
**Advanced** (folder, every port, Phosphor and qBittorrent on or off, **Jellyfin and/or Plex already wired to your libraries**,
Zilean, Zurg, the reserved administrator email), then shows a summary to confirm. Add `--yes` (or run it without a terminal) to skip
the questions.

Open **http://YOUR_SERVER:8080**, create your account (the first one becomes the administrator), and follow the
guided **Setup** page to connect a debrid account. That is all.

The script creates `~/streamrd` with one `docker-compose.yml` and two folders, laid out as:

| Folder | Holds |
|---|---|
| `config/` | all settings, both databases, backups and the keys that protect your credentials |
| `data/` | downloads and media |

**Update** any time with `cd ~/streamrd && docker compose pull && docker compose up -d` (or run the script again).
Your folders are never touched. Options go after `bash -s --`, for example `--port 3000 --admin-email you@example.com`;
`--help` lists them. `--import-db` moves an existing install across and `--uninstall` removes the container, keeping your folders.
It does not install Docker, set up HTTPS or open firewall ports. Read [`install.sh`](install.sh) before piping any script to a shell.

<details>
<summary><b>Optional add-ons</b>: Zilean, Zurg, Plex and Jellyfin</summary>

- `install.sh --media-manager` lets the **Setup** page launch Plex or Jellyfin beside StreamRD: you paste the tokens (the Plex claim token is used once and never stored) and press Launch. A small opt-in helper holds the Docker socket, not StreamRD itself; see [what it can do](docs/plex-jellyfin.md#start-plex-or-jellyfin-from-streamrds-setup-page).
- `install.sh --media-server jellyfin|plex|both` runs Jellyfin and/or Plex next to StreamRD with the library folders and your downloads already mapped (read-only); you only add the libraries in their setup. See [Plex and Jellyfin](docs/plex-jellyfin.md#built-in-jellyfin-and-plex).
- `install.sh --zilean` runs [Zilean](docs/zilean-zurg.md) (a torrent index) and registers it as an indexer for Phosphor.
- `install.sh --zurg --rd-token …` mounts your Real-Debrid movies and shows (Linux host, Real-Debrid only).
- Admin → Plex / Jellyfin exports mounted files as symlink libraries for your media server:
  [setup and scanning guide](docs/plex-jellyfin.md).

Details and honest limits of what has been tested: [Zilean and Zurg](docs/zilean-zurg.md).
</details>

<details>
<summary><b>Prefer to write the compose file yourself?</b></summary>

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

The container runs as UID/GID 1000. Full reference: [single-container guide](docs/single-container.md).
Split deployments and the older Debian/Ubuntu installer are in [deployment.md](docs/deployment.md).
</details>

## ✨ Features

**Watch**
- A streaming-style web UI in black and orange (dark, light or system theme), responsive on phones and tablets.
- One card per title: copies of the same film (1080p, 4K) or show share a card, with the versions on its page.
- A full-page player with resume, Up next, keyboard shortcuts and a VLC/mpv hand-off for files a browser cannot play.
- A home page with a featured carousel (optional trailers) and rows: Continue watching, New in your libraries, Popular on this server, and public Trending and Popular lists.
- Per-viewer resume across all libraries, and **My List**: a heart on any title saves it to your own list.
- Multiple debrid providers behind one interface, with per-user primary provider and automatic fallback.
- Clear help when a browser cannot play a file (MKV, DTS and similar), with a hand-off link for VLC or mpv.

**Discover and request**
- Search TMDB or OMDb, request a title, and track it from administrator approval to a finished download (debrid cloud or the bundled qBittorrent).
- Automatic artwork and details matching for release-style file names, with manual correction and a *Retry matching* button. A built-in source works with no account or key; TMDB and OMDb keys are optional upgrades.

**Share**
- Invitation-only, open or closed registration; expiring one-use invitation links.
- Libraries (Movies, TV Shows, or your own) visible to everyone or to chosen people; viewers need no debrid account.
- Invitation links that carry the libraries and viewing limit the new person gets, with a link address for your local network, Tailscale or a domain.
- A kids account: give a member a viewing limit (Kids, Pre-teens, Teens, Mature) and they see only titles rated at or below it; unrated titles stay hidden.
- Administrators can deactivate accounts and sign someone out of every device.

**Operate and secure**
- Verified backups and typed-confirmation restore, update checks, readiness pages, and searchable, downloadable logs.
- Updates never cost data: migrations only add, and every release is tested upgrading a populated database from every earlier version.
- Debrid keys, indexer keys and the download-client password are encrypted at rest.
- HttpOnly sessions, cross-site request guard, security headers, rate limiting, and an automatic safety snapshot before any database upgrade.
- Automatic releases: merging a version bump tags and publishes the release and the container image.

## 🧲 Also in the box: Phosphor

**Phosphor** is the companion app for people who prefer to search. It queries your own Torznab indexers
(Jackett, Prowlarr, Zilean), adds the result to your debrid account in one click, and streams it once resolved,
all in a retro terminal look. It runs in the same container on port **8081** with its own accounts, and also supports TorBox.

<table>
  <tr>
    <td align="center" width="50%"><img src="docs/assets/readme/phosphor-search.png" alt="Phosphor indexer search in green phosphor theme"><br><sub><b>Search your indexers</b></sub></td>
    <td align="center" width="50%"><img src="docs/assets/readme/phosphor-queue.png" alt="Phosphor download queue"><br><sub><b>Queue and stream</b></sub></td>
  </tr>
</table>

More in [`phosphor/README.md`](phosphor/README.md).

## 🧭 How it works

```mermaid
flowchart LR
  subgraph you["You, family and friends"]
    B["Browser: phone, tablet, desktop"]
  end
  subgraph box["One container"]
    W["Web app"] --> A["StreamRD API"]
    A --> DB[("SQLite")]
    A --> R["Request worker"]
  end
  A --> D["Real-Debrid / AllDebrid / Premiumize.me"]
  A -.-> M["TMDB / OMDb artwork and details"]
  R --> Q["qBittorrent or debrid cloud"]
  B --> W
```

## 🗺 Where it is going

StreamRD is **one library managed by the administrator**: one Library page, libraries visible to everyone or chosen people, one card per
title with versions, a home page with a featured carousel, viewing limits for a kids account, invitation links that carry library access,
and a full-page player. Members request what is missing; only the administrator imports; links are checked in the background and replaced when they die. See the [roadmap](docs/roadmap.md) and the [release notes](https://github.com/Installation-04/StreamRD/releases).

## 📚 Documentation

| I want to… | Read |
|---|---|
| Install, update and back up | [Single container](docs/single-container.md) · [Admin guide](docs/admin-guide.md) |
| Invite people and share libraries | [Users and sharing](docs/server-sharing.md) |
| Request and track media | [Media requests](docs/media-requests.md) |
| Import my debrid account and match artwork | [Account library](docs/account-library.md) · [Metadata](docs/metadata-automation.md) |
| Set up debrid providers | [Providers](docs/providers.md) |
| Put it behind HTTPS or a VPN | [Deployment](docs/deployment.md) |
| Upgrade safely or recover | [Database upgrades](docs/database-upgrades.md) |
| Understand the design or the API | [Architecture](docs/architecture.md) · [API](docs/api-schema.md) · [Auth hardening](docs/auth-hardening.md) |
| Use Plex or Jellyfin | [Plex and Jellyfin](docs/plex-jellyfin.md) |
| Cut a release | [RELEASING.md](RELEASING.md) |

<details>
<summary><b>Configuration, development and tech stack</b></summary>

**Backend** (`server/.env`, see `.env.example`): `PORT`, `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`,
`API_BASE_URL` / `LAN_URL` / `PUBLIC_URL`, `CORS_ORIGINS`, `ADMIN_EMAIL`. **Web**: `NEXT_PUBLIC_API_BASE_URL` is the
URL the *browser* uses to reach the API. **Debrid providers**: each user pastes their own key in
Account → Debrid services (Real-Debrid [apitoken](https://real-debrid.com/apitoken),
AllDebrid [apikeys](https://alldebrid.com/apikeys), Premiumize [account](https://www.premiumize.me/account)).

Run the pieces directly while developing (Node 24):

```bash
git clone https://github.com/Installation-04/StreamRD.git && cd StreamRD
cd server && npm install && npx prisma generate && npx prisma db push && npm run dev   # API on :47821
cd web && npm install && npm run dev                                                    # web on :3000
cd server && npm test                                                                   # RBAC, providers, auth, catalog, playback
```

| Piece | Stack |
|---|---|
| Backend (`/server`) | Node.js 24, TypeScript, Express, Prisma + SQLite, JWT + bcrypt, Zod, Vitest + Supertest |
| Web (`/web`) | Next.js (App Router), React, TypeScript |
| Infra (`/infra`) | Docker, Compose, Caddy and Nginx examples, GitHub Actions |

CI type-checks and tests both servers, builds both web apps, builds the container images and runs real browser journeys.
</details>

## 🤝 Community

Contributions are welcome, and you do not have to write code: bug reports, usability notes, translations, accessibility
checks and testing on different setups all help.

- **Found a bug or have an idea?** [Open an issue](https://github.com/Installation-04/StreamRD/issues/new/choose); the templates ask for what is needed.
- **Want to contribute code?** Read [CONTRIBUTING.md](CONTRIBUTING.md) (small focused pull requests, tests for behavior changes) and the [roadmap](docs/roadmap.md) for where help is most useful.
- **Adding a debrid provider?** Follow [docs/providers.md](docs/providers.md#adding-another-provider).
- **Project tracking** lives in the [Project HQ](https://github.com/Installation-04/StreamRD/wiki/Project-HQ).

## ⚖️ Disclaimer

StreamRD does not host, provide or index any media. It works with the debrid subscriptions and the files you already
have, so use it within your providers' terms of service and your local law. It is not affiliated with or endorsed by
Real-Debrid, AllDebrid, Premiumize, TMDB, OMDb, Plex, Jellyfin or Netflix. *This product uses the TMDB API but is not
endorsed or certified by TMDB.*

## 📄 License

[MIT](LICENSE).
