# Server-managed access validation

The backend suites cover **642 tests**: 350 StreamRD and 292 Phosphor.
Both server type checks and all four production image builds passed. Both disposable
container smoke checks passed, including verified backup/restoration, restart
persistence, historical database adoption and mounted-library exports.

## Meaningful regression coverage

- Invitations: hashed secrets, email binding, expiry, replacement/revocation,
  concurrent single-use acceptance and rechecking policy/revocation during hashing.
- Registration: open/invitation/closed modes, existing-account login, malformed
  settings failing closed and restricted first-owner bootstrap.
- Administration: server-side admin checks, immediate role/active-state enforcement
  invalidation of all existing target-user sessions, concurrent cross-demotion /
  deactivation and late actor revocation without losing every active administrator.
- Sharing: source-owner-only publishing, filtered current/future imports,
  per-user grants, opaque scoped pagination, sanitized metadata and unchanged
  private-library boundaries.
- Playback: explicit file choices, pending state, server credentials rather than
  viewer credentials, late grant/session/source/key/provider changes withholding
  results and generic provider failures.
- Read races: library filters, key rotation and provider disabling during metadata
  decoration cannot return stale shared-item details.
- Upgrades: a populated managed v0.5 database retains existing rows and receives no
  automatic libraries, grants or invitations. Every released checkpoint and frozen
  historical fixture remains unchanged. Synthetic future-migration tests now use
  names that sort after any real migration, preserving their intended assertion.

## Production browser acceptance

**26 journeys passed, with 50 screenshots and no page errors** against the final
0.6.0 images. The [report](screenshots/v0.6.0/validation.json) and
[provenance](screenshots/v0.6.0/README.md) record exact scope.

The reproducible runner exercises real production web/API images with fresh
SQLite volumes. Invitation signup, sharing and playback use the same APIs as users.
Provider transport is replaced only by an explicit test preload in disposable
volumes; production images do not contain that preload. Browser playback uses
an original one-second synthetic H.264 video. No live provider credentials or real
subscriber account were available, so these checks do not establish live-provider
account sharing, quota behavior, matching quality or real debrid playback.

The first run completed existing flows and invitation creation, then exposed a
mismatched accessible-label locator in the new test. The locator was corrected
against the rendered UI before repeating acceptance. A later run found that opening
an invitation with signup already open did not refresh the fragment state; both
web apps now handle same-document invitation navigation without retaining the
secret in the address bar. The browser journey keeps that navigation as a regression.

Direct provider URLs may remain usable until provider expiry after server access
is revoked. There is no media proxy or transcoder. PIN-protected managed profiles,
parental restrictions, device inventories and watch progress for shared imports
remain future work. See [the complete guide](server-sharing.md).

Checkpoint verification now has the same 60-second test budget as synthetic future
migration checks. A parallel build run exceeded the former 20-second limit; the
focused checks passed afterward with all schema and isolation assertions intact.
