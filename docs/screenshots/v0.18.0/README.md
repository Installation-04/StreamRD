# v0.18.0 screenshots

Captured from production StreamRD and Phosphor images built from `main` at the v0.18.0 release (browser journeys run on the pull request that added the new steps), with the browser
journeys (`infra/run-browser-qa.sh both`) against fresh disposable SQLite volumes: 43 browser journeys, 91 screenshots
(desktop and 390px mobile), no page errors; see validation.json. They show the black and orange StreamRD, the Admin → Libraries
page, the single **Library** and **Imports** navigation, the home page with its featured carousel and library rows, the full-page player, invitations that carry library access and a viewing limit, per-member viewing limits, title age ratings, and a limited (kids) account's view.

What is real and what is not: the library fixtures are three fictional titles, so captures show layout, not behaviour on a large
library. The home page's **Trending now**, **Popular movies** and **Popular TV shows** rows, and the carousel's backdrops, are
live data from the public Cinemeta catalogues at capture time; trailers are not played in the screenshots. Phosphor keeps its own
green, amber and white looks. Provider and request services are test fixtures; no real debrid account or indexer was contacted.

The README images in `docs/assets/readme` are crops of these files, built with `node scripts/readme-assets.cjs <folder>`.
