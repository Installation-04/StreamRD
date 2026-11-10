# Discover, request and track media

Both web apps can search TMDB or OMDb for movies and shows outside the server's
library. Open **Find media**, search a title or IMDb ID, then open its media page.
StreamRD's collection search also offers **Search beyond your library**, carrying
your query into discovery. Phosphor's indexer search remains a separate workflow.

An administrator must first configure the metadata provider in **Admin → Metadata**.
Viewers do not supply API keys. Discovery details include description, cast, year,
artwork where supplied, source-labeled ratings and provider attribution.

## Requesting a title

The media page checks the viewer's current private imports, granted shared
libraries. If accessible media is found,
it shows the appropriate library link. It does not expose another user's private
collection. Metadata identity is preferred; legacy matching requires an exact
name/type and known matching year, without overriding conflicting metadata IDs.

Otherwise choose **Request**. The server verifies the title through the metadata
provider, deduplicates requests by canonical identity and records your subscription.
Several people can follow one request without submitting several downloads.
**My requests** shows only the requests you follow; the administrator can review
all requests. Stopping tracking removes your subscription, not provider content.

Every request waits for administrator approval. A show request identifies the
show; download progress refers to the specific release the administrator chooses,
not an assurance that all seasons and episodes have been acquired.

## Administrator approval

Open **Admin → Requests**, inspect the title, choose a destination and supply a
magnet for the release you have reviewed. The current implementation accepts
BitTorrent v1 magnets, including base32 info hashes and hybrid magnets with a v1
hash. It does not automatically choose a torrent or quality from metadata search.
Use your normal source/indexer workflow to find the desired release.

- **Cloud:** choose an enabled debrid provider configured on your own administrator
  account. Optionally select one of your enabled, type-compatible shared libraries.
  Approval does not automatically grant that entire library to requesters.
- **Local:** use the qBittorrent connection saved by the approving administrator in
  **Admin → Download settings**. qBittorrent chooses its configured storage location;
  the app adds a request-specific tag and preserves the client’s category defaults.

Approval queues durable work. It does not wait for a provider to download a release
inside the HTTP request. An administrator can reject or cancel before submission
starts. Once a transfer may have started, manage actual cancellation/deletion in
the provider or qBittorrent client; the app will not silently delete that content.

## qBittorrent setup

Enable its Web UI and configure authentication. Enter the Web UI base URL,
username and password in **Admin → Download settings**, save, then test the
connection. The URL must be reachable from the backend, for example
`http://qbittorrent:8080` on a shared Docker network. `localhost` inside a container
refers to that container rather than the host or another service.

Credentials stay on the server. A blank password field preserves the saved value;
explicit clearing disables the connection. Other administrators cannot reuse the
saved connection's credentials. An active administrator can reset an abandoned
configuration after its former owner is inactive, demoted or removed; reset erases
its credentials and requires a new connection. It does not delete any torrents.

qBittorrent uses its configured save locations and category rules. Mount the
resulting video directory into the relevant media servers when you want Plex or
Jellyfin to scan it. The request tracker does not copy, proxy or transcode files.

## What the statuses mean

| Status | Meaning |
|---|---|
| Awaiting approval | Recorded on this server; no transfer submitted |
| Approved / sending | An approved release is entering the downloader |
| Queued | The client reports waiting, checking, metadata fetch or a paused state |
| Downloading | The cloud provider or qBittorrent reports active transfer progress |
| Download complete | The selected release is downloaded; library import/access is separate |
| Available | An indexed cloud import exists in the assigned shared library; each viewer's current grants are still checked |
| Needs administrator | The connection, transfer or submission needs inspection/reconciliation |
| Not approved / cancelled | Stopped before transfer submission |

Percentages come from the download client. Missing progress stays unknown instead
of being fabricated. Request pages poll while visible, with bounded polling and a
manual refresh action. They include a timeline of measured state changes.

When a cloud download finishes, the server queues a read-only scan of that source
account. The request becomes available only after the exact provider reference is
imported with its current account binding and assigned library. A requester without
a library grant sees download completion and a request for administrator access.
A newly following member does not cause the title to download again.

Local completion means the release is downloaded in qBittorrent. It remains
**download complete / awaiting library import** and has no invented Play link.
Publishing local files into Plex/Jellyfin or another library is a separate operation.
The web app's shared player currently resolves provider streams rather than serving
arbitrary local files.

## Interrupted work and recovery

Submission leases and revisions survive restarts. If an external submission may
have succeeded but its result is unknown, the server asks an administrator to
inspect the destination. It never blindly submits that request again.

After inspecting the destination, **Resume tracking** reuses the known reference
or an administrator-supplied existing reference. This resumes read-only polling;
it does not add a torrent again. Local references must match the approved magnet's
exact info hash. Source ownership and the original credential binding must remain
valid. Changed connections require administrator intervention.

If failure happened before any transfer submission was attempted, the request
explicitly reports that no transfer was submitted. Correct its connection/source
and approve it again. This case is kept distinct from ambiguous submissions.

## API overview

All routes require active authentication and return private, non-cacheable data.
Members never receive provider references, magnets, credentials or subscriber lists.

| Endpoint | Purpose |
|---|---|
| `GET /api/discovery/search` | Metadata title search with `q`, `type`, optional `provider` |
| `GET /api/discovery/:provider/:type/:id` | Details, scoped availability and request status |
| `POST /api/requests` | Request or follow `{provider,id,type}` |
| `GET /api/requests`, `GET /api/requests/:id` | Private followed requests and timeline |
| `POST /api/requests/:id/unfollow` | Stop tracking without removing content |
| `GET /api/admin/requests`, `GET /api/admin/requests/:id` | Administrator queue and details |
| `POST /api/admin/requests/:id/approve` | Approve destination, magnet, optional provider/library |
| `POST /api/admin/requests/:id/reject`, `POST .../:id/cancel` | Stop before submission |
| `POST /api/admin/requests/:id/resume` | Reconcile read-only tracking with optional `reference` |
| `GET`, `PUT /api/admin/request-settings` | Private qBittorrent configuration |
| `POST /api/admin/request-settings/test`, `POST .../reset` | Test or safely erase the saved connection |
