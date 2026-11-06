# Operations and recovery

Run Compose commands from `infra/` (StreamRD) or `phosphor/infra/` (Phosphor).
The deployments have separate volumes. Keep the signing secret stable and save
private configuration separately from source control.

## Before upgrading

Read the full [production runtime and recovery guide](https://github.com/Installation-04/StreamRD/blob/main/docs/production-runtime.md).
Version 0.2.0 switches runtime containers to UID/GID 1000, validates production
signing keys, and changes JWT claims, requiring existing users to log in again.
Back up the database and `.env`; stop writers before schema/ownership changes.
Old root-owned volumes require an explicit ownership upgrade, described in that
guide. Installer reruns stop with guidance if the data directory is not writable.

Schema synchronization still defaults to `prisma db push` without accepting data
loss. Versioned migrations are not implemented. Set `APPLY_SCHEMA_ON_START=false`
to separate schema application from service startup, following the documented
one-off preparation command after verifying a backup.

## Back up

```bash
docker compose exec backend node scripts/backup-db.cjs /app/data/backup-unique.db
docker compose cp backend:/app/data/backup-unique.db ./backup-unique.db
chmod 600 ./backup-unique.db
```

The helper uses SQLite's consistent snapshot operation and checks integrity and
foreign keys. It creates a private file and refuses any existing destination.
Use only snapshots reported as verified; a failed operation may leave an
incomplete new file. Copy backups off-host and protect their provider credentials.
Admin config exports are useful but do not replace a complete database backup.

## Verify recovery

Restore a verified snapshot into a fresh volume with UID/GID 1000 ownership,
using the correct database filename and matching application version. Start it
with the stable signing key and `APPLY_SCHEMA_ON_START=false`. Check health,
login, and known application data before a cutover. Preserve the old volume until
recovery is confirmed; do not combine a backup with stale WAL/SHM files.

The production smoke script proves this flow on disposable volumes for both apps:
`bash infra/smoke-images.sh streamrd` or `bash infra/smoke-images.sh phosphor`,
from the repository root after building the corresponding two images. It also
checks restart persistence, non-root execution, pruned development tooling, and
the web login page.

Use `docker compose logs backend web` and `/api/health` for diagnosis. Avoid
publishing logs/configuration containing credentials. Password changes invalidate
older sessions; rotating the signing key invalidates all signed sessions.
