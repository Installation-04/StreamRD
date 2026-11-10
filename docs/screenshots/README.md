> The current screenshots, in the black and orange theme with libraries and the new home page, are in [v0.13.0/](v0.13.0/README.md).
> The files below are older captures kept for history.

# Application screenshots — v0.2.0

Captured from the production web images in Chromium at 1440 × 1000, using fresh,
disposable local databases and a demo account. Full pages may be taller. These
are actual application screens with no UI overlays or generated artwork.

Catalog titles name Blender Foundation open movies. Poster fields are intentionally
empty, showing the application's text fallback. Continue Watching uses seeded demo
progress, not a claim of live provider playback. Phosphor's search results come
from a local Torznab protocol fixture with synthetic sizes, seed counts, and
nonfunctional example magnet IDs. No real indexers or debrid accounts were queried.
The empty download queue shows the real first-use state.

| Screen | Image |
|---|---|
| StreamRD library, My List, and Continue Watching | [streamrd-library.png](streamrd-library.png) |
| StreamRD title details | [streamrd-title.png](streamrd-title.png) |
| StreamRD profiles | [streamrd-profiles.png](streamrd-profiles.png) |
| StreamRD server administration | [streamrd-admin.png](streamrd-admin.png) |
| StreamRD sign in | [streamrd-login.png](streamrd-login.png) |
| Phosphor search and saved searches | [phosphor-search.png](phosphor-search.png) |
| Phosphor empty download queue | [phosphor-downloads.png](phosphor-downloads.png) |
| Phosphor indexer administration | [phosphor-indexers.png](phosphor-indexers.png) |
| Phosphor sign in | [phosphor-login.png](phosphor-login.png) |

All eleven pages completed without browser page errors during capture. This is a
visual documentation check; the automated backend/container checks provide the
separate regression evidence described in the release notes.

The two library-export screens show a local dummy mounted file, exported through
the real admin form and checked using the repair action. They are documentation
fixtures; actual scanner reads were validated separately with a real MP4.

- [StreamRD Plex/Jellyfin exports](streamrd-library-export.png)
- [Phosphor Plex/Jellyfin exports](phosphor-library-export.png)
