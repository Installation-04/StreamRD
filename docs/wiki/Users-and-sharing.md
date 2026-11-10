# Users and libraries

The server has **libraries** (for example *Movies* and *TV Shows*), the administrator
decides who can see each one, and everyone signs in with a local account on this server. Nobody needs their
own debrid key; playback uses the administrator's connected account.

## Set up libraries and people

1. **Imports.** The administrator imports their debrid account's media (navigation → *Imports*, or the setup page).
2. **Libraries.** In **Admin → Libraries**, create the libraries you want. Pick a content type (movies, TV shows, or both)
   and either tick **Visible to everyone** or add chosen people under *Who can watch*. A library always shows the
   imported media of its type, including titles imported later. **Paused** hides it without losing its access list.
3. **People.** In **Admin → Users**, choose invitation-only registration and create email-bound invitation links. In the same form,
   tick the **libraries** the person should get and optionally set a **viewing limit** (a kids account starts safe). Save the
   **address for invitation links** (your local network address, Tailscale name or domain) so links work for the person you send them to.
   Send the link by any means; it works wherever the server can be reached.
4. **Watching.** Everyone opens **Library** in the navigation. They see only the libraries they may see, with their
   own *Continue watching* and resume positions.

The **home page** shows Continue watching, New in your libraries, Popular on this server, and public Trending and
Popular lists (see the [full guide](https://github.com/Installation-04/StreamRD/blob/main/docs/server-sharing.md)).

## A kids account (viewing limits)

In **Admin → Users**, choose a **Viewing limit** for a member: Kids, Pre-teens, Teens or Mature. They then see only titles in their
libraries rated at or below that level, and **titles with no rating stay hidden**. Ratings come from metadata (TMDB or OMDb) or you can set
one on a title's page (**Age rating**, administrators only). Limited accounts cannot search, request or import, and their home page
shows only their libraries. See the [full guide](https://github.com/Installation-04/StreamRD/blob/main/docs/server-sharing.md).

## What is and is not included

This is a server-managed sharing model, not full Plex Home parity. PIN-protected managed users, device inventories and concurrency limits are
planned; see the [roadmap](https://github.com/Installation-04/StreamRD/blob/main/docs/roadmap.md). Removing a person's access blocks
new playback requests at once; direct provider links already issued may work until the provider expires them.
