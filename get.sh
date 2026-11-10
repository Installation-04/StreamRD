#!/usr/bin/env bash
# StreamRD + Phosphor one-command installer (all-in-one container).
#
#   curl -fsSL https://raw.githubusercontent.com/Installation-04/StreamRD/main/get.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Installation-04/StreamRD/main/get.sh | bash -s -- --version v0.8.0 --port 9090
#
# It needs Docker with the Compose plugin and curl/tar; it does not install Docker and
# does not need root unless your Docker setup does. It never overwrites an existing
# .env or touches the data volume, so running it again updates the install in place.
# Read it before piping it to a shell: https://github.com/Installation-04/StreamRD/blob/main/get.sh
set -euo pipefail

REPO="${STREAMRD_REPO:-Installation-04/StreamRD}"
RAW_BASE="${STREAMRD_RAW_BASE:-https://raw.githubusercontent.com/$REPO}"
ARCHIVE_BASE="${STREAMRD_ARCHIVE_BASE:-https://github.com/$REPO/archive}"
API_BASE="${STREAMRD_API_BASE:-https://api.github.com/repos/$REPO}"
REGISTRY_IMAGE="${STREAMRD_REGISTRY_IMAGE:-ghcr.io/$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')}"
COMPOSE_REL="infra/docker-compose.single.yml"

DIR="${STREAMRD_DIR:-$HOME/streamrd}"
REF=""; BUILD=false; START=true; UNINSTALL=false
PORT=""; PHOSPHOR_PORT=""; TORRENT_PORT=""; ADMIN_EMAIL=""

log() { printf '[streamrd] %s\n' "$*"; }
die() { printf '[streamrd] ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<EOF
Usage: get.sh [options]

  --dir PATH             Install directory (default: \$HOME/streamrd)
  --version vX.Y.Z       Release to install (default: the latest release that ships the
                         all-in-one container, otherwise the main branch)
  --ref NAME             Any branch or tag instead of --version
  --port N               StreamRD web port (default 8080, kept on re-runs)
  --phosphor-port N      Phosphor web port (default 8081)
  --torrent-port N       qBittorrent peer port (default 6881)
  --admin-email EMAIL    Reserve the first administrator account for this address
  --build                Build the image from source instead of pulling the published one
  --no-start             Download and configure only
  --uninstall            Stop and remove the container (the data volume is kept)
  -h, --help             Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
    --version|--ref) REF="${2:?$1 needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --phosphor-port) PHOSPHOR_PORT="${2:?--phosphor-port needs a number}"; shift 2 ;;
    --torrent-port) TORRENT_PORT="${2:?--torrent-port needs a number}"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="${2:?--admin-email needs an address}"; shift 2 ;;
    --build) BUILD=true; shift ;;
    --no-start) START=false; shift ;;
    --uninstall) UNINSTALL=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
done

valid_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
# Set KEY=VALUE in .env: replace when force is "yes", otherwise only add if missing.
set_env() {
  local key="$1" value="$2" force="${3:-no}" file="$DIR/.env"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    [ "$force" = yes ] || return 0
    local tmp; tmp="$(mktemp)"; grep -v "^${key}=" "$file" > "$tmp" || true
    printf '%s=%s\n' "$key" "$value" >> "$tmp"; cat "$tmp" > "$file"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}
env_value() { grep "^$1=" "$DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }

resolve_ref() {
  [ -n "$REF" ] && return 0
  local tag
  tag="$(curl -fsSL "$API_BASE/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1 || true)"
  if [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && curl -fsI "$RAW_BASE/$tag/$COMPOSE_REL" >/dev/null 2>&1; then
    REF="$tag"
  else
    REF="main"
    log "No release with the all-in-one container was found; using the main branch."
    log "For a pinned install, re-run with --version vX.Y.Z once one is published."
  fi
}

compose() { docker compose -p streamrd --env-file "$DIR/.env" -f "$COMPOSE_FILE" "$@"; }

main() {
  for tool in curl tar docker; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required but was not found."; done
  docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is required (docker compose). See https://docs.docker.com/compose/install/"
  docker info >/dev/null 2>&1 || die "Docker is not reachable. Start it, or run this as a user allowed to use Docker (for example with sudo)."
  mkdir -p "$DIR"; DIR="$(cd "$DIR" && pwd)"

  if [ "$UNINSTALL" = true ]; then
    COMPOSE_FILE="$(cat "$DIR/.compose-file" 2>/dev/null || true)"
    [ -f "${COMPOSE_FILE:-}" ] || die "No installation found in $DIR."
    compose down
    log "Stopped and removed the container. Your data volume (streamrd_streamrd-data) was kept."
    log "To delete ALL data as well: docker volume rm streamrd_streamrd-data"
    return 0
  fi

  for value in "$PORT" "$PHOSPHOR_PORT" "$TORRENT_PORT"; do
    [ -z "$value" ] || valid_port "$value" || die "Ports must be numbers between 1 and 65535."
  done
  [ -z "$ADMIN_EMAIL" ] || printf '%s' "$ADMIN_EMAIL" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' || die "That does not look like an email address."

  resolve_ref
  [[ "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] && [[ "$REF" != *..* ]] || die "Invalid version or ref: $REF"
  log "Installing $REF into $DIR"

  touch "$DIR/.env"; chmod 600 "$DIR/.env"
  set_env STREAMRD_PORT "${PORT:-8080}" "$([ -n "$PORT" ] && echo yes || echo no)"
  set_env PHOSPHOR_PORT "${PHOSPHOR_PORT:-8081}" "$([ -n "$PHOSPHOR_PORT" ] && echo yes || echo no)"
  set_env TORRENT_PORT "${TORRENT_PORT:-6881}" "$([ -n "$TORRENT_PORT" ] && echo yes || echo no)"
  [ -z "$ADMIN_EMAIL" ] || set_env ADMIN_EMAIL "$ADMIN_EMAIL" yes

  # Prefer the published image for a release; otherwise (or with --build) build from source.
  local image="" mode=build
  if [ "$BUILD" = false ] && [[ "$REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    image="$REGISTRY_IMAGE:${REF#v}"
    if docker pull "$image" >/dev/null 2>&1; then mode=pull; log "Pulled $image"; else log "The published image is not available; building from source instead (this takes a few minutes)."; fi
  fi
  if [ "$mode" = pull ]; then
    mkdir -p "$DIR/infra"
    curl -fsSL "$RAW_BASE/$REF/$COMPOSE_REL" -o "$DIR/$COMPOSE_REL"
    COMPOSE_FILE="$DIR/$COMPOSE_REL"
    set_env STREAMRD_IMAGE "$image" yes
  else
    rm -rf "$DIR/src.new"; mkdir -p "$DIR/src.new"
    curl -fsSL "$ARCHIVE_BASE/$REF.tar.gz" | tar -xz -C "$DIR/src.new" --strip-components=1
    [ -f "$DIR/src.new/$COMPOSE_REL" ] || { rm -rf "$DIR/src.new"; die "$REF does not contain the all-in-one container. Try --ref main."; }
    rm -rf "$DIR/src"; mv "$DIR/src.new" "$DIR/src"
    COMPOSE_FILE="$DIR/src/$COMPOSE_REL"
    set_env STREAMRD_IMAGE "streamrd-all-in-one:local" yes
  fi
  printf '%s\n' "$COMPOSE_FILE" > "$DIR/.compose-file"

  if [ "$START" = false ]; then
    log "Configured. Start it with: docker compose -p streamrd --env-file $DIR/.env -f $COMPOSE_FILE up -d"
    return 0
  fi

  if [ -z "$(compose ps -q 2>/dev/null)" ]; then
    for name in STREAMRD_PORT PHOSPHOR_PORT TORRENT_PORT; do
      local p; p="$(env_value "$name")"
      ! port_busy "$p" || die "Port $p is already in use. Re-run with --port, --phosphor-port or --torrent-port to choose another."
    done
  fi
  if [ "$mode" = pull ]; then compose up -d --no-build; else compose up -d --build; fi

  local web; web="$(env_value STREAMRD_PORT)"
  log "Waiting for StreamRD to become ready..."
  for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$web/login" 2>/dev/null; then ready=true; break; fi
    sleep 2
  done
  [ "${ready:-false}" = true ] || die "The container started but StreamRD did not answer in time. Check: docker compose -p streamrd logs"

  cat <<EOF

StreamRD is running.
  StreamRD   http://localhost:$web
  Phosphor   http://localhost:$(env_value PHOSPHOR_PORT)

Create your account on the StreamRD page$( [ -n "$(env_value ADMIN_EMAIL)" ] && echo " with $(env_value ADMIN_EMAIL), which is reserved for the first administrator." || echo "; the first account becomes the administrator." )
Put a reverse proxy with HTTPS in front before exposing it to the internet.

  Update      re-run this script (your data and settings are kept)
  Logs        docker compose -p streamrd --env-file $DIR/.env -f $COMPOSE_FILE logs -f
  Remove      curl -fsSL $RAW_BASE/main/get.sh | bash -s -- --uninstall --dir $DIR   (the data volume is kept)
Settings live in $DIR/.env; data lives in the Docker volume streamrd_streamrd-data.
EOF
}
# Everything runs through one function so a truncated download cannot execute half a script.
main "$@"
