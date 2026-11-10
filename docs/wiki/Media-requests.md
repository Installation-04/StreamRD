# Discover and request media

Both web apps can search TMDB or OMDb for titles outside your library. Open **Find media**,
search by title or IMDb ID and open the media page. It checks what you can already watch (your
private imports, libraries shared with you and the curated catalog) and otherwise offers **Request**.
Requests are deduplicated, several people can follow one request privately, and **My requests**
shows only the ones you follow. An administrator must configure a metadata provider under
**Admin → Metadata** first; viewers never supply API keys.

Administrators review requests under **Admin → Media requests** and approve them to a cloud
provider or a local qBittorrent client configured under **Download settings**. Approval never
re-submits an ambiguous transfer, and a finished download is not called playable until a current
library entry is published and shared with the viewer.

The [all-in-one container](https://github.com/Installation-04/StreamRD/wiki/Getting-started#quick-install)
bundles StreamRD, Phosphor and qBittorrent. Read the full
[media requests guide](https://github.com/Installation-04/StreamRD/blob/v0.8.1/docs/media-requests.md)
and [single-container guide](https://github.com/Installation-04/StreamRD/blob/v0.8.1/docs/single-container.md).
Release checks use provider fixtures; real qBittorrent authentication is exercised in the container
smoke test, not live downloads.
