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
