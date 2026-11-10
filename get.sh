#!/usr/bin/env bash
# StreamRD + Phosphor one-command installer (all-in-one container), laid out like Radarr/Sonarr:
#
#   ~/streamrd/docker-compose.yml   the container definition
#   ~/streamrd/.env                 ports and the image tag
#   ~/streamrd/config/              settings, databases, secrets, backups  -> /config
#   ~/streamrd/data/                downloads and media                     -> /data
#
#   curl -fsSL https://raw.githubusercontent.com/Installation-04/StreamRD/main/get.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Installation-04/StreamRD/main/get.sh | bash -s -- --port 3000 --admin-email you@example.com
#
# Updating = running it again (or `docker compose pull && docker compose up -d` in that folder):
# it pulls the newer image and recreates the container. config/ and data/ are never touched.
# It needs Docker with the Compose plugin plus curl/tar, does not install Docker and does not need
# root unless your Docker setup does. Read it before piping it to a shell:
# https://github.com/Installation-04/StreamRD/blob/main/get.sh
set -euo pipefail

REPO="${STREAMRD_REPO:-Installation-04/StreamRD}"
RAW_BASE="${STREAMRD_RAW_BASE:-https://raw.githubusercontent.com/$REPO}"
ARCHIVE_BASE="${STREAMRD_ARCHIVE_BASE:-https://github.com/$REPO/archive}"
API_BASE="${STREAMRD_API_BASE:-https://api.github.com/repos/$REPO}"
REGISTRY_IMAGE="${STREAMRD_REGISTRY_IMAGE:-ghcr.io/$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')}"

DIR="${STREAMRD_DIR:-$HOME/streamrd}"
REF=""; BUILD=false; START=true; UNINSTALL=false; REFRESH_COMPOSE=false
PORT=""; PHOSPHOR_PORT=""; TORRENT_PORT=""; ADMIN_EMAIL=""; IMPORT_DB=""; JWT_SECRET=""
PHOSPHOR=""; QBIT=""; ZILEAN=""; ZURG=""; RD_TOKEN="${RD_TOKEN:-}"

log() { printf '[streamrd] %s\n' "$*"; }
die() { printf '[streamrd] ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<EOF
Usage: get.sh [options]

  --dir PATH             Install directory (default: \$HOME/streamrd)
  --version vX.Y.Z       Release to run (default: latest)
  --ref NAME             Build from this branch or tag instead of pulling an image
  --port N               StreamRD web port (default 8080, kept on re-runs)
  --phosphor-port N      Phosphor web port (default 8081)
  --torrent-port N       qBittorrent peer port (default 6881)
  --admin-email EMAIL    Reserve the first administrator account for this address
  --no-phosphor          Do not run Phosphor (the search/queue companion)
  --no-qbittorrent       Do not run the bundled qBittorrent client
  --zilean               Also run Zilean (a Debrid Media Manager torrent index) and add it to Phosphor as an indexer
  --no-zilean            Stop running Zilean (its data volumes are kept)
  --zurg                 Also run Zurg + rclone, mounting your Real-Debrid movies and shows at ./mnt/zurg (Linux only)
  --rd-token TOKEN       Real-Debrid API token for Zurg (or set RD_TOKEN); stored only in zurg/config.yml
  --no-zurg              Stop running Zurg (its config is kept)
  --import-db FILE       Start from an existing StreamRD database backup (first install only)
  --jwt-secret VALUE     Keep your old signing key so existing logins stay valid (with --import-db)
  --build                Build the image from source instead of pulling the published one
  --refresh-compose      Rewrite docker-compose.yml (otherwise your edits to it are kept)
  --no-start             Create the folders and files only
  --uninstall            Stop and remove the container (config/ and data/ are kept)
  -h, --help             Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
    --version|--ref) [ "$1" = "--ref" ] && BUILD=true; REF="${2:?$1 needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --phosphor-port) PHOSPHOR_PORT="${2:?--phosphor-port needs a number}"; shift 2 ;;
    --torrent-port) TORRENT_PORT="${2:?--torrent-port needs a number}"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="${2:?--admin-email needs an address}"; shift 2 ;;
    --no-phosphor) PHOSPHOR=false; shift ;;
    --no-qbittorrent) QBIT=false; shift ;;
    --zilean) ZILEAN=on; shift ;;
    --no-zilean) ZILEAN=off; shift ;;
    --zurg) ZURG=on; shift ;;
    --no-zurg) ZURG=off; shift ;;
    --rd-token) RD_TOKEN="${2:?--rd-token needs a value}"; shift 2 ;;
    --import-db) IMPORT_DB="${2:?--import-db needs a file}"; shift 2 ;;
    --jwt-secret) JWT_SECRET="${2:?--jwt-secret needs a value}"; shift 2 ;;
    --build) BUILD=true; shift ;;
    --refresh-compose) REFRESH_COMPOSE=true; shift ;;
    --no-start) START=false; shift ;;
    --uninstall) UNINSTALL=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
done

valid_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
# Set KEY=VALUE in .env: replace when force is "yes", otherwise only add when missing.
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
drop_env() { local tmp; tmp="$(mktemp)"; { grep -v "^$1=" "$DIR/.env" || true; } > "$tmp"; cat "$tmp" > "$DIR/.env"; rm -f "$tmp"; }
env_value() { grep "^$1=" "$DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }
# Run from the install folder: COMPOSE_FILE in .env holds paths relative to it.
compose() { (cd "$DIR" && docker compose -p streamrd "$@"); }

write_compose() {
  cat > "$DIR/docker-compose.yml" <<'EOF'
# Generated by get.sh. Your settings live in .env; config/ holds all state and data/ your downloads.
# Update: docker compose pull && docker compose up -d     (config/ and data/ are never modified)
services:
  streamrd:
    image: ${STREAMRD_IMAGE:-ghcr.io/installation-04/streamrd}:${STREAMRD_TAG:-latest}
    container_name: streamrd
    restart: unless-stopped
    stop_grace_period: 30s
    ports:
      - "${STREAMRD_PORT:-8080}:8080"
      - "${PHOSPHOR_PORT:-8081}:8081"
      - "${TORRENT_PORT:-6881}:6881/tcp"
      - "${TORRENT_PORT:-6881}:6881/udp"
    environment:
      CONFIG_DIR: /config
      TZ: ${TZ:-UTC}
      ENABLE_PHOSPHOR: ${ENABLE_PHOSPHOR:-true}
      ENABLE_QBITTORRENT: ${ENABLE_QBITTORRENT:-true}
      ADMIN_EMAIL: ${ADMIN_EMAIL:-}
      STREAMRD_JWT_SECRET: ${STREAMRD_JWT_SECRET:-}
      TRUST_PROXY: ${TRUST_PROXY:-false}
      UPDATE_WEBHOOK_URL: ${UPDATE_WEBHOOK_URL:-}
      UPDATE_WEBHOOK_TOKEN: ${UPDATE_WEBHOOK_TOKEN:-}
    volumes:
      - ./config:/config
      - ./data:/data
    labels:
      # Opt in to automatic updates if you run Watchtower.
      com.centurylinklabs.watchtower.enable: "true"
EOF
}

write_zilean() {
  cat > "$DIR/docker-compose.zilean.yml" <<'EOF'
# Zilean: a self-hosted index of Debrid Media Manager's cached torrents, exposed as a Torznab feed.
# Phosphor registers it automatically (ZILEAN_URL). The first import can take a while and uses CPU and disk.
services:
  streamrd:
    environment:
      ZILEAN_URL: http://zilean:8181
  zilean:
    image: ipromknight/zilean:latest
    container_name: zilean
    restart: unless-stopped
    tty: true
    environment:
      # Zilean's default connection string does not pick up the password, so it is set explicitly.
      Zilean__Database__ConnectionString: "Host=zilean-db;Database=zilean;Username=postgres;Password=${ZILEAN_DB_PASSWORD:?run get.sh --zilean};Timeout=30;CommandTimeout=3600"
    volumes:
      - zilean_data:/app/data
      - zilean_tmp:/tmp
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8181/healthchecks/ping"]
      interval: 30s
      timeout: 10s
      retries: 10
    depends_on:
      zilean-db:
        condition: service_healthy
    labels:
      com.centurylinklabs.watchtower.enable: "true"
  zilean-db:
    image: postgres:17.2-alpine
    container_name: zilean-db
    restart: unless-stopped
    shm_size: 2g
    environment:
      PGDATA: /var/lib/postgresql/data/pgdata
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${ZILEAN_DB_PASSWORD:?run get.sh --zilean}
      POSTGRES_DB: zilean
    volumes:
      - zilean_db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d zilean"]
      interval: 10s
      timeout: 5s
      retries: 10
volumes:
  zilean_data:
  zilean_tmp:
  zilean_db:
EOF
}

write_zurg() {
  mkdir -p "$DIR/zurg" "$DIR/mnt/zurg"
  cat > "$DIR/docker-compose.zurg.yml" <<'EOF'
# Zurg exposes your Real-Debrid library as WebDAV (movies and shows only, see zurg/config.yml) and rclone mounts it
# at ./mnt/zurg. StreamRD sees it at /mnt/zurg and uses it as its media source for Plex/Jellyfin exports.
# Needs a Linux host with FUSE; the mount folder must be a shared mount (get.sh sets that up when run as root).
services:
  streamrd:
    environment:
      MEDIA_SOURCE_ROOT: /mnt/zurg
    volumes:
      - ./mnt/zurg:/mnt/zurg:rslave
  zurg:
    image: ghcr.io/debridmediamanager/zurg-public:latest
    container_name: zurg
    restart: unless-stopped
    volumes:
      - ./zurg/config.yml:/app/config.yml
      - zurg_data:/app/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9999/http/version.txt"]
      interval: 30s
      timeout: 10s
      retries: 10
    labels:
      com.centurylinklabs.watchtower.enable: "true"
  zurg-rclone:
    image: rclone/rclone:latest
    container_name: zurg-rclone
    restart: unless-stopped
    volumes:
      - ./mnt/zurg:/data:rshared
      - ./zurg/rclone.conf:/config/rclone/rclone.conf:ro
    cap_add:
      - SYS_ADMIN
    security_opt:
      - apparmor:unconfined
    devices:
      - /dev/fuse:/dev/fuse:rwm
    depends_on:
      zurg:
        condition: service_healthy
    command: ["mount", "zurg:", "/data", "--allow-other", "--allow-non-empty", "--uid", "1000", "--gid", "1000", "--dir-cache-time", "10s", "--vfs-cache-mode", "full"]
volumes:
  zurg_data:
EOF
  [ -f "$DIR/zurg/rclone.conf" ] || printf '[zurg]\ntype = webdav\nurl = http://zurg:9999/dav/\nvendor = other\npacer_min_sleep = 0\n' > "$DIR/zurg/rclone.conf"
  if [ ! -f "$DIR/zurg/config.yml" ]; then
    [ -n "$RD_TOKEN" ] || die "--zurg needs your Real-Debrid API token: --rd-token TOKEN (https://real-debrid.com/apitoken)"
    ( umask 077; cat > "$DIR/zurg/config.yml" <<EOF
zurg: v1
token: $RD_TOKEN
check_for_changes_every_secs: 10
enable_repair: false
# Movies and shows only: a torrent must contain a video file, and obvious games, software, music and
# courses are excluded. Edit freely; apply with: docker compose restart zurg
directories:
  shows:
    group_order: 10
    group: media
    filters:
      - and:
          - has_episodes: true
          - any_file_inside_regex: /\.(mkv|mp4|m4v|avi|mov|ts|m2ts|webm|mpg|mpeg|wmv)\$/i
          - not_regex: /(fitgirl|repack.*(game|iso)|xbox|ps[2345]\b|playstation|nintendo|\bnsw\b|keygen|crack(ed)?\b|discography|udemy|coursera|ebook)/i
  movies:
    group_order: 20
    group: media
    only_show_the_biggest_file: true
    filters:
      - and:
          - any_file_inside_regex: /\.(mkv|mp4|m4v|avi|mov|ts|m2ts|webm|mpg|mpeg|wmv)\$/i
          - not_regex: /(fitgirl|repack.*(game|iso)|xbox|ps[2345]\b|playstation|nintendo|\bnsw\b|keygen|crack(ed)?\b|discography|udemy|coursera|ebook)/i
EOF
    )
  fi
}

# Zurg's mount folder must be a shared mount so rclone's FUSE mount is visible inside the StreamRD container.
prepare_zurg_mount() {
  local target="$DIR/mnt/zurg"
  [ "$(uname -s)" = Linux ] || die "Zurg needs a Linux host (FUSE mount propagation); Docker Desktop is not supported."
  [ -e /dev/fuse ] || die "/dev/fuse is missing; install FUSE on the host (for example: apt install fuse3)."
  if findmnt -n --mountpoint "$target" -o PROPAGATION 2>/dev/null | grep -q shared; then return 0; fi
  if [ "$(id -u)" = 0 ]; then
    mountpoint -q "$target" || mount --bind "$target" "$target"
    mount --make-rshared "$target"
  else
    die "Run these once as root, then re-run get.sh:  sudo mount --bind $target $target && sudo mount --make-rshared $target"
  fi
}


# The container runs as UID 1000; make sure it can write the two folders.
own_folders() {
  local image="$1"
  if [ "$(id -u)" = 0 ]; then chown -R 1000:1000 "$DIR/config" "$DIR/data"; return; fi
  [ "$(stat -c %u "$DIR/config" 2>/dev/null || echo 1000)" = 1000 ] && return
  docker run --rm --user root --entrypoint chown -v "$DIR/config:/config" -v "$DIR/data:/data" "$image" -R 1000:1000 /config /data >/dev/null 2>&1 \
    || log "Could not set ownership; if the container cannot write, run: sudo chown -R 1000:1000 $DIR/config $DIR/data"
}

resolve_tag() {
  if [ -n "$REF" ] && [ "$BUILD" = false ]; then TAG="${REF#v}"; return; fi
  TAG="latest"
}

main() {
  for tool in curl tar docker; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required but was not found."; done
  docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is required (docker compose). See https://docs.docker.com/compose/install/"
  docker info >/dev/null 2>&1 || die "Docker is not reachable. Start it, or run this as a user allowed to use Docker (for example with sudo)."
  mkdir -p "$DIR"; DIR="$(cd "$DIR" && pwd)"
  [ ! -f "$DIR/.compose-file" ] || die "$DIR uses an older layout (no config/ and data/ folders). See docs/single-container.md ('Moving from the first all-in-one layout') before re-running."

  if [ "$UNINSTALL" = true ]; then
    [ -f "$DIR/docker-compose.yml" ] || die "No installation found in $DIR."
    compose down
    log "Stopped and removed the container. $DIR/config and $DIR/data were kept."
    return 0
  fi

  for value in "$PORT" "$PHOSPHOR_PORT" "$TORRENT_PORT"; do
    [ -z "$value" ] || valid_port "$value" || die "Ports must be numbers between 1 and 65535."
  done
  [ -z "$ADMIN_EMAIL" ] || printf '%s' "$ADMIN_EMAIL" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' || die "That does not look like an email address."
  [ -z "$REF" ] || [[ "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ && "$REF" != *..* ]] || die "Invalid version or ref: $REF"
  [ -z "$JWT_SECRET" ] || [ "${#JWT_SECRET}" -ge 32 ] || die "--jwt-secret must be at least 32 characters (use your old JWT_SECRET)."

  FIRST=false; [ -f "$DIR/docker-compose.yml" ] || FIRST=true
  if [ -n "$IMPORT_DB" ]; then
    [ "$FIRST" = true ] && [ ! -e "$DIR/config/streamrd/streamrd.db" ] || die "--import-db only works on a first install with no existing database."
    [ -f "$IMPORT_DB" ] || die "Database file not found: $IMPORT_DB"
  fi

  mkdir -p "$DIR/config" "$DIR/data"
  touch "$DIR/.env"; chmod 600 "$DIR/.env"
  { [ "$FIRST" = true ] || [ "$REFRESH_COMPOSE" = true ]; } && write_compose
  set_env STREAMRD_PORT "${PORT:-8080}" "$([ -n "$PORT" ] && echo yes || echo no)"
  set_env PHOSPHOR_PORT "${PHOSPHOR_PORT:-8081}" "$([ -n "$PHOSPHOR_PORT" ] && echo yes || echo no)"
  set_env TORRENT_PORT "${TORRENT_PORT:-6881}" "$([ -n "$TORRENT_PORT" ] && echo yes || echo no)"
  [ -z "$ADMIN_EMAIL" ] || set_env ADMIN_EMAIL "$ADMIN_EMAIL" yes
  [ -z "$PHOSPHOR" ] || set_env ENABLE_PHOSPHOR "$PHOSPHOR" yes
  [ -z "$QBIT" ] || set_env ENABLE_QBITTORRENT "$QBIT" yes
  [ -z "$JWT_SECRET" ] || set_env STREAMRD_JWT_SECRET "$JWT_SECRET" yes

  # Optional add-ons: each is an overlay file named in COMPOSE_FILE, so a plain `docker compose pull && up -d` keeps them.
  local use_zilean=false use_zurg=false
  [ "$ZILEAN" = on ] && use_zilean=true
  [ -z "$ZILEAN" ] && env_value COMPOSE_FILE | grep -q zilean && use_zilean=true
  [ "$ZURG" = on ] && use_zurg=true
  [ -z "$ZURG" ] && env_value COMPOSE_FILE | grep -q zurg && use_zurg=true
  if [ "$use_zilean" = true ]; then
    write_zilean
    [ -n "$(env_value ZILEAN_DB_PASSWORD)" ] || set_env ZILEAN_DB_PASSWORD "$( (openssl rand -hex 16 2>/dev/null) || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  if [ "$use_zurg" = true ]; then write_zurg; prepare_zurg_mount; fi
  local files="docker-compose.yml"
  [ "$use_zilean" = true ] && files="$files:docker-compose.zilean.yml"
  [ "$use_zurg" = true ] && files="$files:docker-compose.zurg.yml"
  if [ "$files" = "docker-compose.yml" ]; then drop_env COMPOSE_FILE; else set_env COMPOSE_FILE "$files" yes; fi

  # Image: a published release (pull), or built from source (--build / --ref / no published image).
  local mode=pull TAG; resolve_tag
  if [ "$BUILD" = true ]; then mode=build; fi
  if [ "$mode" = pull ]; then
    set_env STREAMRD_IMAGE "$REGISTRY_IMAGE" yes; set_env STREAMRD_TAG "$TAG" yes
    if ! docker pull "$REGISTRY_IMAGE:$TAG" >/dev/null 2>&1; then
      log "The published image $REGISTRY_IMAGE:$TAG could not be pulled (not published yet, or the package is private); building from source instead."
      mode=build; [ -n "$REF" ] || REF="main"
    fi
  fi
  if [ "$mode" = build ]; then
    [ -n "$REF" ] || REF="main"
    log "Building from $REF (this takes a few minutes)..."
    rm -rf "$DIR/src.new"; mkdir -p "$DIR/src.new"
    curl -fsSL "$ARCHIVE_BASE/$REF.tar.gz" | tar -xz -C "$DIR/src.new" --strip-components=1
    [ -f "$DIR/src.new/Dockerfile" ] || { rm -rf "$DIR/src.new"; die "$REF does not contain the all-in-one image."; }
    rm -rf "$DIR/src"; mv "$DIR/src.new" "$DIR/src"
    docker build -t streamrd-all-in-one:local "$DIR/src"
    set_env STREAMRD_IMAGE "streamrd-all-in-one" yes; set_env STREAMRD_TAG "local" yes
  fi
  local image="$(env_value STREAMRD_IMAGE):$(env_value STREAMRD_TAG)"
  own_folders "$image"
  if [ -n "$IMPORT_DB" ]; then
    mkdir -p "$DIR/config/streamrd"; cp "$IMPORT_DB" "$DIR/config/streamrd/streamrd.db"; chmod 600 "$DIR/config/streamrd/streamrd.db"
    [ "$(id -u)" != 0 ] || chown -R 1000:1000 "$DIR/config"
    log "Imported your database. It is upgraded (with a verified snapshot first) when the container starts."
  fi

  if [ "$START" = false ]; then
    log "Ready. Start it with: cd $DIR && docker compose up -d"
    return 0
  fi

  if [ -z "$(compose ps -q 2>/dev/null)" ]; then
    for name in STREAMRD_PORT PHOSPHOR_PORT TORRENT_PORT; do
      local p; p="$(env_value "$name")"
      ! port_busy "$p" || die "Port $p is already in use. Re-run with --port, --phosphor-port or --torrent-port to choose another."
    done
  fi
  [ "$mode" = build ] || compose pull
  if [ "$ZILEAN" = off ] || [ "$ZURG" = off ]; then compose up -d --remove-orphans; else compose up -d; fi

  local web; web="$(env_value STREAMRD_PORT)"
  log "Waiting for StreamRD to become ready..."
  for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$web/login" 2>/dev/null; then ready=true; break; fi
    sleep 2
  done
  [ "${ready:-false}" = true ] || die "The container started but StreamRD did not answer in time. Check: cd $DIR && docker compose logs"

  cat <<EOF

StreamRD is running.
  StreamRD   http://localhost:$web
  Phosphor   http://localhost:$(env_value PHOSPHOR_PORT)   (set ENABLE_PHOSPHOR=false in .env to turn it off)

Create your account on the StreamRD page$( [ -n "$(env_value ADMIN_EMAIL)" ] && echo " with $(env_value ADMIN_EMAIL), which is reserved for the first administrator." || echo "; the first account becomes the administrator." )
Put a reverse proxy with HTTPS in front before exposing it to the internet.

  Folder     $DIR
  Settings   $DIR/config   (database, secrets, backups: back this up)
  Downloads  $DIR/data
  Update     cd $DIR && docker compose pull && docker compose up -d     (or re-run get.sh)
  Logs       cd $DIR && docker compose logs -f
  Remove     bash get.sh --uninstall --dir $DIR   (config/ and data/ are kept)
$(addon_notes)
EOF
}
addon_notes() {
  env_value COMPOSE_FILE | grep -q zilean && echo "  Zilean     internal only; it appears in Phosphor as the 'Zilean' indexer (its first import takes a while)"
  env_value COMPOSE_FILE | grep -q zurg && echo "  Zurg       your Real-Debrid movies and shows are mounted at $DIR/mnt/zurg (edit zurg/config.yml, then: docker compose restart zurg)"
  return 0
}
# Everything runs through one function so a truncated download cannot execute half a script.
main "$@"
