# Server Sharing production screenshots — v0.6.0

All 50 captures come from actual StreamRD and Phosphor production Docker images.
The final run passed 26 browser journeys with no page errors. Each product has
25 screenshots across desktop and 390px mobile viewports. See validation.json for
exact journeys and files; infra/run-browser-qa.sh recreates the disposable setup.

These are rendered application screens, with real local APIs, SQLite storage,
workers, authentication and grants. All identities and accounts are fictional
fixtures. Test-only provider transport fixtures return synthetic TMDB/OMDb IDs,
plots, cast and ratings, plus two existing Real-Debrid torrent references. No real
provider credentials, accounts or copyrighted poster downloads were used. Artwork
fallbacks are original CSS; the TMDB attribution SVG is the approved provider logo.

The fixture names Big Buck Bunny and Sintel identify deterministic test records;
these screenshots do not demonstrate those films being streamed. A separate,
original one-second silent blue H.264 clip verifies browser playback. Mounted file
fixtures contain dummy bytes for filesystem/export tests and are not playable.

The real UI creates a one-use email-bound invitation, clears its token from the
address bar, accepts it, publishes a named collection and grants the new viewer
access. That viewer has no provider key. The runner verifies private isolation,
file choice, synthetic-video playback, grant removal and global session revocation.
Invitation links are hidden by reloading the admin page before its screenshot.

Final images include the signup hash-navigation fix and administrator mutation
protection. All app package versions are 0.6.0; the runner checks the backend
version. No native clients, live-provider quotas or Plex Home parental restrictions
are validated. Temporary provider URLs are direct streams, not a media proxy.
