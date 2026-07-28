#!/usr/bin/env bash
# StreamRD uninstaller. Stops and removes the containers started by
# install.sh. By default the database volume and built images are left
# alone; opt in to removing them with the flags below.
#
# Usage: ./uninstall.sh [--purge-data] [--purge-images] [--purge]
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$INFRA_DIR/.env"
MANIFEST="$INFRA_DIR/.install-manifest"

log() { echo "[streamrd-uninstall] $*"; }
die() { echo "[streamrd-uninstall] ERROR: $*" >&2; exit 1; }

PURGE_DATA=0
PURGE_IMAGES=0

usage() {
  cat <<EOF
Usage: $0 [--purge-data] [--purge-images] [--purge]

  --purge-data    also delete the database volume (irreversible: all
                   accounts, catalog entries, and history are lost)
  --purge-images  also remove the Docker images this project built
  --purge         shorthand for both of the above
EOF
}

for arg in "$@"; do
  case "$arg" in
    --purge-data) PURGE_DATA=1 ;;
    --purge-images) PURGE_IMAGES=1 ;;
    --purge) PURGE_DATA=1; PURGE_IMAGES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $arg (see --help)" ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "Docker is not installed — nothing to uninstall."

[ -f "$MANIFEST" ] && log "Found install manifest: $MANIFEST"
[ -f "$ENV_FILE" ] || log "Note: $ENV_FILE not found; proceeding with compose defaults."

down_args=(down)
[ "$PURGE_DATA" -eq 1 ] && down_args+=(-v)
[ "$PURGE_IMAGES" -eq 1 ] && down_args+=(--rmi local)

log "Stopping and removing containers${PURGE_DATA:+ (and the data volume)}..."
if [ -f "$ENV_FILE" ]; then
  (cd "$INFRA_DIR" && docker compose --env-file "$ENV_FILE" "${down_args[@]}" --remove-orphans)
else
  (cd "$INFRA_DIR" && docker compose "${down_args[@]}" --remove-orphans)
fi

if [ "$PURGE_DATA" -eq 1 ]; then
  log "Database volume removed."
else
  log "Containers removed; database volume preserved (re-run with --purge-data to delete it)."
fi
[ "$PURGE_IMAGES" -eq 1 ] && log "Built images removed."

rm -f "$MANIFEST"
log "Done. $ENV_FILE was left in place in case you reinstall — it contains JWT_SECRET, so delete it yourself once you're sure you're done."
