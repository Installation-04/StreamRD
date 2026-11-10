# StreamRD guide

StreamRD turns your debrid account into libraries for the people you choose. The administrator connects the debrid account,
imports what is finished into libraries, and decides who sees each library. Everyone else signs in, watches, and **requests**
what is missing. Members do not need debrid keys of their own.

## Browse

The home page shows a featured carousel (trailers are optional and per viewer), then Continue watching, New in your libraries,
Popular on this server, Trending now, Popular movies and Popular TV shows (the last three are public lists). **Library** lists the
libraries you can see; a title shown once may offer several **versions** (for example 1080p and 4K). **Find media** searches TMDB and
lets you request a title; **Requests** follows each request.

## Watch and resume

On a title, **Play from server** opens a full-page player: a fading title bar, resume, a chooser for packs, **Up next** for the
following episode, and keyboard shortcuts (Space, J/L, arrows, M, F, N, Esc). When a pack holds several videos, choose the file;
samples and non-video files are never chosen automatically. Progress is saved per person and per file, older player sessions and
out-of-order saves cannot overwrite the active one, and at least 95% completion removes an entry from Continue watching.

Resolution success does not guarantee browser codec support. StreamRD does not transcode video. Playback runs in your browser or in
any player you hand the stream link to.

## Administration

Admin pages manage people and invitations (libraries and a viewing limit travel with an invitation), libraries, requests, metadata,
provider settings and order, connectivity, logs, and configuration export/import. Export files and database backups contain private
information; store them outside public source control. Deactivating an account revokes its older sessions; password changes revoke
other sessions while retaining the initiating web session.

Only the administrator imports from a debrid account. The curated catalogue (hand-added links, its search, favourites, My List and
viewing profiles) was retired in v0.18.0; nothing was deleted and its endpoints answer "gone".

See [Screenshots](https://github.com/Installation-04/StreamRD/wiki/Screenshots) and the
[API schema](https://github.com/Installation-04/StreamRD/blob/main/docs/api-schema.md).
