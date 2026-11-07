# Versioned database upgrades

StreamRD and Phosphor now use reviewed SQLite migration files and independent
schema/history validation. Production startup no longer runs `prisma db push`.
Each app has its own database and migration chain. PostgreSQL is not supported by
this release; changing the Prisma provider alone is insufficient.

## Supported starting points

| Database | Preparation behavior |
|---|---|
| Missing or empty | Create a private SQLite file and deploy the committed chain |
| Exact historical v0.1 schema from repository checkpoint `1a5dbce` | Verify a snapshot, establish the legacy baseline, then apply the community upgrade |
| Exact unmanaged v0.2/v0.3 schema | Verify a snapshot, record the community baseline, then apply later committed steps |
| Managed database at a known checkpoint | Validate history/checksums and the checkpoint schema before applying pending migrations |
| Unknown, partial, customized, corrupt, or inconsistent database | Refuse the upgrade; retain the source and require review/recovery |

The initial chain is `00000000000000_legacy_baseline` followed by
`20261106000000_community_upgrade`. The business schema in v0.4.0 matches v0.3.0;
the new migration history records how that schema was reached. The historical
upgrade adds session invalidation and StreamRD source/progress tables using an
additive User-column change that preserves existing child rows and foreign keys.

Adoption is deliberately limited to known schemas. Intermediate development
snapshots, custom tables/indexes, unsupported SQLite objects, and partially
applied changes are not silently treated as a supported release.

## Prepare an existing installation

Run commands from `infra/` for StreamRD or `phosphor/infra/` for Phosphor. Back up
private `.env` and exported configuration separately. Keep the signing key stable.
Stop every writer using this database before preparation or restoration; one
backend process owns each data volume. Preserve the old image and volume until
recovery is verified.

```bash
docker compose build backend web
docker compose stop backend
# Explicit server-side preparation with the new backend image:
docker compose run --rm --no-deps backend node scripts/migrate-db.cjs
# Inspect the resulting records and schema without changing them:
docker compose run --rm --no-deps backend node scripts/db-status.cjs
docker compose up -d backend web
```

Existing root-owned volumes still need the explicit backed-up UID 1000 ownership
procedure in [production-runtime.md](production-runtime.md). There is no automatic
ownership repair or destructive reset in the migration runner.

Before any baseline or migration changes to an existing nonempty database, the
runner uses SQLite's consistent snapshot operation, verifies integrity and foreign
keys, and writes a new mode-0600 snapshot into `backups/` beside the configured
database. Newly created backup directories use mode 0700. A unique name prevents
overwriting older snapshots. Copy a verified snapshot off-host: a copy on the same
volume does not protect against losing that volume. Provider credentials remain
sensitive in both databases and snapshots.

A successful preparation prints its mode and snapshot basename when one was
required. Existing current databases are a no-op on restart and do not generate
another snapshot. A failed operation can leave an incomplete newly reserved backup
file; the name alone is not proof of verification. Keep failure evidence and test
recovery before trusting any snapshot.

## Controlled startup

`APPLY_SCHEMA_ON_START=true` remains the default. Startup validates production JWT
configuration first, then prepares the database through the versioned runner.
An unsupported database stops startup rather than falling back to schema push.

With `APPLY_SCHEMA_ON_START=false`, preparation issues inspection queries only. It
does not initialize a database, establish a baseline, create upgrade locks or
snapshots, or deploy SQL. It permits an already current managed database or an
exact current-schema unmanaged database, allowing deliberate inspection/adoption.
Missing, legacy, pending, failed, or incompatible schemas are refused before the
application starts. A known historical checkpoint is not considered current when
a later release has additional migrations.

The explicit `migrate-db.cjs` administration command applies preparation regardless
of this startup toggle; running it is the deliberate upgrade action. The status
command reports JSON and exits 0 only for `current`, 1 for a state needing review,
and 2 when inspection is unavailable. Direct Node/npm use requires an exported
SQLite `DATABASE_URL`; Compose supplies it automatically:

```bash
DATABASE_URL=file:./data/streamrd.db npm run db:status
DATABASE_URL=file:./data/streamrd.db npm run db:migrate
```

Relative database paths resolve under the backend's `prisma/` directory, matching
Prisma's datasource convention.

## Readiness and independent checks

**Admin → System** reads the actual release version, Node version, database
availability, migration state/counts, and optional media configuration. It requires
a current administrator session and returns private/no-store responses without
keys, raw database paths, migration logs, or exception details. The browser offers
refresh and recovery documentation, not a button that changes the database.

States are current, unmanaged, pending, failed, drifted, and unavailable. Counts
are not shown as verified when the history/schema check failed. The page's snapshot
panel describes the policy; it is not evidence that a backup exists for your data.

Prisma's own deploy/diff commands do not detect every kind of drift. The runner
also checks bundled SQL/datamodel checksums, known ordered migration history,
SQLite integrity/foreign keys, and structural checkpoint signatures. Extra tables,
triggers, views, custom constraints, unsupported indexes, edited checksums, unknown
records, or incomplete baselines cause refusal before new changes. These are
inspection queries against operator-managed storage, not an OS-enforced read-only
sandbox; do not replace or unmount the database during inspection/preparation.

## Failed upgrades and interruption

Do not repeatedly restart into a failed or unknown migration state. Stop writers,
retain the database, relevant logs, pre-upgrade snapshot, and matching application
images. Restore a verified snapshot into a fresh correctly owned volume, test
health/login/application data, and switch clients only after verification.

A process interruption between the two current-schema baseline records is
recognized as `baseline-history-incomplete`; the runner refuses duplicate upgrade
SQL. Unfinished and rolled-back migration records also require review. This first
migration release intentionally refuses such histories rather than automatically
clearing, ignoring, or replaying them. Do not delete `_prisma_migrations`, edit
checksums, or mark arbitrary migrations applied to make the error disappear.
Advanced history repair requires a reviewed plan and verified schema/data evidence;
restoring the known pre-upgrade snapshot is the supported recovery route here.

Concurrent upgrade commands use an exclusive `<database>.upgrade.lock` file at the
canonical database path. A process releases only its own lock inode. After a crash,
check that every writer/upgrader is stopped before an administrator investigates a
stale lock; the application never deletes another process's lock automatically.

## Maintaining the migration chain

Migration SQL and historical datamodel fixtures are immutable once released. Add
new migration directories for future changes; do not rewrite old steps. SQL uses
explicit SQLite transactions. `.gitattributes` enforces LF for Prisma assets so
checkouts do not silently alter checksums.

After reviewing new SQL and updating the current datamodel, regenerate checkpoints
from the backend directory:

```bash
node scripts/generate-migration-snapshots.cjs
node scripts/generate-migration-snapshots.cjs --check
```

The generator uses only fresh temporary databases, executes each migration prefix,
compares historical/current datamodels, and creates/checks the committed structural
signatures and hashes. It never uses the configured application database. Commit
all reviewed SQL, current datamodel, and regenerated metadata together. Tests cover
an additional future migration so a known unmanaged community checkpoint is not
mistakenly treated as the latest schema.

`db push` remains useful for disposable development/test fixtures; it is not a
production upgrade fallback. The older auth-upgrade validator tests a derived
intermediate schema; the new migration fixtures use the exact historical
checkpoint and current supported release schemas.

## v0.5.0: metadata and private account imports

Two additive migrations follow the released v0.4 chain:
`20261106010000_metadata_automation` adds durable matching records;
`20261107000000_account_library` adds private imports/scans, the automatic-import
preference and nullable metadata ownership with user-deletion cascades.
Existing supported data is preserved. A current v0.4 database is pending these
steps; startup with schema application disabled refuses it until preparation.

Known exact latest unmanaged schemas can be adopted when their structure uniquely
identifies the checkpoint. A schema-identical data-only step is never guessed as
applied merely from structure. Released SQL and historical checkpoints remain
unchanged. The checkpoint generator reopens its inspection connection after each
external SQL prefix to avoid stale SQLite schema caches.
