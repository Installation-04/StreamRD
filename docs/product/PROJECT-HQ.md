# StreamRD Community — Product HQ

> CEO: repository owner · Product/engineering lead: Codex · Current milestone: v0.27.0 Add-on integration — in progress

This is the public repository record for the project tracker. A private Notion
progress home and delivery database were created for v0.27.0, including a status
board, evidence links and a needs-attention view. Its private link is available in
the project chat. Repository and Notion updates are explicit, not automatically
synchronized; preserve verification evidence in both.

## Current work: v0.27.0 Add-on integration

As of 2026-11-13, the continuation point is Claude's `bf593bb` on
`claude/streamrd-phosphor-audit-etur2v`. Stable, beta and dev currently contain
v0.26.1. Follow [the branch workflow](../branches.md): changes enter `dev` by
pull request, then promote through `beta` to `main` after checks pass.

Generated encrypted logins and Prowlarr application links are implemented.
Current validation also covers preserving an owner's replacement login,
coalescing overlapping link passes, and bounded signup retries in both products.
Local backend acceptance passes: 606 StreamRD tests and 492 Phosphor tests,
with five StreamRD cases skipped; both backend typechecks and all four server/web
production builds pass. Shared-source consistency also passes.
The documented Google Chrome local-lab journey passes all 24 steps with no page
errors, using synthetic providers and media. All ten CI checks pass on `cb41957`,
including real Prowlarr/Sonarr linking. Follow-up work extends that real-container
acceptance to Radarr and Lidarr; subsequent commits require their own passing
checks. No release or branch promotion has been performed.
See [the v0.27.0 notes](../releases/v0.27.0.md) for behavior and verification limits.

Remaining add-on integration: download clients, root folders, FlareSolverr in
Prowlarr, and Bazarr, Seerr, Tautulli and Maintainerr setup. These remain open;
installation alone does not establish working integration. Use
[the roadmap](../roadmap.md) for current priorities and [the add-on guide](../add-ons.md)
for supported behavior. The delivery records below describe earlier milestones.

## v0.6.0 Server-managed sharing — historical delivery record

The owner chose shared server libraries and playback instead of requiring invited
users to bring their own debrid accounts. The v0.6.0 work implements
email-bound invitations, signup policy, administrator session revocation, named
libraries, per-user grants and owner-account playback. Both complete backend suites
passed locally: **642 tests** (350 StreamRD, 292 Phosphor). Four production images
and both disposable upgrade/backup/restore smoke checks passed. The final production browser run passed **26 journeys with 50 screenshots and no
page errors**. Both CI pipelines gate the exact annotated release tag.

Private libraries stay private unless the source administrator deliberately shares
present/future imports by type. Plex Home PINs, managed children, parental controls,
legacy catalog ACLs remain future work (shared-import watch progress is
implemented on the v0.7.0 development line); the
[current guide](https://github.com/Installation-04/StreamRD/blob/v0.6.0/docs/server-sharing.md)
states these limits. Released v0.5.0 tags and downloads remain unchanged.

## Product direction

Make self-hosted debrid media welcoming, dependable, and easy to operate. StreamRD
is a curated personal cinema; Phosphor is its distinct search-and-queue companion.
Both use the community's own accounts and infrastructure. Plex/Jellyfin export
stays optional and uses real mounted files.

## v0.5.0 Automatic Libraries — historical delivery record

| Workstream | Owner | State | Acceptance |
|---|---|---|---|
| TMDB / OMDb metadata services | Provider engineering | Delivered | Server-only keys, normalized details, bounded caches/requests and safe failures |
| Automatic enrichment and field ownership | Lead | Delivered | Durable queue, confident matching, locks and stale-result guards |
| Personal debrid library and onboarding scan | Scanner backend + UI | Delivered | Owner-only imports, paged read-only scans, cancellation and duplicate-free rescans |
| Private playback and matching UI | Product design + lead | Delivered | Explicit temporary streams, video choices, owner-scoped metadata corrections |
| Additive migrations and recovery | Storage + lead | Delivered | Existing rows preserved, released checkpoints immutable, private metadata cascades |
| Production / browser / release acceptance | Lead | Local checks passed; CI/tag gates publication | All builds, upgrade/restore checks, browser journeys, screenshots and CI pass |

## Current delivery board

| Workstream | Owner | State | Definition of done |
|---|---|---|---|
| Responsive StreamRD discovery | Design / lead integration | Delivered | Attractive desktop/mobile catalog, real favorite/progress behavior, usable themes and keyboard controls |
| Phosphor cockpit refresh | Design / lead integration | Delivered | Legible themed search, saved-search recovery, responsive navigation and queue |
| Browse and bulk-export mounted media | Library API + UI / lead integration | Delivered | Safe scoped pagination, reviewed metadata, per-file outcomes, originals preserved |
| Guided setup | Setup / lead integration | Delivered | Private account-aware checklist, actionable admin/member paths, honest configuration status |
| Community contribution workflow | Lead | Delivered | Setup instructions, feature/bug templates, reproducible checks, clear project ownership |
| Regression and visual QA | Lead | Delivered | Backend checks, four production builds, disposable browser journeys and mobile screenshots |
| Notion workspace publication | CEO provides workspace access | Blocked | An accessible parent page/connection, real page created and verified |
| v0.3.0 release | Lead | Delivered with the version tag | CI green on tagged commit, checked notes/assets, updated wiki/tracker |

## Delivery log

- **v0.2.0 shipped:** paginated catalog and personal lists, durable provider work,
  web torrent-file choice and profile resume, bounded Phosphor traffic, stronger
  sessions, production backup/restore, optional Plex/Jellyfin symlinks, wiki and
  eleven screenshots. Both real scanner reads passed. 256 backend tests passed.
- **v0.3.0 Community Edition:** guided setup, reviewed mounted-file browsing and
  bulk export, responsive discovery/search/queue interfaces, contributor templates,
  repeatable browser QA, and the Notion-importable project tracker. Multiple agents
  contributed focused work; after agent capacity was interrupted, the lead completed
  integration and validation. **278 backend tests, 12 browser journeys, 16 screenshots**,
  four production builds and both backup/restore smoke checks passed locally.
  [Release](https://github.com/Installation-04/StreamRD/releases/tag/v0.3.0) ·
  [Validation](https://github.com/Installation-04/StreamRD/blob/v0.3.0/docs/community-validation.md)


- **v0.4.0 Safe Upgrades:** versioned SQLite migration chains, exact historical/current
  adoption, verified snapshots before existing database changes, independent
  schema/history checks and read-only System readiness pages. **318 backend tests,
  14 browser journeys, 20 screenshots**, four production builds and both enhanced
  upgrade/backup/restore smoke checks passed locally. The release is gated on both
  CI pipelines; its tag and Release workflow record publication evidence.
  [Release](https://github.com/Installation-04/StreamRD/releases/tag/v0.4.0) ·
  [Validation](https://github.com/Installation-04/StreamRD/blob/v0.4.0/docs/safe-upgrades-validation.md)

- **v0.5.0 Automatic Libraries:** TMDB/OMDb enrichment, field ownership and locks,
  private onboarding account imports, durable paged scans and explicit owner
  playback. Local acceptance includes 550 backend cases, four production builds,
  both upgrade/restore checks, 20 browser journeys and 36 screenshots. The exact
  release commit must pass both CI pipelines before its annotated version tag.
  [Release](https://github.com/Installation-04/StreamRD/releases/tag/v0.5.0) ·
  [Validation](https://github.com/Installation-04/StreamRD/blob/v0.5.0/docs/automatic-libraries-validation.md)

## Product principles

1. Show real state. Configured keys are not verified connections; resolved links
   are not proof of successful playback.
2. Make the next action obvious, including on empty installations and failures.
3. Preserve source media and credentials. Never hide destructive operations in a
   convenient button.
4. Keep self-hosting practical: SQLite, containers, bounded background work, and
   optional integrations instead of mandatory cloud services.
5. Accessibility is part of design: readable contrast, labels, visible focus,
   reduced motion, small-screen layouts, and touch-friendly controls.

## Earlier backlog

This list predates the current add-on work; consult [the roadmap](../roadmap.md)
before choosing the next milestone. In particular, native clients were removed
from the repository and are not the current priority.

| Priority | Opportunity | Acceptance evidence |
|---|---|---|
| P1 | Native-client parity | Device builds exercise file choice, profile resume, and compatible APIs |
| P1 | Extend the reviewed migration chain | New changes include immutable SQL, regenerated checkpoints and upgrade/recovery fixtures |
| P1 | Credential encryption and session architecture | Documented key backup/rotation and compatible browser/device migration |
| P2 | Playback reliability insights | First-frame/error signals distinguish URL resolution from real playback |
| P2 | Retention and cleanup | Scoped dry runs, protected recoverable references, backup and boundary tests |
| P2 | Refine metadata quality and retention | Measure matching outcomes and add scoped retention without losing manual edits |
| P3 | Multi-instance coordination | Add only after real deployment measurements justify it |

## Operating cadence

Update this page and `tasks.csv` after each verified milestone. Record the commit,
checks run, screenshots, remaining risks, and next steps. Keep unverified/live
provider checks separate from local fixture results. Release notes and wiki links
are durable evidence; marketing copy is not completion evidence.

## Links

- Repository: https://github.com/Installation-04/StreamRD
- Releases: https://github.com/Installation-04/StreamRD/releases
- Wiki: https://github.com/Installation-04/StreamRD/wiki
- Current stable: https://github.com/Installation-04/StreamRD/releases/latest
- Engineering backlog: [optimization plan](https://github.com/Installation-04/StreamRD/blob/main/docs/optimization-plan.md)
