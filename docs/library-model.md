# The library model: where it stands and what is left

This page records how StreamRD's libraries are built, what has changed on the way to "one library managed by the administrator, like
Plex", and the remaining data-model work with the decisions it needs. The user-facing side is in [the roadmap](roadmap.md).

## How the pieces fit today

| Piece | Stored as | Notes |
|---|---|---|
| A **library item** | `AccountMedia`, one row per imported torrent or file group | Owned by the administrator whose debrid account it came from. Carries the cleaned name, year, type, phase, age rating and (since v0.17.0) a title group. |
| A **library** | `SharedLibrary` (name, content type, enabled, *everyone*) | A view of one administrator's items of a type. |
| **Access** | `everyone` flag, `SharedLibraryGrant` rows, `User.maxAge` | Who sees which library, and the viewing limit (v0.11.0, v0.14.0, v0.15.0). |
| **Watch state** | `SharedLibraryProgress` per viewer, item and file | Continue watching, resume. |
| **Metadata** | `MetadataRecord` keyed by the item | Poster, details, rating; the title's provider id once matched. |

Naming is the only thing that still says "shared": the tables and routes keep their original names so that nothing in an existing
installation has to be renamed, moved or rewritten.

## v0.17.0: versions of one title (additive, reversible)

A debrid account often holds the same film twice (1080p and 4K) or a show as several season packs. Items of one title now share a
`groupKey`: the provider id once matched (`imdb:tt…`, `tmdb:…`), otherwise the cleaned name, year and type. Exactly one item per group
is the *primary*, which lists and counts show; the title page offers the rest as **versions**, labelled from the original release name
(for example `4K · BluRay · HEVC · HDR`). Nothing is merged, moved or deleted: three nullable or defaulted columns and an index
(`groupKey`, `isPrimary`, `releaseName`). Setting every `isPrimary` back to 1 restores the old lists exactly. Existing rows are named
when the server starts. Grouping never crosses accounts.

## Decisions (recorded)

- **The curated catalogue is retired.** The libraries are the product; the hand-added link and magnet shelf goes away, and so do the surfaces
  that only existed for it (its search page, title and watch pages, favourites, My List and viewing profiles, and *Admin → Catalog*).
  Retiring is not deleting: the tables stay in the database (nothing is dropped), the API answers "gone" instead of removing rows, and
  *Admin → System* shows what is kept, so an upgrade is reversible and a later clean-up is an explicit, backed-up administrator action.
- **Links need health checks.** Nothing is offered as playable just because a provider once listed it. A background check confirms each
  library version still resolves and answers; a version that stops doing so is marked *Link needs attention*, is never chosen as the card
  shown for its title while a healthy version exists, and is reported to the administrator. This ships as its own release after the retirement.
- **Only the administrator imports.** Members do not import from their own accounts; they **request** content, and the administrator's
  libraries are what everyone sees. Members' earlier personal imports stay stored and hidden (no deletion), and manual import endpoints
  answer "forbidden" for non-administrators.

Release order: v0.17.0 (versions, released) → v0.18.0 (retire the catalogue and member imports, built) → v0.19.0 (link health checks).

## What is left, and what each step needs from you

1. **Merging the old surfaces into libraries** (the roadmap's phases B, D and E). Two surfaces still sit beside the libraries:
   - the **curated catalogue** (`Title`, with hand-added link and magnet sources and its own profiles, favourites and My List);
   - **personal imports** that members made from their own debrid accounts before v0.11.0 (hidden from the menu since then, still stored).
2. **Decisions only you can make.** For the catalogue: keep it as a separate shelf, convert its titles into library items, or retire it.
   For personal imports: keep them hidden, give their owners a way to export or move them, or remove them after a backup.
   Anything that removes or rewrites data would ship only with a written upgrade note, a dry-run report in *Admin → System* of exactly what
   would change, the automatic backup, and a test that upgrades a populated database from every earlier release.
3. **What we deliberately did not do.** Renaming `SharedLibrary` or `AccountMedia` to `Library` or `LibraryItem`, or splitting items into
   per-episode rows, would touch every query and every existing installation's data for no visible benefit. The versions step above
   gives the same result users asked for (one card per title) without that risk. Per-episode rows are worth doing only together with a
   feature that needs them (for example per-episode watched marks across a pack).

## Rules every step follows

Migrations only add; nothing is dropped, renamed or deleted without a reviewed `-- destructive-ok:` reason; new settings default to the old
behaviour; backfills run at start-up and are idempotent; old and new behaviour are tested against a populated database at every earlier
checkpoint. See [RELEASING.md](../RELEASING.md#updates-must-never-cost-anyone-data).
