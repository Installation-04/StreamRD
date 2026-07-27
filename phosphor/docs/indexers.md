# Indexers (Jackett / Prowlarr / Torznab)

Phosphor doesn't crawl torrent sites itself — it searches whatever
**Torznab-compatible** endpoints you point it at. Torznab is the same
protocol Sonarr/Radarr use: a simple `?t=search&q=<query>&apikey=<key>` GET
request that returns an RSS feed with per-result size/seeders/peers
attributes. Both of the tools below speak it identically, so Phosphor
doesn't need to know or care which one produced a given URL.

## Option A: Jackett

1. Run Jackett (e.g. `docker run -d -p 9117:9117 linuxserver/jackett`, or
   uncomment the `jackett` service in `infra/docker-compose.yml`).
2. Add and configure one or more indexers inside Jackett's own UI
   (`http://<host>:9117`).
3. In Jackett, either:
   - copy an individual indexer's **Torznab feed** URL + API key, or
   - use Jackett's **"all"** aggregate endpoint to search every configured
     indexer through a single Phosphor entry:
     `http://<host>:9117/api/v2.0/indexers/all/results/torznab/api`
     (API key shown at the top of the Jackett dashboard).
4. In Phosphor: Admin → Indexers → **Add indexer**, paste that URL and key,
   give it a name, save, then **Test**.

## Option B: Prowlarr

1. Run Prowlarr and add indexers inside its own UI.
2. Open an indexer's settings in Prowlarr and copy its **Torznab URL** (per
   indexer — Prowlarr doesn't have Jackett's single "all" shortcut, so add
   one Phosphor indexer entry per Prowlarr indexer you want searchable, or
   just add your two or three most useful ones).
3. In Phosphor: Admin → Indexers → **Add indexer**, paste the URL + API key.

## Testing and troubleshooting

- Admin → Indexers → **Test** runs a throwaway search ("test") against the
  endpoint and reports how many sample results came back, without touching
  your search history.
- If a search times out, raise `providerTimeoutMs` under Admin → Server —
  some indexers are slow, especially public trackers under load.
- Results without a magnet link (`hasMagnet: false`, only a `.torrent`
  download URL) currently can't be added to a debrid provider — Phosphor
  doesn't fetch and parse `.torrent` files to extract a magnet/infohash.
  Prefer indexers/trackers that expose magnets directly.
- Indexer API keys are stored in plaintext in the database and are included
  in `Admin → Server → Export config` — treat exported config files as
  sensitive.
