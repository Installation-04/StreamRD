# Automatic metadata and matching

Version **v0.5.0** adds TMDB and OMDb metadata to StreamRD's catalog and both apps'
mounted and private imported libraries. Open **Admin → Metadata** to save a TMDB
API key/read token or OMDb key, test it explicitly, and optionally enable automatic
matching. A saved key is configuration, not proof of a successful connection.

TMDB provides artwork, movie/TV details and external IMDb IDs. OMDb provides
IMDb-linked details and ratings. Ratings keep their source labels. Metadata and
artwork remain subject to their providers' terms; the app includes TMDB attribution.

Automatic jobs enrich confident matches. Uncertain results stay in review. Search
by title or IMDb ID, preview a result, then confirm. Field locks and provider-field
ownership protect manual edits. Existing catalog/export scans use bounded batches;
refreshes and retries run on the server. Keys are never returned by settings APIs.

New private account imports can receive metadata automatically. Their owners can
fix a match from the title page, and their names/activity do not appear in shared
administrator matching activity. Metadata never changes provider references,
playback sources, mounted originals or exported symlink paths.

Read the complete [metadata setup and recovery guide](https://github.com/Installation-04/StreamRD/blob/v0.5.0/docs/metadata-automation.md)
for configuration, schedules, queue states, preserved fields, provider limits and
licensing. See [My library and account scans](https://github.com/Installation-04/StreamRD/wiki/Account-library)
for automatic onboarding import. Live keys are required for real provider use;
release validation uses clearly identified protocol fixtures.
