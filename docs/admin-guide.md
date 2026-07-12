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
| **Logs** | Recent structured events with filters for type (signup/login/playback/provider_error/admin_action/system), level, and provider |

## Typical workflows

### Bootstrapping a new server

1. Sign up (you're now admin) and set your debrid keys under
   Account → Debrid services; hit **Test connection** for each.
2. Admin → Providers → test connectivity to confirm the server can reach the
   debrid APIs.
3. Admin → Catalog → add titles with at least one source each.
4. Invite users — they sign up themselves and add their own keys.

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
