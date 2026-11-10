# Imports (My library) and account scans

In the navigation this screen is **Imports** and is for administrators: they import the media that the server's libraries show. People who are invited to the server watch through **Library** and do not need to connect an account.

Connect your own debrid account during onboarding and leave **Automatically scan
existing torrents after connecting** enabled. **My library** imports existing
account entries privately, with a visible scan panel, stop/retry actions and
idempotent rescans. Completed scans do not restart on every page visit.

Both apps support Real-Debrid torrents, AllDebrid magnets and Premiumize cloud
video folders. Phosphor also supports Torbox torrents. Scans follow bounded pages
and retain progress across restarts. They read existing account content without
creating/deleting torrents, selecting provider files or copying videos.

Your imports are separate from the shared curated catalog. Open a title and press
**Play from my account** to resolve a temporary link. Multi-video torrents offer a
file picker; pending transfers report readiness. Stream URLs are not persisted.
Browser compatibility depends on the media codecs/container; there is no transcoder.

StreamRD's **Discover** page also shows a **From your library** row (titles with artwork first) with a
link to all of them. The match panel at the top of My library tracks artwork matching and offers **Retry matching**.

Only movies and shows are imported: games, software, music, books and names with no readable title are skipped, and the
**Check my library for non-movie titles** button lists and removes what was imported earlier (nothing is removed from your debrid account).

With [metadata matching](https://github.com/Installation-04/StreamRD/wiki/Metadata-and-matching)
configured, imports can gain artwork, plot, cast, ratings and IMDb references.
Owners can preview and correct their own matches. Credential changes invalidate
stale scans/streams; rescan the current account before playing old imports.

Read the [complete account-library guide](https://github.com/Installation-04/StreamRD/blob/v0.5.0/docs/account-library.md)
for limits, private APIs, recovery and provider coverage. Plex/Jellyfin exports
still require real mounted files through the separate reviewed export workflow.
The release tests use local provider fixtures and an original color-video clip,
not a live debrid account.
