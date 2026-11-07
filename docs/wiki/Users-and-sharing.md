# Users and server sharing

Administrators can manage accounts, change registration policy, create expiring
invitation links and sign other users out of all devices. Named shared libraries
allow selected users to watch through the source administrator's connected debrid
account, with no provider key required from the viewer.

1. Import your server account's media into My library.
2. In Admin → Users, choose invitation-only registration and create email-bound links.
3. After recipients join, create a named collection in Admin → Shared libraries and
   select the users who may watch it.
4. Viewers open Shared libraries. Removing a grant blocks new playback requests.

The collection contains present and future imports matching its all/movie/series
filter. Only the source administrator can publish or change that collection.
Original private collections and provider content are preserved when a share is removed.
The legacy curated catalog/search retain their existing server-wide rules.

This is the core server sharing model, not full Plex Home parity. PIN-protected
managed users, parental restrictions, device inventories, concurrency limits and
watch progress for shared imports remain future work. Direct provider URLs already
issued may work until the provider expires them.

See the [full guide](https://github.com/Installation-04/StreamRD/blob/v0.6.0/docs/server-sharing.md)
for the v0.6.0 implementation and API contract.
