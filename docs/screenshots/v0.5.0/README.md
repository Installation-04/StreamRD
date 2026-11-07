# Automatic Libraries screenshots — v0.5.0

Thirty-six captures show the final production web/API images in Chromium at
1440 × 1050 and 390 × 844. Full pages may be taller. All 20 browser journeys passed
without page errors; see [validation.json](validation.json) and
[qa/README.md](../../../qa/README.md).

The APIs, authentication, SQLite migrations, background import/matching workers,
file-choice flow and browser UI are real application code. Provider transport is a
test-only Node preload copied into new disposable QA volumes. TMDB/OMDb and debrid
responses use synthetic IDs, plots, ratings and performers. No real API keys,
external indexers, live account scans or copyrighted posters were used.

Blender open-film titles identify demo entries. Original CSS geometric poster
fallbacks remain visible. Metadata descriptions explicitly identify local protocol
fixtures, and the new cast entries are named Demo performer. The approved TMDB
logo is an attribution asset, not evidence of a live provider connection.

The mounted videos contain non-playable dummy bytes. Personal playback separately
uses an original one-second silent blue rectangle, fulfilled for example.invalid
by Playwright. Its real HTML video playback proves the app's selection/player path,
not playback from a debrid provider. See [fixture provenance](../../../qa/fixtures/README.md).

New journeys save/test provider settings, scan with metadata automation disabled,
apply field locks, confirm OMDb matches, enable automation, connect a debrid account,
walk its existing-torrent pages, update pending cards without reloading, verify
private access, choose a video, and rescan without duplicates. Existing setup,
catalog, mounted export, theme, queue and role checks remain in the run.

Only these passing captures and report were copied into the release directory.
Earlier failed-run and mocked development screenshots remain outside the repository.
