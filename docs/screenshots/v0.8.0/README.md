# Requests, single container and admin maintenance screenshots — v0.8.0

Captured from the production StreamRD and Phosphor server and web Docker images built
from this branch with `infra/run-browser-qa.sh both`, against fresh disposable SQLite
volumes. The run passed 37 browser journeys with 76 screenshots (desktop and 390px
mobile) and no page errors; see validation.json.

New in this release: **system-maintenance** (Admin → System with Updates and
Backups & restore, restore confirmation filled in but cancelled) and the
**system-updates-mobile** / **system-maintenance-mobile** panel captures, plus the
discovery and request screens from the media-requests work.

The browser run creates, verifies, downloads and deletes a real backup, but does not
restart the disposable service, so the restore swap itself is covered by backend
tests rather than a browser journey. The container has no update hook, so one-click
update is not exercised in the browser (the hook, backup-first and failure paths are
backend-tested). All identities and media names are fictional fixtures; provider
traffic is fixture transport. No live-provider behavior is claimed.
