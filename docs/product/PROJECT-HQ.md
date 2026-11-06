# StreamRD Community — Product HQ

> CEO: repository owner · Product/engineering lead: Codex · Current milestone: v0.4.0 Safe Upgrades — implementation and local acceptance complete

This is the source of truth for the project tracker. Import the Markdown and CSV
bundle into Notion when a workspace connection is available. **No live Notion page
has been created yet:** this chat has no Notion connector or parent-page access.

## Product direction

Make self-hosted debrid media welcoming, dependable, and easy to operate. StreamRD
is a curated personal cinema; Phosphor is its distinct search-and-queue companion.
Both use the community's own accounts and infrastructure. Plex/Jellyfin export
stays optional and uses real mounted files.

## Active milestone: v0.4.0 Safe Upgrades

| Workstream | Owner | State | Acceptance |
|---|---|---|---|
| Versioned SQLite migrations | Migration engine + lead | Delivered | Exact legacy/current adoption, immutable history, verified snapshot before existing DB changes |
| Independent schema/history validation | Migration research + engine | Delivered | Refuse unknown/custom schema, altered checksums, failed history and partial baseline |
| System readiness UI/API | System design + lead | Delivered | Read-only admin diagnostics, truthful status, no invented backup evidence |
| Upgrade/recovery regression fixtures | Engine + lead | Delivered | New/legacy/current databases preserve rows and FKs; disabled mode writes nothing |
| Production and browser acceptance | Lead | Delivered | Migration-aware container startup/restore and System desktop/mobile checks |

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

## Next milestones

| Priority | Opportunity | Acceptance evidence |
|---|---|---|
| P1 | Native-client parity | Device builds exercise file choice, profile resume, and compatible APIs |
| P1 | Extend the reviewed migration chain | New changes include immutable SQL, regenerated checkpoints and upgrade/recovery fixtures |
| P1 | Credential encryption and session architecture | Documented key backup/rotation and compatible browser/device migration |
| P2 | Playback reliability insights | First-frame/error signals distinguish URL resolution from real playback |
| P2 | Retention and cleanup | Scoped dry runs, protected recoverable references, backup and boundary tests |
| P2 | Richer media metadata | Opt-in provider choice, provenance, editable matches, no false artwork claims |
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
