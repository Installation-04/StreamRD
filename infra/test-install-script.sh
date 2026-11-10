#!/usr/bin/env bash
# Exercises install.sh without Docker (a stub stands in for it): files, ports, media server overlays and re-runs.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"; printf '#!/bin/sh\nexit 0\n' > "$work/bin/docker"; chmod +x "$work/bin/docker"
run() { PATH="$work/bin:$PATH" bash "$root/install.sh" --yes --no-start "$@" >/dev/null; }
check() { grep -q "$2" "$1" || { echo "FAIL: $1 lacks: $2" >&2; exit 1; }; }
absent() { ! grep -q "$2" "$1" || { echo "FAIL: $1 has: $2" >&2; exit 1; }; }

d="$work/a"; run --dir "$d"
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
if PATH="$work/bin:$PATH" bash "$root/install.sh" --yes --no-start --dir "$work/b" --media-server nonsense >/dev/null 2>&1; then echo "FAIL: bad --media-server accepted" >&2; exit 1; fi
if PATH="$work/bin:$PATH" bash "$root/install.sh" --yes --no-start --dir "$work/b" --plex-port 99999 >/dev/null 2>&1; then echo "FAIL: bad port accepted" >&2; exit 1; fi
echo "install.sh checks passed"
