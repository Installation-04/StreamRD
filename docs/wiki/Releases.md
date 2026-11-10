# Releases and version policy

The four StreamRD/Phosphor server and web packages share a SemVer tag,
`vMAJOR.MINOR.PATCH`. **v0.10.2** follows v0.10.1, v0.10.0, v0.9.1, v0.9.0, v0.8.1 and v0.8.0 Requests and One Container, v0.7.0 Shared Watch Progress and v0.6.0 Server Sharing.
Native-client versions remain independent.

- [v0.10.2 notes](https://github.com/Installation-04/StreamRD/blob/main/docs/releases/v0.10.2.md) (metadata with no account) ·
  [v0.10.1 notes](https://github.com/Installation-04/StreamRD/blob/main/docs/releases/v0.10.1.md) (HttpOnly sessions in the single container) ·
  [v0.10.0 notes](https://github.com/Installation-04/StreamRD/blob/main/docs/releases/v0.10.0.md) (stored credentials encrypted) ·
  [v0.9.1 notes](https://github.com/Installation-04/StreamRD/blob/main/docs/releases/v0.9.1.md) (hardening: WAL mode, stricter CORS, security headers) ·
  [v0.9.0 notes](https://github.com/Installation-04/StreamRD/blob/main/docs/releases/v0.9.0.md) (tag it to release) ·
  [v0.8.1 release](https://github.com/Installation-04/StreamRD/releases/tag/v0.8.1)

**v0.9.0** keeps settings and data in `config/` and `data/` like Radarr/Sonarr, so updating is `docker compose pull && docker compose up -d`; imports only movies and shows from your accounts (with a cleanup for what was imported before); and adds optional Zilean (indexer) and Zurg (Real-Debrid mount) Compose add-ons. See [the add-ons guide](https://github.com/Installation-04/StreamRD/blob/main/docs/zilean-zurg.md).

**v0.8.1** fixes automatic matching for release-style file names (the title is searched without year, edition and
quality tags, unambiguous exact or near-year matches are accepted, and the worker is much faster), adds match progress and
**Retry matching** to My library, shows your imported library on StreamRD's Discover page, and extends
Admin → Logs with search, date filters, paging, copy and downloads. No migration. 778 backend tests, 41 browser journeys, 81 screenshots.

**v0.8.0** (shipped in v0.8.1; not tagged separately) adds media discovery and requests (TMDB/OMDb search, deduplicated requests, admin approval to a cloud provider or local
qBittorrent), the all-in-one container, and Admin → System update checks, verified backups and restore. From v0.8.1 a tag also publishes
the all-in-one image to the repository's container registry (amd64). One additive migration per product.
[Notes](https://github.com/Installation-04/StreamRD/blob/main/docs/releases/v0.8.0.md).

**v0.7.0** (shipped in v0.8.1; not tagged separately) lets each viewer of a StreamRD shared library resume where they stopped and adds a Continue watching row; one additive
migration, no provider links or credentials stored. [Notes](https://github.com/Installation-04/StreamRD/blob/main/docs/releases/v0.7.0.md).

## Previous: v0.6.0 Server Sharing

- [v0.6.0 release](https://github.com/Installation-04/StreamRD/releases/tag/v0.6.0)
- [Sharing validation](https://github.com/Installation-04/StreamRD/blob/v0.6.0/docs/server-sharing-validation.md)

Server Sharing adds invitations, registration policy, administrator session
revocation, named collections and explicit per-user access to playback through the
source administrator's provider account. It preserves private accounts and media;
full Plex Home managed users, PINs and parental controls remain future work.

## Previous: v0.5.0 Automatic Libraries

- [v0.5.0 release](https://github.com/Installation-04/StreamRD/releases/tag/v0.5.0)
- [Versioned source](https://github.com/Installation-04/StreamRD/tree/v0.5.0)
- [Upgrade and recovery guide](https://github.com/Installation-04/StreamRD/blob/v0.5.0/docs/database-upgrades.md)
- [Validation record](https://github.com/Installation-04/StreamRD/blob/v0.5.0/docs/automatic-libraries-validation.md)
- [Screenshot provenance](https://github.com/Installation-04/StreamRD/blob/v0.5.0/docs/screenshots/v0.5.0/README.md)

Automatic Libraries adds private onboarding imports from existing debrid accounts,
TMDB/OMDb metadata, reviewed corrections, protected manual fields and explicit
owner playback. Validation covers 550 backend tests, four production builds,
upgrade/restore checks and 20 browser journeys with 36 screenshots. Live providers
require the operator's credentials; release checks use local protocol fixtures.

Release downloads include GitHub source archives plus screenshots, wiki and
Project HQ/Notion-importable tracker bundles with SHA-256 checksums. Dockerfiles
build runtime images from source. A tag also publishes the all-in-one
image to the repository's container registry (amd64); native installers are not
published. A live Notion workspace is not connected.

Follow [RELEASING.md](https://github.com/Installation-04/StreamRD/blob/main/RELEASING.md):
update package/lock versions and upgrade notes, validate, pass both CI pipelines,
then create an annotated tag. Its workflow verifies versions and publishes the
checked-in release notes and documentation assets.

Stop writers before upgrading, retain the old image, preserve the JWT signing key,
and follow the supported baseline/ownership/recovery instructions. Snapshot policy
is not evidence of an existing verified backup. SQLite is supported; customized or
inconsistent schemas need review. Optional Plex/Jellyfin exports keep the existing
mounted-file layouts. Native parity, real-provider playback and production-load
measurements remain future work.

Previous releases:

- [v0.4.0 Safe Upgrades](https://github.com/Installation-04/StreamRD/releases/tag/v0.4.0): versioned SQLite migrations, verified snapshots, independent readiness and System pages.

- [v0.3.0 Community Edition](https://github.com/Installation-04/StreamRD/releases/tag/v0.3.0): guided setup, reviewed mounted-file browsing/batches, responsive interfaces and Project HQ; 278 backend tests and 12 browser journeys.
- [v0.2.0](https://github.com/Installation-04/StreamRD/releases/tag/v0.2.0): optimization, session hardening, production recovery and optional Plex/Jellyfin symlinks. Real Plex/Jellyfin scanner reads were validated in that milestone.
