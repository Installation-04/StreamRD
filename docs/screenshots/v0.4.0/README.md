# Safe Upgrades screenshots — v0.4.0

Twenty captures come from the final production web/API images, using Chromium at
1440 × 1050 and 390 × 844. Mobile/discovery captures show the viewport; other
screens can include the full page. All fourteen browser journeys passed with no
page errors; see [validation.json](validation.json) and
[qa/README.md](../../../qa/README.md) for repeatable checks.

The new System screenshots show actual database inspection with both committed
migrations applied. No migration response is mocked for these captures. The
snapshot panel describes upgrade policy; it is not evidence of an existing
backup. Separate failure fixtures exercise refresh/retry recovery, stale snapshots
and unavailable database presentation before returning to the real endpoint.

Accounts and data are disposable fixtures. Alex Morgan is a fictional demo viewer.
Catalog names refer to Blender Foundation open films; poster fields are empty so
the app displays original geometric CSS fallback designs. No film artwork is
redistributed. Mounted files contain non-playable filesystem fixtures, not movies.
Phosphor uses a local Torznab fixture with synthetic seed/size data and an example
magnet ID. No real debrid or indexer credentials are used.

Library images follow real browser selection, movie/episode metadata review,
export and link-health checks. Later removal checks and backend filesystem tests
verify original preservation. The queue shows a real empty fixture queue; its
separate error/retry journey uses a simulated outage followed by real API recovery.

Themes shown: StreamRD dark/light and Phosphor green/amber/white. Theme controls
and mobile widths are exercised without horizontal document overflow. These are
workflow and visual checks, not complete WCAG or live-provider validation.

The archived v0.2.0/v0.3.0 captures remain in the parent directories. The current
[wiki gallery](https://github.com/Installation-04/StreamRD/wiki/Screenshots) links
the v0.4.0 captures.
