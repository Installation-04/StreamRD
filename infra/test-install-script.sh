#!/usr/bin/env bash
# Exercises install.sh without Docker (a stub stands in for it): files, ports, media server overlays and re-runs.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"; printf '#!/bin/sh\nexit 0\n' > "$work/bin/docker"; chmod +x "$work/bin/docker"
run() { PATH="$work/bin:$PATH" bash "$root/install.sh" --yes --no-start "$@" >/dev/null; }
check() { grep -q "$2" "$1" || { echo "FAIL: $1 lacks: $2" >&2; exit 1; }; }
absent() { ! grep -q "$2" "$1" || { echo "FAIL: $1 has: $2" >&2; exit 1; }; }

# A first install has Docker control by default, so Plex and Jellyfin start from the Setup page and Update and Restart work with no extra
# step. It is one container: the helper lives inside StreamRD's, and there is no second service, secret or folder setting.
d0="$work/default"; run --dir "$d0"
check "$d0/.env" '^COMPOSE_FILE=docker-compose.yml:docker-compose.control.yml$'; absent "$d0/.env" MEDIA_MANAGER_TOKEN; absent "$d0/.env" HOST_INSTALL_DIR
run --dir "$d0" --no-media-manager; absent "$d0/.env" control.yml; [ ! -e "$d0/docker-compose.control.yml" ] || { echo "FAIL: the control overlay was left behind" >&2; exit 1; }
d0b="$work/kept"; run --dir "$d0b" --no-media-manager; run --dir "$d0b"; absent "$d0b/.env" control.yml   # declined stays declined
check "$d0b/.env" '^MEDIA_MANAGER_OPTOUT=1$'; run --dir "$d0b" --media-manager; check "$d0b/.env" 'docker-compose.control.yml'; check "$d0b/.env" '^MEDIA_MANAGER_OPTOUT=0$'
# An install from before Docker control existed, or one that never chose, gets it on a re-run; "no" to an older installer's question still stands.
d0c="$work/older"; run --dir "$d0c" --no-media-manager; sed -i '/^MEDIA_MANAGER_OPTOUT=/d' "$d0c/.env"; run --dir "$d0c"; check "$d0c/.env" 'docker-compose.control.yml'
d0d="$work/asked"; run --dir "$d0d" --no-media-manager; sed -i '/^MEDIA_MANAGER_OPTOUT=/d' "$d0d/.env"; echo 'MEDIA_MANAGER_ASKED=1' >> "$d0d/.env"; run --dir "$d0d"; absent "$d0d/.env" control.yml
# An install that ran the helper in a second container (v0.21.0 to v0.23.2) is moved into the one container: the old overlay, its secret
# and its folder setting go, and the person is told how the old helper container is removed.
d0e="$work/two"; run --dir "$d0e" --no-media-manager
printf 'services:\n  media-manager:\n    image: x\n' > "$d0e/docker-compose.manager.yml"
sed -i 's/^COMPOSE_FILE=.*/COMPOSE_FILE=docker-compose.yml:docker-compose.manager.yml/; /^MEDIA_MANAGER_OPTOUT=/d' "$d0e/.env"; printf 'MEDIA_MANAGER_TOKEN=%s\nHOST_INSTALL_DIR=%s\n' "$(printf 'a%.0s' $(seq 48))" "$d0e" >> "$d0e/.env"
moved="$(PATH="$work/bin:$PATH" bash "$root/install.sh" --yes --no-start --dir "$d0e" 2>&1)"
check "$d0e/.env" '^COMPOSE_FILE=docker-compose.yml:docker-compose.control.yml$'; absent "$d0e/.env" MEDIA_MANAGER_TOKEN; absent "$d0e/.env" HOST_INSTALL_DIR
[ ! -e "$d0e/docker-compose.manager.yml" ] || { echo "FAIL: the old helper overlay was left behind" >&2; exit 1; }
printf '%s' "$moved" | grep -q 'one container instead of two' || { echo "FAIL: the move was not announced" >&2; exit 1; }
printf '%s' "$moved" | grep -q -- '--remove-orphans' || { echo "FAIL: removing the old helper container was not explained" >&2; exit 1; }
run --dir "$d0e"; check "$d0e/.env" '^COMPOSE_FILE=docker-compose.yml:docker-compose.control.yml$'   # and it stays that way
d0f="$work/two-off"; run --dir "$d0f" --no-media-manager; sed -i 's/^COMPOSE_FILE=.*/COMPOSE_FILE=docker-compose.yml:docker-compose.manager.yml/' "$d0f/.env"; : > "$d0f/docker-compose.manager.yml"
run --dir "$d0f" --no-media-manager; check "$d0f/.env" '^COMPOSE_FILE=docker-compose.yml$'; [ ! -e "$d0f/docker-compose.manager.yml" ]   # turning it off removes the old helper too

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
# Docker control: on unless declined, a fixed overlay on StreamRD's own service, kept by a plain re-run, and removable again.
run --dir "$d" --media-manager
check "$d/.env" 'docker-compose.control.yml'; check "$d/.env" '^DOCKER_SOCKET_PATH=/var/run/docker.sock$'
check "$d/docker-compose.control.yml" 'user: "0:0"'; check "$d/docker-compose.control.yml" 'no-new-privileges:true'
check "$d/docker-compose.control.yml" '${DOCKER_SOCKET_PATH:-/var/run/docker.sock}:/var/run/docker.sock'
absent "$d/docker-compose.yml" 'docker.sock'; absent "$d/docker-compose.yml" 'user:'   # without the overlay the container has no socket and no root
if python3 -c 'import yaml' 2>/dev/null; then   # one service, and only these three settings on it
  python3 -c "import yaml; d=yaml.safe_load(open('$d/docker-compose.control.yml')); assert list(d['services'])==['streamrd'], d; s=d['services']['streamrd']; assert set(s)=={'user','security_opt','volumes'}, s; assert len(s['volumes'])==1" || { echo "FAIL: the control overlay is not what it should be" >&2; exit 1; }
fi
for dir in jellyfin/config jellyfin/cache plex/config plex/transcode; do [ -d "$d/config/$dir" ] || { echo "FAIL: config/$dir missing" >&2; exit 1; }; done
run --dir "$d"; check "$d/.env" 'docker-compose.control.yml'   # kept by a plain re-run
run --dir "$d" --no-media-manager; absent "$d/.env" 'control.yml'
# Rootless Docker keeps its socket elsewhere; the overlay is pointed at it.
mkdir -p "$work/rootless"; printf '#!/bin/sh\ncase "$1" in info) echo "[name=seccomp,profile=builtin name=rootless]";; esac\nexit 0\n' > "$work/rootless/docker"; chmod +x "$work/rootless/docker"
DOCKER_HOST=unix:///run/user/1000/docker.sock PATH="$work/rootless:$PATH" bash "$root/install.sh" --yes --no-start --dir "$work/r" >/dev/null
check "$work/r/.env" '^DOCKER_SOCKET_PATH=/run/user/1000/docker.sock$'
if PATH="$work/bin:$PATH" bash "$root/install.sh" --yes --no-start --dir "$work/b" --media-server nonsense >/dev/null 2>&1; then echo "FAIL: bad --media-server accepted" >&2; exit 1; fi
if PATH="$work/bin:$PATH" bash "$root/install.sh" --yes --no-start --dir "$work/b" --plex-port 99999 >/dev/null 2>&1; then echo "FAIL: bad port accepted" >&2; exit 1; fi
echo "install.sh checks passed"
