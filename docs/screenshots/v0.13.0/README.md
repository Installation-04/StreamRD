# v0.13.0 screenshots

Captured from production StreamRD and Phosphor images built from `main` at the v0.13.0 merge commit, with the browser
journeys (`infra/run-browser-qa.sh both`) against fresh disposable SQLite volumes: 41 browser journeys, 81 screenshots
(desktop and 390px mobile), no page errors; see validation.json. They show the black and orange StreamRD, the Admin → Libraries
page, the single **Library** and **Imports** navigation, and the home page with its featured carousel and Plex-style rows.

What is real and what is not: the library fixtures are three fictional titles, so captures show layout, not behaviour on a large
library. The home page's **Trending now**, **Popular movies** and **Popular TV shows** rows, and the carousel's backdrops, are
live data from the public Cinemeta catalogues at capture time; trailers are not played in the screenshots. Phosphor keeps its own
green, amber and white looks. Provider and request services are test fixtures; no real debrid account or indexer was contacted.

The README images in `docs/assets/readme` are crops of these files, built with `node scripts/readme-assets.cjs <folder>`.
