# Automatic metadata and matching

StreamRD and Phosphor can enrich web-library entries with movie or TV details,
artwork, cast, runtime, ratings and external IDs. The v0.5.0 update covers private imported account libraries in both apps,
mounted-library exports in both apps, and StreamRD’s curated catalog. Each app keeps its own settings and
SQLite records.

Metadata is optional. Your debrid sources, stream URLs and mounted videos remain
usable without a metadata provider. The [account scanner](account-library.md) imports existing debrid references;
metadata matching then supplies title information. Mounted videos still use the
reviewed export workflow.

## Choose a provider

| Provider | Connection | Available details |
|---|---|---|
| TMDB | Your TMDB API key or API Read Access Token | Movie/TV search, posters, backdrops, synopsis, genres, cast, runtime, certifications, TMDB rating and external IMDb IDs when available |
| OMDb | Your OMDb API key | Movie/series search, IMDb IDs and ratings, plot, genres, cast, runtime, certification and supported poster URLs when available |

IMDb IDs such as `tt0133093` can be searched through either provider. OMDb is an
independent service supplying IMDb-linked information; this feature does not log
in to an IMDb account or scrape IMDb pages. Ratings retain their source label:
TMDB ratings and IMDb ratings are not interchangeable. Missing provider fields
remain empty; the UI keeps its normal artwork fallback.

Get credentials from [TMDB API settings](https://www.themoviedb.org/settings/api)
or [OMDb API keys](https://www.omdbapi.com/apikey.aspx). A TMDB Read Access Token
can be pasted with or without its `Bearer` prefix. The selected provider is used
for new searches; an existing confirmed match refreshes its own provider/ID.
Changing the default provider does not silently replace previously chosen matches.

## First setup

1. Upgrade the backend database using the [versioned upgrade guide](database-upgrades.md).
2. Open **Admin → Metadata**, choose a provider and enter its key/token. Choose a
   language-region code such as `en-US`; TMDB uses it for localized details.
   OMDb returns the language supplied by its API and does not translate results.
3. Save, then use the provider's **Test connection** action. A saved key is only
   configuration; a successful test establishes that that request worked.
4. Keep automation off for manual matching, or explicitly enable it. The default
   is **off**. The refresh interval defaults to 30 days and accepts 1–90 days.
5. Scan existing entries or use a title's **Find match** / **Fix match** action.

Keys entered by an administrator are sent to the app backend for storage and
provider requests. Stored keys are never returned by the settings/read APIs,
inserted into artwork URLs, or exposed in upstream error bodies. Leave a password
field blank to keep its saved value. Removing a key requires its explicit removal
checkbox and Save; disable automation first if removing the selected provider's
only key. Metadata keys are stored in SQLite, currently without at-rest encryption.
Protect the database and its backups; do not put keys in source control, screenshots
or public project trackers.

Backend access is required to `api.themoviedb.org` and/or `www.omdbapi.com`.
Artwork loads in the browser from supported provider image hosts, including
`image.tmdb.org` and supported Amazon/IMDb poster hosts. Provider credentials are
used only by the backend. Enabling lookup sends the media title, type, year or
external ID to the chosen provider; playback-source URLs and filesystem mount
paths are not metadata lookup parameters.

## Automatic and manual workflows

With automation enabled, newly imported private account entries, new catalog
titles and successful mounted-file exports are queued locally. A background discovery pass visits up to 100 existing targets
per target type approximately once per minute, advancing a saved cursor. For the
mounted library, targets are entries already recorded by the export workflow,
not every video in the source mount. Matched entries become eligible for a
scheduled refresh after the configured interval.

Search normalizes common filename separators, episode/release tokens and a
trailing year when that year is known. A confident automatic match must have the
same movie/series type and an exact normalized title; a known year must agree.
With no year, the provider must return a single possible result as well as an
exact title match. A direct IMDb-ID lookup can use its single matching result.
Multiple candidates, remakes/reboots or uncertain names go to **Needs review**;
the worker never chooses an arbitrary first result. Supplying a year helps.

Manual searches work with automation off. In the picker, search a title or IMDb
ID, open a candidate, inspect its details, and confirm **Use this match**. A draft
lookup fills editable fields for review. Saving a StreamRD catalog draft with a
confirmed selection queues that specific provider/ID even when automation is off;
its cast, ratings and external links arrive through the background job. The save
request does not wait for a provider request. Existing-entry matching applies the
confirmed provider details immediately, subject to field locks and concurrency
checks.

**Scan catalog** / **Scan mounted library** also work with automation off when the
selected provider is configured. Each API page queues at most 100 targets; the UI
advances the cursor and reports queued progress. Stopping the scan stops further
pages, while already queued manual jobs continue on the server. A scan does not
force every current match to refresh. Use an entry's **Refresh metadata** action
to queue an explicit refresh of its pinned match or retry an unsuccessful lookup.

## Keep editorial control

Automatic catalog enrichment fills missing fields first. Later refreshes update
only fields previously written by the provider and still equal to those applied
values. Existing nonempty descriptions/artwork and administrator edits are not
implicitly assigned to the provider merely because their values happen to match.
Internal `_applied` bookkeeping records ownership and is omitted from public DTOs.

The lockable fields are name, year, description, genres, poster and backdrop.
Catalog edits protect their changed fields, including deliberate clears, before
any provider work runs. Name/type/year changes invalidate stale provider identity
and request review. **Field locks** can also be changed explicitly. Unlock a field
before applying a confirmed replacement if you want the provider to own that field.
A manual match replaces eligible unlocked catalog fields; playback sources and
movie/series type remain under the catalog editor's control.

Mounted-library metadata is stored separately from scanner paths. Both draft
lookup and matching let administrators review names; enrichment and refresh never
rename a source file, existing export, manifest mapping or symlink. Plex/Jellyfin
still scan the same reviewed movie/episode layouts. The metadata feature does not
push updates through Plex/Jellyfin scanner APIs or produce local NFO files.

## Your private account library

Imported account titles receive metadata only when server automation is enabled
or their owner explicitly chooses a match. Members use **My library → title →
Find metadata / Fix metadata match**. Search and previews are authenticated against
that owned item; another user, including an administrator using the personal API,
cannot open it by guessing the ID. Server provider keys are not returned to members.
Personal matching activity and totals are excluded from the shared admin board.

Manual matches update unlocked display fields and metadata, while stable provider
references remain intact. Metadata refresh does not resolve a signed playback URL.
Deleting the account cascades its private matching records and queued work.

## Queue behavior and recovery

| State | Meaning / next action |
|---|---|
| Queued | Waiting for a worker; automatic jobs pause while automation is off |
| Processing | A worker owns a temporary lease; wait or refresh activity |
| Matched | A confirmed or confident match and provider provenance are stored |
| Needs review | Choose the correct candidate or correct the media identity |
| Unmatched | Try another title/year or explicitly retry after improving it |
| Error | Read the safe error message; correct configuration or retry deliberately |

The worker starts at most one job per two-second tick and skips overlapping ticks.
Provider latency determines throughput. Durable SQLite records survive restart;
90-second leases allow abandoned work to be recovered. Revision checks prevent a
stale result from overwriting newer matches, locks or catalog edits. Provider/key/
language changes are rechecked around remote work, and removed targets are not
recreated by a late response. Keep one backend writer per database/data volume.

Transient unavailable/busy/rate-limit failures receive up to **three attempts in
total**, with backoff. Authentication failures and invalid responses are terminal
for that job. Discovery does not continuously reset failed, unmatched or review
items; an administrator chooses an explicit retry. A provider rate limit also
pauses background work for that provider: five minutes for TMDB, one hour for
OMDb. Rotating the saved key removes the old key's provider-wide block; individual
jobs can still retain their scheduled retry time, so use Refresh for an immediate
new attempt. Observe the provider's plan limits, especially OMDb daily quotas.

Provider requests use fixed HTTPS endpoints, an eight-second request timeout,
response-size limits, bounded concurrency and configuration-keyed caches. Repeated
lookups can share requests; explicit background detail refreshes bypass stale
cached details. These controls reduce duplicate traffic, not provider quotas.

## Attribution, rights and verification

The UI includes an approved TMDB logo and this required notice:

> This product uses the TMDB API but is not endorsed or certified by TMDB.

TMDB's standard developer API terms cover noncommercial use with attribution;
commercial use requires the appropriate agreement. OMDb publishes its content
under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). Review current
[TMDB FAQ/terms](https://developer.themoviedb.org/docs/faq) and
[OMDb terms](https://www.omdbapi.com/) for your deployment. Metadata/artwork remains
subject to its providers' and rights holders' terms. IMDb does not endorse this app.
The repository's application license does not relicense provider artwork.

Implementation checks use mocked provider protocol responses and disposable local
fixtures. No live provider keys were available during this development session;
live authentication, account quotas, provider matching quality and artwork rights
for a particular deployment are not claimed as verified. Test your own saved key
and review matches before relying on them. See the [API contract](api-schema.md#metadata-and-matching)
for integrations and [Project HQ](product/PROJECT-HQ.md) for validation/publication
status.
