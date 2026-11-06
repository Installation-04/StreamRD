# Phosphor guide

Phosphor searches your own Torznab indexers instead of browsing an administrator's
catalog. It supports Real-Debrid, AllDebrid, Premiumize, and Torbox. Connect your
own provider account under Debrid and add indexers under Admin → Indexers.

## Search

Paste the Torznab URL and key supplied by Jackett/Prowlarr; the backend, rather
than your browser, must be able to reach that endpoint. Use its connectivity test.
Search accepts minimum seeders, maximum size, and sort by seeders/size/date.
Save a search to re-run its query and filters later (up to 20 per account).

The backend runs up to four regular indexer searches concurrently per process,
with a bounded waiting queue. Identical work shares a request/cache entry keyed
by query and configuration. Updating indexer settings invalidates local results.
If an indexer fails, successful results remain available alongside its error.

## Queue and play

Add a magnet result to your debrid queue. Open Queue to follow its state and play
when a stream is ready. Active-job refreshes share work, have bounded concurrency,
and retain jobs after transient failures. The web refresh loop rotates small
batches, backs off to sixty seconds, and pauses while the tab is hidden.

Manual refresh/remove actions are serialized to avoid overlapping queue edits.
Deleting a job cannot be undone by a delayed refresh result. Finished jobs with
stream URLs offer Play; compatible codecs are still required by the browser.

## Administration and appearance

Admin pages manage users, indexers, providers, server settings, logs, and private
configuration export/import. The web interface offers green, amber, and white
phosphor themes. TV and desktop wrappers are separate repository projects; this
release does not ship new native installers.

See [Screenshots](https://github.com/Installation-04/StreamRD/wiki/Screenshots),
[indexer setup](https://github.com/Installation-04/StreamRD/blob/main/phosphor/docs/indexers.md),
and [traffic validation](https://github.com/Installation-04/StreamRD/blob/main/phosphor/docs/traffic-validation.md).
