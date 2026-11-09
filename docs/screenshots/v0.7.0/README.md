# Shared watch progress screenshots — v0.7.0 (development)

Captured from the production StreamRD server and web Docker images built from this
branch, using `infra/run-browser-qa.sh streamrd` against fresh disposable SQLite
volumes. The run passed 14 browser journeys with 27 screenshots (desktop and 390px
mobile) and no page errors; see validation.json.

New journey: a viewer with no provider key pauses synthetic-video playback, the
Continue watching row appears on Shared libraries, progress is per viewer, and
no provider links or references appear in the API response.

Phosphor was not rebuilt or re-run for this change. All accounts and media names are
fictional fixtures; the one-second video is synthetic. No live-provider playback is
claimed.
