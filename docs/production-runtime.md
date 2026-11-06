# Production runtime, upgrades, and recovery

StreamRD and Phosphor have separate Compose projects and databases. Run commands
from `infra/` for StreamRD or `phosphor/infra/` for Phosphor. The API/web ports are
47821/3000 and 61337/3100 respectively. Web API URLs are baked into the image and
must be reachable by the browser; rebuild the web image after changing them.

## Runtime changes in v0.2.0

All four images use Node 22. Backend builds emit `dist/src/index.js`; compiled
tests, TypeScript, tsx, and Vitest are excluded from the final runtime. The Prisma
CLI remains a production dependency for schema administration. The StreamRD demo
seed runs with `node dist/prisma/seed.js`. Both web images use Next standalone
output, explicit ports, and listen on all container interfaces.

Images run as the `node` user (UID/GID 1000). Compose waits for backend health
before starting the web container. Dependency installs use `npm ci` and committed
lockfiles; Node base tags still float, so builds are not bit-for-bit reproducible.

Production requires a stable, non-placeholder `JWT_SECRET` of at least 32 bytes.
Generate one with `openssl rand -hex 32`. Preserve it across restarts and upgrades.
Installers preserve existing `.env` files verbatim, never source them as shell
code, and create new ones with mode 0600. Port flags apply only on first install.
Development can use an ephemeral key; restarting then invalidates development
sessions. Upgrading to the new JWT claim format requires existing users to log in.

## Existing volumes and schema changes

Back up the database, `.env`, and any private exported configuration before
upgrading. Previously root-owned data may need an explicit ownership change. The
installer checks write access and stops with guidance; it does not silently change
volume ownership. Build the new images before using their administration scripts:

```bash
docker compose build backend web
docker compose stop backend
# New image, old volume: explicit root access allows backing up root-owned data.
docker compose run --rm --no-deps --user root backend \
  node scripts/backup-db.cjs /app/data/pre-upgrade-unique.db
```

Only continue after the helper reports a verified snapshot. Copy it off the
volume using a container or your volume administration tools and keep a private
copy of `.env` separately. If the app volume is root-owned, change ownership of
that app's data directory explicitly:

```bash
docker compose run --rm --no-deps --user root backend \
  sh -c 'chown -R 1000:1000 /app/data'
```

For bind mounts, coordinate the corresponding host ownership with your storage
policy. These commands refer only to the selected product's data mount.

Startup applies `prisma db push --skip-generate` by default and does not pass
`--accept-data-loss`. Versioned migrations are not yet implemented. To control
when schema synchronization happens, set `APPLY_SCHEMA_ON_START=false` in `.env`,
keep the writer stopped, and apply the reviewed schema once:

```bash
docker compose run --rm --no-deps -e APPLY_SCHEMA_ON_START=true backend \
  node scripts/prepare-db.cjs
docker compose up -d backend web
```

Check `/api/health`, sign in, and inspect existing accounts/catalog or indexers.
The authentication upgrade fixture has also verified preservation of all 11
StreamRD and 7 Phosphor pre-upgrade application tables through SQLite's User table
rebuild. Always test your own backup before relying on a production upgrade.

## Backups and restoration

With a running backend:

```bash
docker compose exec backend node scripts/backup-db.cjs /app/data/backup-unique.db
docker compose cp backend:/app/data/backup-unique.db ./backup-unique.db
chmod 600 ./backup-unique.db
```

Use a new destination each time. The helper reserves a new file with mode 0600,
uses SQLite `VACUUM INTO` for a consistent snapshot, and checks integrity and
foreign keys. It refuses to overwrite any existing file. A failed operation may
leave an incomplete new file: use only snapshots reported as verified. Protect
off-host copies; databases and configuration exports contain private credentials.
Keep `.env` and signing keys separately from public source control.

Test restoration into a fresh volume, copying the verified snapshot to
`/app/data/streamrd.db` or `/app/data/phosphor.db`, with the directory and file
owned by UID/GID 1000. Start the matching image with the same signing secret and
`APPLY_SCHEMA_ON_START=false`. Verify health, login, and expected application data
before directing clients to it. Keep the previous volume until recovery is
confirmed. Stop all writers before a production cutover; use a fresh volume to
avoid mixing a restored database with stale SQLite WAL/SHM files. Restoring an
older schema also requires its matching application version.

## Validation

From the repository root, build and validate each product without publishing:

```bash
docker build -t streamrd-server server
docker build -t streamrd-web web
bash infra/smoke-images.sh streamrd
docker build -t phosphor-server phosphor/server
docker build -t phosphor-web phosphor/web
bash infra/smoke-images.sh phosphor
```

The smoke check uses disposable containers and volumes, checks non-root/pruned
runtimes, signs up an admin, creates application data, verifies restart persistence,
backs up/restores into another volume, signs in again, and checks the web login
page on its expected port. It never mounts an existing application volume or
contacts real providers. It also checks mounted-file export and manifest persistence,
and verifies SQLite-only restoration still works with the optional mount disabled.
CI runs these checks for pull requests and main pushes.
Installer regressions use mocked Docker/OS commands and temporary directories.

In managed cloud environments, pass the session CA to each build when required:
`docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -t streamrd-server server`.
The Dockerfiles extend Node's trust only for the relevant network build step;
the CA is not stored in an image layer and TLS verification remains enabled.

Optional Plex/Jellyfin library manifests and links live outside SQLite: back them
up separately as described in [plex-jellyfin.md](plex-jellyfin.md).
