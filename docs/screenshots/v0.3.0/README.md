# Community Edition screenshots — v0.3.0

Sixteen captures come from the final production web/API images, using Chromium at
1440 × 1050 and 390 × 844. Mobile/discovery captures show the viewport; library and
setup screens can include the full page. All twelve browser journeys passed with
no page errors; see [validation.json](validation.json) and
[qa/README.md](../../../qa/README.md) for repeatable checks.

Accounts and data are disposable fixtures. Alex Morgan is a fictional demo viewer.
Catalog names refer to Blender Foundation open films; poster fields are empty so
the app displays original geometric CSS fallback designs. No film artwork is
redistributed. Mounted files contain tiny non-playable filesystem fixtures, not
movies. Phosphor uses a local Torznab fixture with synthetic seed/size data and an
example magnet ID. No real debrid or indexer credentials are used.

The library images were captured after selecting the two demo files through the
real browser UI, reviewing their movie/episode suggestions, exporting, and checking
link health. A subsequent test removes an export; backend filesystem regressions
verify original preservation. The queue image shows a real empty fixture queue;
an error/retry journey uses a simulated outage before recovering against the API.

Themes shown: StreamRD dark and light, Phosphor green/amber/white. Theme controls
and mobile layout widths were exercised, with no horizontal document overflow.
These are workflow/visual checks, not complete WCAG or live-provider validation.
