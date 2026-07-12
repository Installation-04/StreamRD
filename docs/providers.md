# Debrid providers

StreamRD talks to premium-link / debrid services through one interface, so
users can mix providers and the server can fall back between them. You bring
your own paid accounts; StreamRD stores each user's API keys server-side and
never exposes them to other clients (the API returns only `****abcd` hints).

> Use these services within their terms of service and your local law. You
> are responsible for what you stream through your own accounts.

## Configured order of battle

Per user: **primary provider** → personal fallback order (optional) → global
order set by the admin. Providers without a stored key, or globally disabled
ones, are skipped. `maxPlaybackAttempts` caps how many are tried per play.

## Real-Debrid

- Get a token at <https://real-debrid.com/apitoken> and paste it into
  Account → Debrid services.
- API: `https://api.real-debrid.com/rest/1.0`, bearer-token auth
  (docs: <https://api.real-debrid.com/>).
- Endpoints used: `GET /user`, `POST /unrestrict/link`,
  `POST /torrents/addMagnet` + `POST /torrents/selectFiles/{id}` (all files),
  `GET /torrents/info/{id}`, `GET /torrents`.
- Notes: magnet-only via API; API tokens expire if unused for long periods;
  errors surface the API's `error` string.

## AllDebrid

- Get a key at <https://alldebrid.com/apikeys> (docs: <https://docs.alldebrid.com/>).
- API: `https://api.alldebrid.com/v4`, `apikey` + `agent` query parameters
  (StreamRD sends `agent=streamrd`).
- Endpoints used: `GET /user`, `GET /link/unlock`, `POST /magnet/upload`,
  `GET /magnet/status`.
- Notes: responses use a `{ status, data | error }` envelope — StreamRD
  raises the embedded error even when HTTP status is 200. Magnet
  `statusCode: 4` means ready.

## Premiumize.me

- Get the key from <https://www.premiumize.me/account>
  (docs: <https://www.premiumize.me/api>).
- API: `https://www.premiumize.me/api`, `apikey` query parameter.
- Endpoints used: `GET /account/info`, `POST /transfer/directdl`,
  `POST /transfer/create`, `GET /transfer/list`.
- Notes: `directdl` returns a content array — StreamRD streams the first
  entry; premium status is derived from `premium_until`.

## Adding another provider

1. Add its id to `PROVIDER_IDS` in `server/src/providers/types.ts`.
2. Implement `DebridProvider` in `server/src/providers/<name>.ts`
   (normalize responses into `DebridUserInfo` / `UnrestrictedLink` /
   `TorrentStatus`; throw `ProviderError` on failure — the manager treats any
   throw as "try the next provider").
3. Register an instance in `server/src/providers/registry.ts`.
4. Add a key column to `DebridConfig` in `prisma/schema.prisma`, map it in
   `apiKeyFor()` (`manager.ts`), accept it in `PUT /api/account/debrid`,
   and add the input field in the clients' settings screens.
5. Add unit tests with mocked `fetch` (see `server/tests/providers.test.ts`).

Timeout, base-URL override and enable/disable come for free from the
settings layer.
