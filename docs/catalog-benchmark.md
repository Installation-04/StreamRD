# Catalog benchmark

Run from `server/` after installing dependencies and generating the Prisma client:

```sh
npx tsx scripts/benchmark-catalog.ts 1000
```

The script always creates and removes a temporary database, with synthetic titles,
large descriptions and two genres per title. It exercises the Express app through
Supertest, warms each endpoint once, then records ten requests. Query counts are
Prisma operation counts, including raw SQL, rather than individual SQLite engine
steps. No external providers are used. Counts from different endpoints compare
an initial browse page against the legacy full response, not equal-sized results.

Observed on this cloud instance with Node 24.22.1:

| Initial response | Legacy `/catalog/rows` | New `/catalog/browse` |
|---|---:|---:|
| Response bytes | 7,754,238 | 16,207 |
| Cards (including repeats across rows) | 3,020 | 160 |
| Prisma operations/request | 2 | 10 |
| Median request time | 235.71 ms | 16.68 ms |
| Sample p95 (10 samples) | 342.31 ms | 24.21 ms |

The new response is about 99.8% smaller in this fixture. Additional titles and
genres remain available through pagination. These are local synthetic measurements,
not production guarantees, browser rendering measurements, or concurrent-user load
tests. Favorites/history are outside this measurement. Genre discovery still scans
JSON genre data; normalizing genres is a potential later improvement if query plans
and production measurements justify the migration. Tests verify composite indexes
serve recent/type ordering without relying on response timing thresholds.

A headless Chromium smoke check against a separate 65-title fixture also passed:
loading another recent-title page expanded 20 cards to 40; loading additional
genres expanded eight initial rows to all thirteen rows and removed the final
pagination control. No browser page errors were observed. This checks the actual
built web UI, rather than inferring load-more behavior from a successful build.

## Personal-list fixture

The same script now also creates a synthetic account with every title favorited,
one successful play per title, and 220 extra plays of one title. It measures both
legacy and compact account endpoints under authenticated requests. On the
1,000-title fixture, the observed response sizes were:

| Endpoint | Bytes | Cards | Prisma operations/request |
|---|---:|---:|---:|
| Legacy favorites | 2,567,402 | 1,000 | 2 |
| Favorites page | 2,034 | 20 | 2 |
| Legacy history (corrected aggregation) | 51,360 | 20 | 3 |
| History page | 2,029 | 20 | 3 |

Favorite pages cut this initial response by about 99.9%; history pages cut it by
about 96%. Cursor lengths and generated IDs affect exact byte counts. The script
also reports latency; run it without competing build/test jobs for useful timing
comparisons. The history aggregate scans an indexed account history and may need
a maintained summary table at much larger scales.

A separate authenticated browser fixture verified favorite/history pagination,
favorite membership outside the first saved-title page, and preserving an
optimistic removal when a delayed membership response arrives. The web no longer
requests either legacy account-list endpoint on the home page.
