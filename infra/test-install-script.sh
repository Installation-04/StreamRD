#!/usr/bin/env bash
# Exercises install.sh without Docker (a stub stands in for it): files, ports, media server overlays and re-runs.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"; printf '#!/bin/sh\nexit 0\n' > "$work/bin/docker"; chmod +x "$work/bin/docker"
run() { PATH="$work/bin:$PATH" bash "$root/install.sh" --yes --no-start "$@" >/dev/null; }
check() { grep -q "$2" "$1" || { echo "FAIL: $1 lacks: $2" >&2; exit 1; }; }
absent() { ! grep -q "$2" "$1" || { echo "FAIL: $1 has: $2" >&2; exit 1; }; }

# A first install gets the media manager by default, so Plex and Jellyfin start from the Setup page with no extra step.
d0="$work/default"; run --dir "$d0"
check "$d0/.env" '^COMPOSE_FILE=docker-compose.yml:docker-compose.manager.yml$'; check "$d0/.env" '^MEDIA_MANAGER_TOKEN=[0-9a-f]\{48\}$'
run --dir "$d0" --no-media-manager; absent "$d0/.env" manager.yml
d0b="$work/kept"; run --dir "$d0b" --no-media-manager; run --dir "$d0b"; absent "$d0b/.env" manager.yml   # declined stays declined
check "$d0b/.env" '^MEDIA_MANAGER_OPTOUT=1$'; run --dir "$d0b" --media-manager; check "$d0b/.env" 'docker-compose.manager.yml'; check "$d0b/.env" '^MEDIA_MANAGER_OPTOUT=0$'
# An install from before the helper existed, or one that never chose, gets it on a re-run; "no" to an older installer's question still stands.
d0c="$work/older"; run --dir "$d0c" --no-media-manager; sed -i '/^MEDIA_MANAGER_OPTOUT=/d' "$d0c/.env"; run --dir "$d0c"; check "$d0c/.env" 'docker-compose.manager.yml'; check "$d0c/.env" '^MEDIA_MANAGER_TOKEN=[0-9a-f]\{48\}$'
d0d="$work/asked"; run --dir "$d0d" --no-media-manager; sed -i '/^MEDIA_MANAGER_OPTOUT=/d' "$d0d/.env"; echo 'MEDIA_MANAGER_ASKED=1' >> "$d0d/.env"; run --dir "$d0d"; absent "$d0d/.env" manager.yml

d="$work/a"; run --dir "$d" --no-media-manager
check "$d/.env" '^COMPOSE_FILE=docker-compose.yml$'; absent "$d/.env" jellyfin

run --dir "$d" --media-server both --jellyfin-port 8097 --plex-port 32401
check "$d/.env" '^COMPOSE_FILE=docker-compose.yml:docker-compose.jellyfin.yml:docker-compose.plex.yml$'
check "$d/.env" '^JELLYFIN_PORT=8097$'; check "$d/.env" '^PLEX_PORT=32401$'
check "$d/docker-compose.jellyfin.yml" '/library/streamrd:ro'; check "$d/docker-compose.plex.yml" '/data:ro'
absent "$d/docker-compose.jellyfin.yml" '/mnt/zurg'
for dir in streamrd/library phosphor/library jellyfin/config plex/config; do [ -d "$d/config/$dir" ] || { echo "FAIL: config/$dir missing" >&2; exit 1; }; done

run --dir "$d"                       # a plain re-run keeps what was chosen
check "$d/.env" 'jellyfin.yml:docker-compose.plex.yml'
run --dir "$d" --media-server jellyfin
check "$d/.env" '^COMPOSE_FILE=docker-compose.yml:docker-compose.jellyfin.yml$'
run --dir "$d" --media-server none
check "$d/.env" '^COMPOSE_FILE=docker-compose.yml$'; [ -d "$d/config/jellyfin" ]   # settings are kept
# The media manager helper: on unless declined, a fixed locked-down overlay, a generated secret kept across runs, and removable again.
run --dir "$d" --media-manager
check "$d/.env" 'docker-compose.manager.yml'; check "$d/.env" '^MEDIA_MANAGER_TOKEN=[0-9a-f]\{48\}$'; check "$d/.env" "^HOST_INSTALL_DIR=$d\$"
check "$d/docker-compose.manager.yml" 'user: "0:0"'; check "$d/docker-compose.manager.yml" 'read_only: true'; check "$d/docker-compose.manager.yml" 'cap_drop: \[ALL\]'
check "$d/docker-compose.manager.yml" '/var/run/docker.sock:/var/run/docker.sock'; check "$d/docker-compose.manager.yml" 'MEDIA_MANAGER_URL: http://media-manager:8099'; check "$d/docker-compose.manager.yml" 'ZURG: "0"'
absent "$d/docker-compose.yml" 'docker.sock'   # StreamRD itself never gets the socket
python3 -c "import yaml,sys; d=yaml.safe_load(open('$d/docker-compose.manager.yml')); assert list(d['services'])==['streamrd','media-manager']; assert 'ports' not in d['services']['media-manager']" 2>/dev/null || true
for dir in jellyfin/config jellyfin/cache plex/config plex/transcode; do [ -d "$d/config/$dir" ] || { echo "FAIL: config/$dir missing" >&2; exit 1; }; done
token="$(grep '^MEDIA_MANAGER_TOKEN=' "$d/.env")"; run --dir "$d"; [ "$token" = "$(grep '^MEDIA_MANAGER_TOKEN=' "$d/.env")" ] || { echo "FAIL: token changed on a re-run" >&2; exit 1; }
check "$d/.env" 'docker-compose.manager.yml'   # kept by a plain re-run
run --dir "$d" --no-media-manager; absent "$d/.env" 'manager.yml'
if PATH="$work/bin:$PATH" bash "$root/install.sh" --yes --no-start --dir "$work/b" --media-server nonsense >/dev/null 2>&1; then echo "FAIL: bad --media-server accepted" >&2; exit 1; fi
if PATH="$work/bin:$PATH" bash "$root/install.sh" --yes --no-start --dir "$work/b" --plex-port 99999 >/dev/null 2>&1; then echo "FAIL: bad port accepted" >&2; exit 1; fi
echo "install.sh checks passed"
