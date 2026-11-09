# Releases and version policy

The four StreamRD/Phosphor server and web packages share a SemVer tag,
`vMAJOR.MINOR.PATCH`. **v0.7.0 Shared Watch Progress** follows v0.6.0 Server Sharing.
Native-client versions remain independent.

- [v0.7.0 release](https://github.com/Installation-04/StreamRD/releases/tag/v0.7.0)
- [Release notes](https://github.com/Installation-04/StreamRD/blob/v0.7.0/docs/releases/v0.7.0.md)
- [Users and sharing guide](https://github.com/Installation-04/StreamRD/blob/v0.7.0/docs/server-sharing.md)
- [Screenshot provenance](https://github.com/Installation-04/StreamRD/blob/v0.7.0/docs/screenshots/v0.7.0/README.md)

Shared Watch Progress lets each viewer of a StreamRD shared library resume where they stopped and adds a Continue watching row. It adds one additive migration and stores no provider links or credentials. Validation covers 644 backend tests, four production builds, both upgrade/restore smoke checks and 27 browser journeys with 52 screenshots. Phosphor is unchanged.

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
build runtime images from source; registry images and native installers are not
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
