# StreamRD guide

StreamRD is a curated catalog. An administrator adds titles, descriptions, genres,
and link/magnet sources. Each user supplies their own Real-Debrid, AllDebrid, or
Premiumize credentials; provider order and fallback are configurable.

## Browse and save

Home shows Continue Watching, My List, recent titles, and catalog rows. The web
client loads compact, bounded pages and offers load-more controls. Use Search
for a title, open its details, and use the heart button to add/remove My List.
Favorites belong to the account and are shared across its viewing profiles.

## Watch and resume

Choose a viewing profile using **Watching as**, then open a title and press Play.
StreamRD resolves the selected source through your configured providers and hands
the resulting URL to the player. Pending torrent work is polled with bounded
retries, reusing a saved reference rather than repeatedly adding the torrent.

When a torrent contains several videos, choose the desired file. Samples and
non-video files are excluded from automatic single-video choice. Change files
using the player's file selector where offered. Pack progress belongs to the
selected file; select that episode again to resume it.

The web player periodically saves position and saves on playback events. Resume
is isolated by account/profile/title/file. Older player sessions and out-of-order
saves cannot overwrite the active session. At least 95% completion removes that
entry from the new Continue Watching row. Last page-exit delivery is best effort.

## Administration

Admin pages manage users, catalog entries, provider settings/order, request
timeouts, connectivity, logs, and configuration export/import. Export files and
database backups contain private information. Store them outside public source
control. Deactivating an account revokes its older sessions; password changes
revoke other sessions while retaining the initiating web session.

Resolution success does not guarantee browser codec support. StreamRD does not
transcode video. Mobile/TV projects remain in the repository, but the new web file
chooser and profile-progress flow have not yet been propagated to those clients.

See [Screenshots](https://github.com/Installation-04/StreamRD/wiki/Screenshots) and the
[API schema](https://github.com/Installation-04/StreamRD/blob/main/docs/api-schema.md).
