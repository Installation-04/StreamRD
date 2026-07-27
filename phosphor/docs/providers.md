# Debrid providers

Phosphor talks to premium-link/debrid services through one interface, so
adding a provider is a small, contained change. You bring your own paid
accounts; Phosphor stores each user's API keys server-side and never
exposes them to other clients (the API returns only `****abcd` hints).

> Use these services within their terms of service and your local law. You
> are responsible for what you download/stream through your own accounts.

## Real-Debrid

- Token at <https://real-debrid.com/apitoken>.
- API: `https://api.real-debrid.com/rest/1.0`, bearer-token auth.
- Magnet-only via the API (no arbitrary `.torrent` upload).

## AllDebrid

- Key at <https://alldebrid.com/apikeys>.
- API: `https://api.alldebrid.com/v4`, `apikey` + `agent` query parameters.
- Responses use a `{status, data|error}` envelope — an error can arrive with
  HTTP 200, so the client checks `status` explicitly.

## Premiumize.me

- Key at <https://www.premiumize.me/account>.
- API: `https://www.premiumize.me/api`, `apikey` query parameter.

## Torbox

- Key from the Torbox dashboard.
- API: `https://api.torbox.app/v1`, bearer-token auth, `{success, data|detail}` envelope.
- Torbox exposes two parallel pipelines instead of one generic
  "unrestrict a link" call: **torrents** (`/api/torrents/*`) and **web
  downloads** (`/api/webdl/*`, for direct hoster links). Phosphor's
  `TorboxProvider` hides this behind the same `DebridProvider` interface
  every other provider uses, via an internal pseudo-URL
  (`torbox://torrent/<id>/<fileId>` or `torbox://webdl/<id>/<fileId>`)
  produced by `addTorrent`/`getTorrentStatus` and consumed by
  `unrestrictLink`, which calls `/api/torrents/requestdl` or
  `/api/webdl/requestdl` accordingly to get the final direct link.
- The `/api/webdl/*` shape mirrors the documented `/api/torrents/*` shape;
  this hasn't been verified against a live Torbox account and may need
  small adjustments if a real response differs — see
  `phosphor/server/src/providers/torbox.ts` for the exact assumption.

## Adding another provider

1. Add its id to `PROVIDER_IDS` in `phosphor/server/src/providers/types.ts`.
2. Implement `DebridProvider` in `phosphor/server/src/providers/<name>.ts`
   (normalize responses into `DebridUserInfo` / `UnrestrictedLink` /
   `TorrentStatus`; throw `ProviderError` on failure).
3. Register an instance in `phosphor/server/src/providers/registry.ts`.
4. Add a key column to `DebridConfig` in `prisma/schema.prisma`, map it in
   `apiKeyFor()` (`manager.ts`), accept it in `PUT /api/account/debrid`, and
   add the input field in the web/TV/desktop settings screens.
5. Add unit tests with mocked `fetch` (see `phosphor/server/tests/providers.test.ts`).
