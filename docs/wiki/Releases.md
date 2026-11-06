# Releases and version policy

The repository uses a shared SemVer tag, `vMAJOR.MINOR.PATCH`, for the four
StreamRD/Phosphor server and web packages. Version **v0.3.0** is the Community Edition update, following the first optimization
release v0.2.0. Native-client package versions remain
independent until their own release work is completed.

- [Latest releases](https://github.com/Installation-04/StreamRD/releases)
- [v0.3.0 notes](https://github.com/Installation-04/StreamRD/releases/tag/v0.3.0)
- [Versioned source](https://github.com/Installation-04/StreamRD/tree/v0.3.0)
- [Screenshot provenance](https://github.com/Installation-04/StreamRD/blob/v0.3.0/docs/screenshots/v0.3.0/README.md)

Release downloads include source archives supplied by GitHub and documentation
bundles for the screenshots and wiki, with SHA-256 checksums. Dockerfiles build
the runtime images from source; this release does not publish registry images or
native installers.

Release preparation follows [RELEASING.md](https://github.com/Installation-04/StreamRD/blob/main/RELEASING.md):
update the four package/lockfile versions, record changes and upgrade requirements,
run both CI pipelines, then create an annotated version tag. The tag workflow
verifies versions and publishes the checked-in notes/documentation bundles.

For v0.2.0, local validation includes 155 StreamRD and 101 Phosphor backend tests,
both server type checks, all four production image builds, and both runtime
backup/restore smoke checks. Eleven screenshots were captured from the real web
apps without browser page errors, using clearly identified demo fixtures.

Compatibility notes: back up before schema changes; old volumes may need UID
1000 ownership; production secrets must meet validation; existing users must log
in again. Legacy catalog/list endpoints remain, but the new web file chooser and
profile-progress features are not yet implemented in native clients. Real-provider
playback and production-load performance remain unverified.

The community edition adds [Project HQ](https://github.com/Installation-04/StreamRD/wiki/Project-HQ),
a Notion-importable tracker, guided setup, reviewed mounted-library batches, and
responsive interfaces. Read [v0.3.0 validation](https://github.com/Installation-04/StreamRD/blob/v0.3.0/docs/community-validation.md) for current checks.
