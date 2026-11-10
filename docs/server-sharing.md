# Users, invitations and server-shared libraries

StreamRD and Phosphor support server-managed sharing: an administrator connects
their debrid account, imports its existing media, publishes a named library and
grants selected users access. Viewers sign in to this server and can watch without
supplying debrid credentials. This is a local server account system; Plex accounts
and Plex Home identities are not used.

## Libraries, Plex-style (v0.11.0)

Think of the server as having **libraries**, like Plex: for example *Movies* and *TV Shows*. In **Admin → Libraries** the administrator
creates as many as they like, picks a content type for each (movies, TV shows, or both) and chooses who can see it:

- **Visible to everyone**: every active account on the server sees it, including people who sign up later. No per-person step.
- **Chosen people**: only the accounts you add under *Who can watch*.
- **Paused**: hidden from everyone but the administrator without losing the access list.

People find everything under one **Library** item in the navigation; they no longer have separate *Shared libraries* and *My library*
pages. The administrator's debrid import screen is still available to administrators, now named **Imports**. A library always
shows the administrator's imported media of its type, including titles imported later. The API fields are `everyone` on
`/api/admin/shared-libraries` (create and update) and the library list a viewer receives. Existing libraries keep their exact
access: the new setting starts off.

## The home page (StreamRD)

The home page has Plex-style rows, from top to bottom: **Continue watching**, **New in your libraries**, **Popular on this server**,
**Trending now**, **Popular movies** and **Popular TV shows**, followed by the older catalogue rows.

- *New in your libraries* and *Popular on this server* come from the libraries the signed-in person can see (administrators also see
  what they imported themselves). *Popular* ranks titles by how many viewers resumed or finished them in the last 30 days; only the
  ranking is shown, never who watched.
- *Trending* and *Popular* come from the public Cinemeta catalogues (no account or key). The server fetches them, caches them for six
  hours and keeps the last good copy for a week if the service is down, so browsers never contact it and nothing about a viewer
  is sent. Opening one of these titles leads to its page, where it can be requested.
- Operators can turn the outside lists off with `HOME_EXTERNAL_LISTS=false`; the library rows keep working.
- The banner at the top is a **carousel** of featured titles (your own matched titles first, then what is trending). Trailers are optional
  per viewer: nothing is loaded from YouTube until a viewer presses *Watch trailer* or ticks *Autoplay trailers*, and `HOME_TRAILERS=false` removes the option.

## Invitations that carry access

When you invite someone (Admin → Users → Invite someone) you choose the **libraries** they will get and, optionally, a **viewing limit** to start
them with; both are applied when they create their account, so a kids account is set up in one step. **Address for invitation links** is how
invited people reach your server: a local network address, a Tailscale name or a domain; links are built from it. The invited person
sees which libraries they will get before signing up. API: `POST /api/admin/invitations` takes `libraryIds` (libraries you manage, at most 20) and
`maxAge` (7, 8, 14, 17 or null); `GET/PUT /api/admin/invite-address` reads and sets the link address (`{"url": "http://host:port"}`).

## Viewing limits (a kids account)

In **Admin → Users**, each member has a **Viewing limit**: Kids (G, TV-Y, TV-G, TV-Y7), Pre-teens (up to PG, TV-PG), Teens (up to PG-13, TV-14),
Mature (up to R, TV-MA), or no limit. A limited account only sees titles in its libraries rated at or below its level. **Unrated titles
are never shown to a limited account.** Ratings come from metadata (TMDB or OMDb) or from an administrator: open a title as an
administrator and use **Age rating**. The limit is read on every request, so changes apply at once. Limited accounts cannot use Find media,
Requests, Imports, Setup or search, and their home page shows only their libraries. Administrators are never limited.
API: `PATCH /api/admin/users/:id` accepts `maxAge` (`7`, `8`, `14`, `17` or `null`); `PUT /api/admin/shared-libraries/items/:itemId/rating`
sets (`{"rating":"PG"}`) or clears (`{"rating":null}`) a title's rating.

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
