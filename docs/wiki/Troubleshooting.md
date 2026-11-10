# Troubleshooting

| Symptom | Check |
|---|---|
| Web opens but API requests fail | Set `API_BASE_URL` to a browser-reachable URL and rebuild web. `backend` is a Docker hostname, not a browser hostname. |
| Phosphor web is unreachable | Default web port is 3100; StreamRD uses 3000. Installer-chosen host ports are in `.env`. |
| Backend exits about a signing secret | Supply a stable non-placeholder `JWT_SECRET` of at least 32 bytes. Do not regenerate it on every restart. |
| Existing users are logged out after upgrade | New JWT claims require a fresh login. Password changes and deactivation also invalidate older sessions. |
| Installer reports UID 1000 write failure | Back up and follow the explicit ownership upgrade in the production guide. Do not delete the existing volume. |
| Schema preparation refuses a change | Review the schema and backup first. Startup does not accept destructive data loss automatically. |
| Demo titles cannot play | Configure a usable debrid key; even link sources pass through the provider layer. A seeded catalog supplies metadata, not a provider subscription. |
| StreamRD keeps showing pending work | Provider processing may still be running. Retries reuse stored source references, with bounded polling; inspect provider status and credentials. |
| Torrent pack asks for a file | Select the episode/video. Progress is stored for that file and profile. |
| URL resolves but video will not play, or "No video with supported format and MIME type found" | Browsers cannot open MKV/AVI and cannot decode DTS/TrueHD/AC3 audio; HEVC often fails too. The player explains which applies. Play the stream in VLC or mpv (Copy stream link), or pick an MP4 with H.264 video and AAC audio. Neither app transcodes. |
| Library titles show no artwork or details | Open **My library**: the match panel shows progress, review and failed counts. Check that a provider key is saved and automatic matching is on in Admin → Metadata, then press **Retry matching**. Hash-only names cannot be matched. |
| Need more log history | Admin → Logs: search, filter by date, load more, copy, or download up to 50,000 matching entries. |
| Phosphor search is empty or partially fails | Test the enabled Torznab endpoint from the backend network, verify its key and filters. Partial successes remain visible. |
| Queue progress slows in background | Refresh pauses in hidden tabs and backs off after repeated work. Return to the tab or use manual refresh. |
| Backup fails on a reused destination | Use a new path. The helper refuses overwrites; only trust a snapshot reported as verified. |

For database recovery and upgrades, read [Operations and recovery](https://github.com/Installation-04/StreamRD/wiki/Operations-and-recovery).
Report bugs with the application version/tag, affected product, reproducible
steps, and sanitized error/request IDs. Never include debrid keys, JWTs, `.env`,
private indexer links, or database backups.
