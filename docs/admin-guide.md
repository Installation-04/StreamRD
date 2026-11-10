# Admin guide

## Becoming admin

- The **first account** created on an empty server is automatically admin.
- Alternatively set `ADMIN_EMAIL=you@example.com` in the backend env; that
  account is promoted at signup or on server start.
- Existing admins can promote others: Admin → Users → **Make admin**.

Open the dashboard at `https://your-server/admin` (the Admin link appears in
the navbar for admin accounts). Non-admins are redirected away and every
`/api/admin/*` call is rejected server-side regardless of the UI.

## Dashboard tour

| Page | What you do there |
|---|---|
| **Overview** | User/title counts, total & last-hour plays, 24h playback failures, DB status, per-provider play counts, recent activity feed |
| **Users** | Filterable table; promote/demote roles, deactivate/reactivate accounts. You cannot demote or deactivate yourself. Deactivation locks the account out on their next request. |
| **Catalog** | Full CRUD for titles: metadata (name, type, year, genres, artwork URLs) and **debrid sources** — hoster links or magnet URIs with optional quality/label. Sources are only visible to admins; users just see a source count. |
| **Server** | Global provider order & per-provider global enable, provider timeout, max playback attempts, access toggles (public browse, login-required playback), config **export/import** |
| **Providers** | Enable/disable each service globally and run a connectivity test. Tests use *your own* API keys from Account → Debrid services, so configure those first. |
| **Logs** | Structured events with search, filters (type, level, provider, date range), paging, copy and download (see [Logs](#logs)) |

## Typical workflows

### Bootstrapping a new server

1. Sign up (you're now admin) and set your debrid keys under
   Account → Debrid services; hit **Test connection** for each.
2. Admin → Providers → test connectivity to confirm the server can reach the
   debrid APIs.
3. Admin → Catalog → add titles with at least one source each.
4. Choose invitation-only registration in Admin → Users, create invitation links,
   then grant accepted users access in Admin → Shared libraries. Shared viewers
   do not need their own debrid keys.

### Curating content

Each title holds an ordered list of sources. Playback tries sources in order
and, within each source, providers in the user's order — so put the most
reliable source first and offer quality alternatives after it. Magnet sources
resolve instantly only when the provider has the torrent cached; otherwise
playback returns "not ready yet" and the user can retry once the provider
finishes downloading.

### Handling playback complaints

1. Overview → check 24h failure count.
2. Logs → filter type `provider_error` to see which provider/hoster fails.
3. Providers → run a connectivity test.
4. If one service is degraded, disable it globally or move it down the order
   in Server settings; user playback falls back automatically.

### Backup & migration

Export config (Server page) regularly — it contains server settings, provider
settings, and the full catalog with sources, and can be re-imported on a
fresh install. User accounts and keys live in the database file; back that up
separately (see [deployment.md](deployment.md#backups)).

## Logs

**Admin → Logs** is the structured event log (sign-ins, playback, provider errors,
administrator actions). Search message text, filter by type, level, provider and a
from/to date range, and page through as much history as you need (100–1000 per page,
then **Load more**). **Copy shown** copies the entries on screen as plain text, each
row has its own **Copy** and **Details** (its extra data), and **Download all
matching…** saves every matching entry (up to 50,000) as a text log, JSON lines or
CSV with the same filters. Turn on **Live** to refresh every 10 seconds. Spreadsheet
exports neutralize cells that start with `=`, `+`, `-` or `@`. Downloading is itself
recorded as an administrator action. Logs can contain user ids and provider names;
share exports carefully.

## Updates, backups and restore (System page)

**Admin → System** has two sections below the upgrade status.

**Updates.** *Check for updates* compares the installed version with the latest
GitHub release (set `UPDATE_CHECK=false` to turn the lookup off, or
`UPDATE_REPOSITORY=owner/name` to follow a fork). The server never replaces itself.
**Update to vX.Y.Z** appears only when the operator configures `UPDATE_WEBHOOK_URL`
(and optionally `UPDATE_WEBHOOK_TOKEN`, sent as a bearer token): the server takes a
verified `pre-update-*` backup, then POSTs `{product, from, to}` to that URL and
reports success only if it accepts. The hook is yours to provide, for example a
small host-side script or an updater such as Watchtower; its address comes from the
environment, never from the admin page. If the hook refuses, the backup is kept and
nothing changes. After the update the new image starts, applies database upgrades
(with another verified snapshot when needed) and the page shows the new version.

**Backups & restore.** *Create backup* writes a consistent, integrity- and
foreign-key-checked SQLite snapshot into `backups/` beside the database (at most 20
manual backups). You can download, verify and delete backups. Backups contain
accounts, provider credentials and settings: keep downloaded copies private and
off the host.

*Restore* needs you to type `RESTORE`. The server re-verifies the backup, takes a
`pre-restore-*` safety backup of the current data, and **stages** the restore. The
database file is swapped at the next start, before anything opens it, so a running
server is never changed underneath. If the service is under a restart policy and
`ADMIN_RESTART=true` (set in the provided Compose files), the page restarts it for
you; otherwise restart it yourself. An older backup is migrated forward on startup
with its own snapshot. You can cancel a staged restore before restarting.
Sessions are checked against the restored data, so accounts created after the
backup no longer exist and must sign up again. A restore never deletes backups.

## Server-managed user access

Admin → Users controls registration, invitations, roles, account status and signing
other accounts out everywhere. Admin → Shared libraries publishes explicitly named
views of your imported media and grants selected users playback through your server
account. See the [users and sharing guide](server-sharing.md) for setup, API contracts,
revocation behavior and differences from Plex Home.
