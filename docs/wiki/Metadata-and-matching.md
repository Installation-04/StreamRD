# Automatic metadata and matching

**Admin → Metadata** saves a TMDB API key/read token or an OMDb key, tests it explicitly, and
optionally enables automatic matching. A saved key is configuration, not proof of a working connection.
TMDB provides artwork, movie/TV details and IMDb IDs; OMDb provides IMDb-linked details and ratings.
Ratings keep their source labels, and the app includes TMDB attribution.

## How a file name becomes a match (v0.8.1)

Release names put the title first, then the year, edition and quality tags, such as
`Crank 2006 Director's Cut 1080p BluRay DTS x264-CtrlHD.mkv`. The matcher searches for the title
only (`Crank`, 2006) and accepts a result when it is unambiguous: one exact title and year, a single
result one year off, or a single exact title when the name has no year. Remakes with the same name stay in
**review**, a name that may end in a number (*Wonder Woman 1984*) is also tried uncut, and unreadable
names such as a bare hash cannot be matched and need a manual choice.

Earlier versions searched the whole cleaned name, so most release-style names fell into review. The
server now works through several titles per tick and scans 250 titles every 20 seconds, so a library of
thousands takes minutes.

## Your own library

**My library** shows how many of your titles are matched, waiting, in review, unmatched or failed, and
whether a provider is configured and automatic matching is on. **Retry matching** re-queues your own review,
unmatched, failed and never-started titles (for example after adding a key). Open a title to preview
and confirm a match yourself. Private libraries are never included in administrator totals or activity.

Field locks and provider-field ownership protect manual edits. Metadata never changes provider
references, playback sources, mounted originals or exported symlink paths. Keys are never returned by
settings APIs. Read the complete
[metadata guide](https://github.com/Installation-04/StreamRD/blob/v0.8.1/docs/metadata-automation.md).
Release validation uses clearly identified protocol fixtures, not live provider data.
