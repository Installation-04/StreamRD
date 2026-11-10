# Admin guide

## Becoming admin

The first account created on an empty server is automatically admin (or
set `ADMIN_EMAIL` in the backend env). Existing admins can promote others
under Admin → Users.

## Dashboard tour

| Page | What you do there |
|---|---|
| **Overview** | User/indexer counts, download stats (total/last-hour/24h failures), DB status, per-provider job counts, recent activity |
| **Users** | Promote/demote roles, deactivate/reactivate accounts. You cannot demote or deactivate yourself. |
| **Indexers** | Add/remove/enable/disable Torznab endpoints (Jackett/Prowlarr), run a connectivity test. See [indexers.md](indexers.md). |
| **Server** | Global provider order & per-provider enable, timeouts, max results per indexer, config export/import |
| **Providers** | Enable/disable each debrid service globally, run a connectivity test using your own keys |
| **Logs** | Recent structured events filterable by type/level/provider (signup, login, search, download, provider_error, admin_action, system) |

## Typical workflows

### Bootstrapping a new server

1. Sign up (you're now admin).
2. Stand up a Jackett or Prowlarr instance (or uncomment the `jackett`
   service in `infra/docker-compose.yml`), configure some indexers there,
   then add its Torznab URL under Admin → Indexers → **Test**.
3. Add your own debrid API key(s) under Account → Debrid, test the
   connection.
4. Try a search. Invite other users — they sign up and add their own keys.

### Handling failed downloads

1. Overview → check the 24h failure count.
2. Logs → filter type `provider_error` to see which provider is failing.
3. Providers → run a connectivity test for that provider.
4. If a provider is down, disable it globally under Server, or lower its
   priority in the provider order — new downloads will use the next one.

### Handling flaky indexers

1. Indexers → **Test** each one; a timeout usually means raising
   `providerTimeoutMs` under Server, not the indexer itself.
2. Disable indexers that consistently error rather than removing them, so
   their config (URL/key) is preserved for later.

### Backup & migration

Export config (Server page) regularly — it contains server settings,
provider settings, and all indexer configs (**including their API keys in
plaintext** — the exported file is sensitive). Re-import on a fresh
install. User accounts, debrid keys, and download history live in the
database file; back that up separately (see
[deployment.md](deployment.md#backups)).

## Server-managed user access

Admin → Users controls registration, invitations, roles, account status and signing
other accounts out everywhere. Admin → Shared libraries publishes explicitly named
views of your imported media and grants selected users playback through your server
account. See the [users and sharing guide](../../docs/server-sharing.md) for setup, API contracts,
revocation behavior and differences from Plex Home.


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
