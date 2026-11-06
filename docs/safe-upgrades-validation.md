# Safe Upgrades validation — v0.4.0

## Backend regression evidence

**318 tests passed:** 186 StreamRD across 19 files and 132 Phosphor across 16 files.
Both server and both web type checks passed. Forty added backend tests cover
versioned migration preparation and read-only administrator diagnostics.

Each product exercises new database deployment, no-op restarts, populated exact
historical v0.1 upgrades and current v0.3 adoption. Every populated application's
preexisting rows/columns and foreign keys are checked for preservation. Existing
database changes require a verified private snapshot; new databases require none.

Refusal fixtures cover unexpected columns/tables/triggers, custom `sqliteX` names,
managed schema drift, changed SQL/datamodel checksums, unknown/incomplete/failed
history, interrupted baseline adoption and another process's upgrade lock. Disabled
preparation preserves existing bytes, never initializes missing storage, and
creates no locks, backups or history. A future third migration proves that a
known unmanaged checkpoint cannot masquerade as the latest schema.

Checkpoint generation verifies every SQL prefix against historical/current
datamodels in fresh temporary databases, even when an application database URL is
configured. Production preparation validates signing configuration before creating
database directories. System API tests check live administrator authorization,
private/no-store responses, local-only inspection, schema preservation, sanitized
unavailable states and the read-only CLI's noncurrent exit code.

## Production acceptance

All four Node 22 production images built successfully using frozen dependency
installs and normal certificate verification. Both enhanced container smoke checks
passed on new disposable volumes. They verify non-root/pruned runtimes, fresh
migration deployment, restart persistence, login/application data, optional mounted
exports, verified backup/restore with automatic schema application disabled, and
web login availability.

The additional populated v0.3 fixture is constructed from the frozen historical
datamodel in a separate new volume. Startup adopts both migration records and
preserves the existing administrator and catalog/indexer. Its one private automatic
snapshot is inspected independently: it contains the original account and no
migration history, proving it predates baseline adoption. Fixture construction uses
schema push only to recreate that historical test database; production startup
uses the committed migration chain.

## Browser and visual evidence

**14 browser journeys passed with 20 screenshots and no browser page errors.**
The [checked-in report](screenshots/v0.4.0/validation.json) records the journeys and
filenames. Both real System APIs report current migration history; their desktop
and mobile pages are captured from final production images. Separate simulated
503 and database-down responses verify stale-result labeling, unverified counts,
and refresh/retry recovery against the real endpoint. The normal screenshots use
real current database state, not these failure fixtures.

Existing journeys cover actual UI login, guided setup, mounted-file selection,
reviewed movie/episode exports, repair/removal, favorites/catalog search, local
Torznab and saved searches, queue outage recovery, member separation, themes and
mobile signup. Desktop and 390px mobile document widths are checked for overflow.
The runner refuses occupied ports, creates fresh containers/volumes and cleans up
only its own resources.

Accounts, catalog entries, indexer results and filesystem videos are disposable
fixtures. Files contain non-playable bytes; CSS poster fallbacks are original app
designs. No private provider credentials, real indexers or live debrid requests are
used. See [screenshot provenance](screenshots/v0.4.0/README.md).

## Practical limits

This is migration, recovery and workflow evidence, not production-load testing,
native-client parity, a complete accessibility audit or live-provider playback.
SQLite storage must be controlled by the operator and all writers stopped for
upgrades/restoration. Query-only inspection is not an OS-enforced read-only sandbox.
An on-volume snapshot is not protection against losing the volume.

The prior [real Plex/Jellyfin scanner evidence](media-library-validation.md) remains
the compatibility baseline; scanner naming and manifest formats are unchanged.
No new live scanner or FUSE/cloud mount claim is made. Notion publication remains
blocked by the missing workspace connection; repository tracking/import bundles
are maintained instead.
