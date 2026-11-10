# Roadmap

Where StreamRD and Phosphor go from here. The headline item is replacing today's patchwork of libraries
with **one library, managed by the administrator, the way Plex does it**. Everything else is smaller and
independent of it. Sizes are rough (S = days, M = a week or two, L = several weeks of focused work).

## Status

Shipped so far, as the visible half of this plan: **v0.11.0** one Library page and libraries visible to everyone or chosen people (Phase A,
plus an *Everyone* switch); **v0.12.0 and v0.13.0** a home page with a featured carousel;
**v0.14.0** viewing limits for a kids account (part of Phase C); **v0.15.0** invitations that carry library access (part of Phase C);
**v0.16.0** a full-page player; **v0.17.0** one card per title with versions; **v0.18.0** the curated catalogue is retired and only the administrator imports. **v0.19.0** background link health checks with automatic switching and replacement requests; **My List** for library titles. The notes on the data model, with the decisions that
remain, are in [library-model.md](library-model.md). Still ahead are the parts that change the data model underneath (Phases B, D and E below): a unified
library model with one row per movie or episode, merging duplicates, and retiring the old catalogue, personal-library and request
surfaces. These are deliberately left until they can be tested against a copy of real data.

## What exists today, and why it feels confusing

| Concept today | What it actually is | Where users see it |
|---|---|---|
| **Catalog** | Titles the administrator adds by hand with link/magnet sources (`Title`) | *Discover* (home) |
| **My library** | Items imported from a user's *own* debrid account (`AccountMedia`, owned by that user) | *My library* |
| **Shared libraries** | The administrator's imported items published to chosen users (`SharedLibrary` + `SharedLibraryGrant`) | *Shared libraries* |
| **Library export** | Symlinks of mounted media for Plex/Jellyfin (`admin/library`) | Admin only |
| **Requests** | Wanted titles that end up in one of the above (`MediaRequest`) | *Requests* |

Four places to look for media, three different ways something becomes visible, and a user cannot tell
where a title lives. Plex has one idea instead: **a server has libraries (Movies, TV Shows), the owner decides
which users can see which library, and everyone gets their own watch state.**

## The goal: one library, access managed by the administrator

- A single **Library** page (movies and shows, search, filters, continue watching). It shows everything the signed-in user
  is allowed to see; nobody has to know whether an item came from the catalog, a debrid account, a request or a mounted folder.
- The administrator has one **Library access** screen: pick a user (or "everyone"), tick the libraries
  they can see, optionally limit by type or label. Changes apply on the next request.
- Items still have a source (a debrid account, a link, a mounted file); the source decides *how it plays*, never *where it appears*.
- A user who connects their own debrid account can still keep **personal** items, but they appear in the same Library under a
  *Mine* filter, not in a separate section.

### Decisions I need from you before building the data model

1. **Can regular users still connect their own debrid account**, or is every item on the server's library supplied by the administrator?
   (The administrator supplies the library; keeping personal accounts is an optional extra.)
2. **How fine-grained should access be?** Whole library only, library plus movie/show type, or per title? (Plex: per library with labels.)
3. **Should requests go straight into the library** when approved, with no separate "Requests" destination?
4. **Phosphor:** does it join the same model (recommended, now that most code is shared) or stay search-and-queue only?

## Phases

### Phase A: one Library in the interface (M, no data migration)
Ships first because it removes the confusion without touching the database.
- Nav becomes **Discover · Library · Requests · Account** (plus Admin). *Shared libraries* and *My library* become filters on one Library page.
- Admin gets a **Library access** page that wraps today's shared-library grants (who sees which library) in one dialog.
- Existing URLs keep working (redirects) for one release.
- Risk: low. Everything underneath is unchanged. Release: v0.11.0.

### Phase B: a unified library model (L, needs a verified migration)
- New `Library` (named, typed), `LibraryItem` (one row per movie/episode with its source) and `LibraryAccess` (library × user or everyone).
- A migration backfills: catalog titles and administrator imports into the server library; other users' imports into personal items;
  today's shared libraries and grants into libraries and access rows. The database is snapshotted and verified first (the existing upgrade runner does this).
- The old tables keep being written for one release (dual-write) so a rollback is possible; reads move to the new model.
- Metadata matching, cleanup of non-movie items and watch progress apply to every item the same way.
- Risk: the largest in this roadmap. Mitigation: ship Phase A first, migrate behind a flag, test with a copy of your real database.

### Phase C: Plex-grade access and viewing (M-L)
- Per-user **watch state** across the whole library, one Continue watching row, watched/unwatched marks.
- Access by **labels** (for example "Kids", "4K") and per-user restrictions enforced on every browse and play route.
- **Managed users** (profiles under one account) with an optional PIN.
- Invitations that carry library access ("invite Anna to Movies and TV").
- This is the "Plex Home parity" milestone already called out in [optimization-plan.md](optimization-plan.md).

### Phase D: one way in (M)
- Requests, debrid-account scans, mounted-file exports and hand-added titles all create library items in a chosen library.
- Duplicates (the same film from two sources) merge into one item with several sources and quality choices.
- Zilean and Zurg results feed the same pipeline.

### Phase E: retire the old surfaces (S)
- Remove the old routes, tables and screens after at least one release of dual-write. This is where the duplicated code finally shrinks.

## Independent work, any time

| Item | Size | Notes |
|---|---|---|
| Check Zilean and Zurg against a real Real-Debrid account | S | Only configuration and start-up were tested; see [zilean-zurg.md](zilean-zurg.md) |
| Content-Security-Policy for both web apps | M | Security headers exist; a CSP needs a pass over inline styles and scripts |
| Share more code between the products (settings, setup, types) | M | The shared-file workflow in [CONTRIBUTING.md](../CONTRIBUTING.md) already makes this safe |
| Release flow | done | **Auto release** tags and publishes when a version bump is merged and checks are green ([RELEASING.md](../RELEASING.md)) |
| Restore-from-backup rehearsal in CI | S | Backups are verified; a full restore test in the container job would catch key mismatches |
| `arm64` image | M | Add together with a test release, since the publish workflow only runs on a real tag |
| Accessibility audit of the main flows | M | Today's tests check workflows, not WCAG conformance |

## Order I would do it in

1. Answer the four decisions above.
2. **Phase A** (visible improvement, low risk), released as v0.11.0.
3. **Phase B** on a copy of your real data, behind a flag; release when it round-trips cleanly.
4. **Phase C** features one at a time (watch state first), then **D**, then **E**.
