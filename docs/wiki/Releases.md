# Releases and version policy

The four StreamRD/Phosphor server and web packages share a SemVer tag,
`vMAJOR.MINOR.PATCH`. **v0.5.0 Automatic Libraries** follows v0.4.0 Safe Upgrades.
Native-client versions remain independent.

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
