# Shared watch progress screenshots — v0.7.0 (development)

Captured from the production StreamRD and Phosphor server and web Docker images built from this
branch, using `infra/run-browser-qa.sh both` against fresh disposable SQLite
volumes. The run passed 27 browser journeys with 52 screenshots (desktop and 390px
mobile) and no page errors; see validation.json.

New journey: a viewer with no provider key pauses synthetic-video playback, the
Continue watching row appears on Shared libraries, progress is per viewer, and
no provider links or references appear in the API response.

Phosphor's images were rebuilt and its existing journeys re-run unchanged; the new
watch-progress journey is StreamRD-only. All accounts and media names are
fictional fixtures; the one-second video is synthetic. No live-provider playback is
claimed.
