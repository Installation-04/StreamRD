# Users, invitations and server-shared libraries

StreamRD and Phosphor support server-managed sharing: an administrator connects
their debrid account, imports its existing media, publishes a named library and
grants selected users access. Viewers sign in to this server and can watch without
supplying debrid credentials. This is a local server account system; Plex accounts
and Plex Home identities are not used.

## Account administration

The first account is an administrator unless `ADMIN_EMAIL` designates a specific
administrator. Existing administrators can promote or demote other users and
activate or deactivate their accounts in **Admin → Users**. You cannot demote or
deactivate yourself. Role and active-state changes apply on the next authenticated
request. Concurrent changes also recheck the administrator and retain at least one
active admin. **Sign out everywhere** invalidates the selected user's existing sessions;
the user can subsequently sign in again. Deactivation also prevents a new login.

Users keep their own passwords and preferences. StreamRD additionally supports up
to five viewing profiles per account and separate catalog playback progress.
These profiles currently have no PIN gate or enforced maturity restrictions.
Shared imported-media playback records each viewer's own resume position (not
per profile): the player resumes where that account stopped and **Shared libraries**
shows a Continue watching row. Progress is stored by file, never includes provider
links or credentials, and is removed with the account or the import.

## Choose how new accounts join

In **Admin → Users → Registration**, choose:

| Mode | Who can create a new account |
|---|---|
| Open | Anyone who can reach the server's signup page |
| Invitation only | The recipient of a valid, unused invitation |
| Closed | Nobody, including invitation recipients, until registration is reopened |

Existing installations retain **Open** registration until an administrator changes
it. Restricting registration does not deactivate existing users or remove their
library grants. An empty server can still create its bootstrap administrator;
when `ADMIN_EMAIL` is set, restricted registration permits that address only.

Create an invitation with the recipient's email and an expiry from 1 to 30 days
(default seven). Copy the link shown after creation and send it yourself. This
feature does not send email. Links are email-bound, single-use and revocable.
Creating a replacement invitation invalidates older unused links for that address.
Existing users should sign in and receive a library grant instead of an invitation.

Invitation secrets are stored only as SHA-256 hashes. The full token is returned
once, at creation, and is absent from invitation lists and audit events. The web
link carries the token in its URL fragment; signup removes the fragment from the
address bar, keeps the token in memory and submits it in the request body. Refreshing
a signup page after this removal requires reopening the original invitation link.

## Share your server library

1. Sign in as an administrator. Connect your own provider under **Account → Debrid**
   and scan its existing media into **My library**.
2. Open **Admin → Shared libraries**. Create a named library, for example
   **Movie night**, and choose all media, movies or series.
3. Add the users who may watch it. Newly invited users must first accept their
   invitation and create an account before you can grant them access.
4. Those users open **Shared libraries**, select a library, then choose a title and
   press **Play**. Multi-video imports present explicit file choices.

A named library shares all current **and future** imports from the source
administrator that match its media-type filter. It is not a hand-picked title list.
Only that administrator can change the library or its grants. Creating a library
never publishes another user's private account. Source credentials, provider
references and filesystem paths are absent from viewer responses.

Viewing grants do not grant administration, metadata editing, source deletion,
provider searches or torrent creation. Viewers' existing private libraries remain
private and optional. Guided setup recognizes granted shared media, so a viewer
does not need a personal provider key or a Phosphor indexer to finish setup.

Disable a library to hide it temporarily, remove a user grant to revoke their
access, or delete the named library. These operations preserve original media,
private imports and provider content. A disabled/deactivated/demoted source
administrator cannot supply a shared library. Credentials must remain configured
and imported items must match the current provider account binding.

## Playback and access limits

Playback resolves a fresh provider stream using the source administrator's saved
credentials. Grants, source status and viewer sessions are checked before and after
provider resolution. Credentials are never returned to guests. The browser receives
a temporary media URL and streams the video directly; this feature does not proxy
or transcode media. Previously issued provider URLs may remain usable until the
provider expires them, and revocation cannot stop an already buffered video.

Named-library grants apply to `/api/shared-libraries/*`. The original curated
StreamRD catalog remains a server-wide member feature governed by its existing
browse settings. Phosphor search and queues retain their existing account rules.
These legacy features are not covered by the new named-library grants. Do not use
named-library filters as parental controls or a restriction on the legacy catalog.

Full Plex Home parity remains future work: managed child accounts, PIN-protected
profile switching, enforced age/label restrictions, device/session inventories,
stream concurrency limits and per-profile shared-library progress are not implemented.
Plex/Jellyfin mounted exports continue to use their own server permissions.

## API outline

All authenticated responses below use `Cache-Control: private, no-store`.

| Endpoint | Purpose |
|---|---|
| `GET /api/auth/registration` | Public mode and bootstrap availability |
| `POST /api/auth/invitation` | Inspect an invitation token supplied in the body |
| `POST /api/auth/signup` | Optional `inviteToken` alongside email, password and display name |
| `GET`, `PUT /api/admin/access` | Administrator registration policy `{mode}` |
| `GET`, `POST /api/admin/invitations` | List the latest 100 invitations or create `{email, expiresInDays?}` |
| `POST /api/admin/invitations/:id/revoke` | Revoke an unused invitation |
| `POST /api/admin/users/:id/revoke-sessions` | Sign another user out of all current sessions |
| `GET`, `POST /api/admin/shared-libraries` | List own published libraries or create `{name, mediaType?}` |
| `PATCH`, `DELETE /api/admin/shared-libraries/:id` | Update name/type/enabled or remove the named view |
| `POST /api/admin/shared-libraries/:id/users` | Grant an existing `{userId}` access |
| `DELETE /api/admin/shared-libraries/:id/users/:userId` | Revoke access |
| `GET /api/shared-libraries` | List only accessible, enabled libraries |
| `GET /api/shared-libraries/:id/items` | Scoped, paginated items; `q`, `type`, `limit` and opaque `cursor` |
| `GET /api/shared-libraries/:id/items/:itemId` | Read an accessible title's details |
| `POST /api/shared-libraries/:id/items/:itemId/play` | Resolve playback or send a returned `fileToken` choice |

Each source administrator can create at most 100 named libraries. Viewer lists are
bounded to 100; item pages default to 30 and allow at most 100. Cursor scope binds
the viewer, library, library revision and search filters. Unavailable libraries or
items return 404 rather than disclosing another user's collection.
