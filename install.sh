#!/usr/bin/env bash
# StreamRD one-command installer (all-in-one container; Phosphor is optional: --phosphor), laid out as:
#
#   ~/streamrd/docker-compose.yml   the container definition
#   ~/streamrd/.env                 ports and the image tag
#   ~/streamrd/config/              settings, databases, secrets, backups  -> /config
#   ~/streamrd/data/                downloads and media                     -> /data
#
#   curl -fsSL https://raw.githubusercontent.com/Installation-04/StreamRD/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Installation-04/StreamRD/main/install.sh | bash -s -- --port 3000 --admin-email you@example.com
#
# Run from a terminal on a first install it asks how you want it (default or advanced: ports, Phosphor, the
# download client, Jellyfin and/or Plex already wired to your libraries, Zilean, Zurg). Any option on the command line
# skips that question, and --yes (or no terminal, e.g. CI) skips all of them and uses the defaults.
#
# Updating = running it again (or `docker compose pull && docker compose up -d` in that folder):
# it pulls the newer image and recreates the container. config/ and data/ are never touched.
# It needs Docker with the Compose plugin plus curl and tar. On Linux, whatever is missing is installed for you (Docker's own
# installation script, or your distribution's packages), and Docker is started and set to start with the machine; that is the only
# thing that needs root (through sudo). --no-install-docker installs nothing and only says what is missing. Read it before piping it to a shell:
# https://github.com/Installation-04/StreamRD/blob/main/install.sh
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
MEDIA_MANAGER=""; MEDIA_SERVER=""; JELLYFIN_PORT=""; PLEX_PORT=""; PLEX_CLAIM="${PLEX_CLAIM:-}"; ASSUME_YES=false; ADVANCED=false
NO_INSTALL=false; PREPARE_ONLY=false; [ "${STREAMRD_NO_INSTALL_DOCKER:-}" != 1 ] || NO_INSTALL=true

log() { printf '[streamrd] %s\n' "$*"; }
die() { printf '[streamrd] ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<EOF
Usage: install.sh [options]

  --dir PATH             Install directory (default: \$HOME/streamrd)
  --version vX.Y.Z       Release to run (default: latest)
  --ref NAME             Build from this branch or tag instead of pulling an image
  --port N               StreamRD web port (default 8080, kept on re-runs)
  --phosphor-port N      Phosphor web port (default 8081)
  --torrent-port N       qBittorrent peer port (default 6881)
  --admin-email EMAIL    Reserve the first administrator account for this address
  --phosphor             Run Phosphor too (the indexer search and download companion; it is off unless asked for)
  --no-phosphor          Do not run Phosphor (this is already the default for a new install)
  --no-qbittorrent       Do not run the bundled qBittorrent client
  --zilean               Also run Zilean (a Debrid Media Manager torrent index) and add it to Phosphor as an indexer
  --no-zilean            Stop running Zilean (its data volumes are kept)
  --zurg                 Also run Zurg + rclone, mounting your Real-Debrid movies and shows at ./mnt/zurg (Linux only)
  --rd-token TOKEN       Real-Debrid API token for Zurg (or set RD_TOKEN); stored only in zurg/config.yml
  --no-zurg              Stop running Zurg (its config is kept)
  --media-server NAME    Also run Jellyfin and/or Plex, already pointed at your StreamRD and Phosphor libraries:
                         jellyfin, plex, both, or none (stops them; their settings are kept)
  --jellyfin-port N      Jellyfin web port (default 8096)
  --plex-port N          Plex web port (default 32400)
  --plex-claim TOKEN     Plex claim token from https://plex.tv/claim (valid 4 minutes; optional)
  --media-manager        (the default) Docker control: let StreamRD start Plex and Jellyfin, update itself and restart from its web pages.
                         StreamRD's container is given Docker's socket; inside it one small helper, run apart from StreamRD, is the
                         only thing that opens it, and it can do only those things. An install that had the helper in a second
                         container is moved to this one. Read docs/plex-jellyfin.md ("Docker control") first if the server is public
  --no-media-manager     Turn Docker control off: the container gets no socket and nothing in it runs as root
                         (media servers already started are kept; stop them from Setup first)
  --no-install-docker    Do not install what is missing (Docker Engine, the Compose plugin, curl, tar): stop and say what to install.
                         Without it they are installed on Linux, after one question in a terminal; --yes asks nothing
                         (STREAMRD_NO_INSTALL_DOCKER=1 does the same)
  --prepare              Install and start what this machine needs (Docker, the Compose plugin, curl, tar), then stop
  -y, --yes              Do not ask questions; use the defaults and the options given
  --advanced             Ask every question even though options were given
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
    --phosphor) PHOSPHOR=true; shift ;;
    --no-phosphor) PHOSPHOR=false; shift ;;
    --no-qbittorrent) QBIT=false; shift ;;
    --zilean) ZILEAN=on; shift ;;
    --no-zilean) ZILEAN=off; shift ;;
    --zurg) ZURG=on; shift ;;
    --no-zurg) ZURG=off; shift ;;
    --no-install-docker) NO_INSTALL=true; shift ;;
    --prepare) PREPARE_ONLY=true; shift ;;
    --media-manager) MEDIA_MANAGER=on; shift ;;
    --no-media-manager) MEDIA_MANAGER=off; shift ;;
    --media-server) MEDIA_SERVER="${2:?--media-server needs jellyfin, plex, both or none}"; shift 2 ;;
    --jellyfin-port) JELLYFIN_PORT="${2:?--jellyfin-port needs a number}"; shift 2 ;;
    --plex-port) PLEX_PORT="${2:?--plex-port needs a number}"; shift 2 ;;
    --plex-claim) PLEX_CLAIM="${2:?--plex-claim needs a token}"; shift 2 ;;
    -y|--yes) ASSUME_YES=true; shift ;;
    --advanced) ADVANCED=true; shift ;;
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
# Generated by install.sh. Your settings live in .env; config/ holds all state and data/ your downloads.
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
      # Phosphor is off unless you set ENABLE_PHOSPHOR=true. Left empty, a folder that already holds Phosphor's data keeps it running.
      ENABLE_PHOSPHOR: ${ENABLE_PHOSPHOR:-}
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

# Jellyfin and Plex run as add-ons next to StreamRD. Both already see everything they need, mapped like this:
#   /library/streamrd, /library/phosphor   the Movies / TV Shows folders StreamRD and Phosphor export (read-only)
#   /data                                  your downloads, at the same path StreamRD uses, so the links resolve
#   /mnt/zurg                              your Real-Debrid mount, when Zurg is on (same path again)
# Their own settings live in config/jellyfin and config/plex, so backing up config/ keeps them too.
write_jellyfin() {
  cat > "$DIR/docker-compose.jellyfin.yml" <<EOF
# Jellyfin, pre-mapped to the libraries StreamRD and Phosphor export. In Jellyfin add Movies -> /library/streamrd/Movies and
# Shows -> "/library/streamrd/TV Shows" (and the same under /library/phosphor if you use Phosphor's exports).
services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    container_name: jellyfin
    restart: unless-stopped
    user: "1000:1000"
    ports:
      - "\${JELLYFIN_PORT:-8096}:8096"
    environment:
      TZ: \${TZ:-UTC}
    volumes:
      - ./config/jellyfin/config:/config
      - ./config/jellyfin/cache:/cache
      - ./config/streamrd/library:/library/streamrd:ro
      - ./config/phosphor/library:/library/phosphor:ro
      - ./data:/data:ro
$( [ "$1" = zurg ] && echo "      - ./mnt/zurg:/mnt/zurg:ro,rslave" )
    labels:
      com.centurylinklabs.watchtower.enable: "true"
EOF
}

write_plex() {
  cat > "$DIR/docker-compose.plex.yml" <<EOF
# Plex, pre-mapped to the libraries StreamRD and Phosphor export. In Plex add Movies -> /library/streamrd/Movies and
# TV Shows -> "/library/streamrd/TV Shows" (and the same under /library/phosphor if you use Phosphor's exports).
services:
  plex:
    image: plexinc/pms-docker:latest
    container_name: plex
    restart: unless-stopped
    ports:
      - "\${PLEX_PORT:-32400}:32400"
    environment:
      TZ: \${TZ:-UTC}
      PLEX_UID: "1000"
      PLEX_GID: "1000"
      PLEX_CLAIM: \${PLEX_CLAIM:-}
    volumes:
      - ./config/plex/config:/config
      - ./config/plex/transcode:/transcode
      - ./config/streamrd/library:/library/streamrd:ro
      - ./config/phosphor/library:/library/phosphor:ro
      - ./data:/data:ro
$( [ "$1" = zurg ] && echo "      - ./mnt/zurg:/mnt/zurg:ro,rslave" )
    labels:
      com.centurylinklabs.watchtower.enable: "true"
EOF
}

# Question helpers. They read from the terminal, so they also work when the script is piped from curl.
have_terminal() { [ -t 1 ] && { : </dev/tty; } 2>/dev/null; }
say() { printf '%s\n' "$*" >/dev/tty; }
# ask "Question" "default" -> sets REPLY
ask() {
  local prompt="$1" default="${2:-}" shown=""
  [ -z "$default" ] || shown=" [$default]"
  printf '  %s%s: ' "$prompt" "$shown" >/dev/tty
  IFS= read -r REPLY </dev/tty || REPLY=""
  [ -n "$REPLY" ] || REPLY="$default"
}
# confirm "Question" y|n -> returns 0 for yes
confirm() {
  local default="${2:-y}" hint="Y/n"; [ "$default" = n ] && hint="y/N"
  while true; do
    printf '  %s [%s]: ' "$1" "$hint" >/dev/tty
    IFS= read -r REPLY </dev/tty || REPLY=""
    REPLY="${REPLY:-$default}"
    case "$REPLY" in [Yy]*) return 0 ;; [Nn]*) return 1 ;; *) say "  Please answer y or n." ;; esac
  done
}
# ask_port "What it is" default -> sets REPLY to a free, valid port
ask_port() {
  while true; do
    ask "$1" "$2"
    if ! valid_port "$REPLY"; then say "  Enter a number between 1 and 65535."
    elif port_busy "$REPLY" && [ -z "$(compose ps -q 2>/dev/null)" ]; then say "  Port $REPLY is already in use on this machine; choose another."
    else return 0; fi
  done
}

# The "helper" flow: Default or Advanced, then a summary to confirm. Only asks about what was not set by an option.
wizard() {
  say ""
  say "  StreamRD installer"
  say "  ------------------"
  say "  1) Default   StreamRD on 8080 and the bundled download client, in $DIR"
  say "  2) Advanced  choose ports, folder, Jellyfin / Plex, Zilean, Zurg and more"
  say "  3) Cancel"
  local choice=""
  while true; do
    ask "Choose" "1"; choice="$REPLY"
    case "$choice" in 1|2|3) break ;; *) say "  Enter 1, 2 or 3." ;; esac
  done
  [ "$choice" != 3 ] || { say "  Cancelled. Nothing was changed."; exit 0; }
  [ "$choice" = 2 ] || return 0

  ask "Install folder" "$DIR"; DIR="$REPLY"
  [ -n "$PORT" ] || { ask_port "StreamRD web port" 8080; PORT="$REPLY"; }
  if [ -z "$PHOSPHOR" ]; then
    if confirm "Run Phosphor too (search your indexers and queue downloads)?" n; then
      PHOSPHOR=true
      [ -n "$PHOSPHOR_PORT" ] || { ask_port "Phosphor web port" 8081; PHOSPHOR_PORT="$REPLY"; }
    else PHOSPHOR=false; fi
  fi
  if [ -z "$QBIT" ]; then
    if confirm "Run the bundled qBittorrent download client?" y; then
      QBIT=true
      [ -n "$TORRENT_PORT" ] || { ask_port "qBittorrent peer port" 6881; TORRENT_PORT="$REPLY"; }
    else QBIT=false; fi
  fi
  if [ -z "$MEDIA_SERVER" ]; then
    say ""
    say "  Media server: Jellyfin or Plex can be installed already pointed at your libraries."
    say "  1) None   2) Jellyfin   3) Plex   4) Both   5) Start them later from StreamRD's Setup page, one click (recommended)"
    while true; do
      ask "Choose" "5"
      case "$REPLY" in 1) MEDIA_SERVER=none ;; 2) MEDIA_SERVER=jellyfin ;; 3) MEDIA_SERVER=plex ;; 4) MEDIA_SERVER=both ;; 5) MEDIA_SERVER=none; MEDIA_MANAGER=on ;; *) say "  Enter 1, 2, 3, 4 or 5."; continue ;; esac
      break
    done
  fi
  case "$MEDIA_SERVER" in jellyfin|both) [ -n "$JELLYFIN_PORT" ] || { ask_port "Jellyfin web port" 8096; JELLYFIN_PORT="$REPLY"; } ;; esac
  case "$MEDIA_SERVER" in plex|both)
    [ -n "$PLEX_PORT" ] || { ask_port "Plex web port" 32400; PLEX_PORT="$REPLY"; }
    if [ -z "$PLEX_CLAIM" ]; then
      say "  Optional: a Plex claim token links the server to your Plex account on first start (https://plex.tv/claim, valid 4 minutes)."
      ask "Plex claim token (Enter to skip)" ""; PLEX_CLAIM="$REPLY"
    fi ;;
  esac
  if [ -z "$ZILEAN" ] && [ "$PHOSPHOR" = true ] && confirm "Run Zilean (a torrent index) and add it to Phosphor?" n; then ZILEAN=on; fi
  if [ -z "$ZURG" ] && [ "$(uname -s)" = Linux ] && confirm "Mount your Real-Debrid movies and shows with Zurg (Linux only)?" n; then
    ZURG=on
    if [ -z "$RD_TOKEN" ]; then
      printf '  Real-Debrid API token (https://real-debrid.com/apitoken; not shown): ' >/dev/tty
      IFS= read -rs RD_TOKEN </dev/tty || RD_TOKEN=""; printf '\n' >/dev/tty
    fi
  fi
  if [ -z "$ADMIN_EMAIL" ]; then
    ask "Reserve the first administrator account for this email (Enter to skip)" ""; ADMIN_EMAIL="$REPLY"
  fi

  say ""
  say "  Summary"
  say "    Folder        $DIR"
  say "    StreamRD      port ${PORT:-8080}"
  say "    Phosphor      ${PHOSPHOR:-false}$([ "$PHOSPHOR" = true ] && [ -n "$PHOSPHOR_PORT" ] && echo " (port $PHOSPHOR_PORT)")"
  say "    qBittorrent   ${QBIT:-true}${TORRENT_PORT:+ (port $TORRENT_PORT)}"
  say "    Media server  ${MEDIA_SERVER:-none}"
  say "    Zilean / Zurg ${ZILEAN:-off} / ${ZURG:-off}"
  say ""
  confirm "Install with these settings?" y || { say "  Cancelled. Nothing was changed."; exit 0; }
}

# Docker control: StreamRD's own container is given Docker's socket and starts as root, so that one small helper inside it (kept apart
# from StreamRD, which still runs as user 1000) can start Plex and Jellyfin, update StreamRD and restart it from the web pages.
# Installs made before v0.24.0 ran that helper in a second container (docker-compose.manager.yml); they are moved to this.
write_control() {
  cat > "$DIR/docker-compose.control.yml" <<'EOF'
# Docker control: lets StreamRD start Plex and Jellyfin, update itself and restart from its web pages.
# The container starts as root only so that one small helper inside it can be kept apart from StreamRD: the helper alone opens
# Docker's socket; StreamRD and everything it runs stay user 1000. Turn it off with: install.sh --no-media-manager
# See docs/plex-jellyfin.md ("Docker control").
services:
  streamrd:
    user: "0:0"
    security_opt:
      - no-new-privileges:true
    volumes:
      - ${DOCKER_SOCKET_PATH:-/var/run/docker.sock}:/var/run/docker.sock
EOF
}
# Where Docker's socket is on this machine. Rootless Docker keeps it in the user's runtime folder; everything else uses the usual path
# (Docker Desktop included, where the path is the one inside its virtual machine).
docker_socket_path() {
  local host=""
  if docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then
    host="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)}"
    case "$host" in unix://*) printf '%s' "${host#unix://}"; return 0 ;; esac
  fi
  printf '/var/run/docker.sock'
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
      Zilean__Database__ConnectionString: "Host=zilean-db;Database=zilean;Username=postgres;Password=${ZILEAN_DB_PASSWORD:?run install.sh --zilean};Timeout=30;CommandTimeout=3600"
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
      POSTGRES_PASSWORD: ${ZILEAN_DB_PASSWORD:?run install.sh --zilean}
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
# Needs a Linux host with FUSE; the mount folder must be a shared mount (install.sh sets that up when run as root).
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
  if [ ! -e /dev/fuse ]; then
    if [ -n "$PM" ] && allow_install "Zurg mounts Real-Debrid through FUSE, which this machine does not have (/dev/fuse is missing)."; then
      log "Installing FUSE..."; pkg_install fuse3 || true; as_root modprobe fuse >/dev/null 2>&1 || true
    fi
    [ -e /dev/fuse ] || die "/dev/fuse is missing; install FUSE on the host (for example: apt install fuse3) and run this again."
  fi
  if findmnt -n --mountpoint "$target" -o PROPAGATION 2>/dev/null | grep -q shared; then return 0; fi
  root_available || die "Run these once as root, then re-run install.sh:  sudo mount --bind $target $target && sudo mount --make-rshared $target"
  mountpoint -q "$target" || as_root mount --bind "$target" "$target"
  as_root mount --make-rshared "$target"
}


# The container runs as UID 1000; make sure it can write the two folders.
own_folders() {
  local image="$1"
  if [ "$(id -u)" = 0 ]; then chown -R 1000:1000 "$DIR/config" "$DIR/data"; return; fi
  [ "$(stat -c %u "$DIR/config" 2>/dev/null || echo 1000)" = 1000 ] && return
  docker run --rm --user root --entrypoint chown -v "$DIR/config:/config" -v "$DIR/data:/data" "$image" -R 1000:1000 /config /data >/dev/null 2>&1 \
    || log "Could not set ownership; if the container cannot write, run: sudo chown -R 1000:1000 $DIR/config $DIR/data"
}

# Create folders under config/ that the media servers mount, owned by the container user. If they were created by Docker
# instead (as root) the apps could not write to them.
ensure_dirs() {
  local image="$1" dir missing=""; shift
  for dir in "$@"; do mkdir -p "$DIR/config/$dir" 2>/dev/null || missing="$missing /config/$dir"; done
  [ -z "$missing" ] || docker run --rm --user root --entrypoint sh -v "$DIR/config:/config" "$image" -c "mkdir -p $missing && chown -R 1000:1000 /config" >/dev/null 2>&1 \
    || log "Could not create$missing; run: sudo mkdir -p $DIR/config/... && sudo chown -R 1000:1000 $DIR/config"
}

# ---- The host: the tools the installer needs, and Docker itself ---------------------------------------------------------------------
# One command should be enough on a bare machine, so what is missing is installed: curl and tar, then Docker Engine with the Compose plugin
# (Docker's own installation script, or the distribution's packages where that script does not support the system), and Docker is started
# and set to start with the machine. Someone at a terminal is asked once first; --yes, or no terminal, goes ahead; --no-install-docker
# installs nothing and only says what is missing. Everything that needs root runs directly (as root) or through sudo. Nobody is added to the
# docker group (that would hand them root): when Docker answers only to root, the installer runs it through sudo instead.
DOCKER_SCRIPT_URL="${STREAMRD_DOCKER_SCRIPT_URL:-https://get.docker.com}"
COMPOSE_BASE="${STREAMRD_COMPOSE_BASE:-https://github.com/docker/compose/releases/latest/download}"
COMPOSE_DIR="${STREAMRD_COMPOSE_DIR:-/usr/local/lib/docker/cli-plugins}"
DOCKER_DOCS="https://docs.docker.com/engine/install/"
INSTALL_OK=""; DOCKER_PREFIX=""; PM=""

pkg_manager() {
  local name
  for name in apt-get dnf yum zypper pacman apk; do
    if command -v "$name" >/dev/null 2>&1; then printf '%s' "$name"; return 0; fi
  done
  return 1
}
# Installs packages with the machine's package manager, without questions.
pkg_install() {
  case "$PM" in
    apt-get) as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq && as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
    dnf|yum) as_root "$PM" install -y -q "$@" ;;
    zypper) as_root zypper --non-interactive --quiet install "$@" ;;
    pacman) as_root pacman -S --noconfirm --needed "$@" ;;
    apk) as_root apk add --no-cache "$@" ;;
    *) return 1 ;;
  esac
}
# Whether something that needs root can be run: as root, with a sudo that works without a password, or with one that can ask for it.
root_available() {
  [ "$(id -u)" = 0 ] && return 0
  command -v sudo >/dev/null 2>&1 || return 1
  sudo -n true >/dev/null 2>&1 && return 0
  have_terminal
}
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else die "That needs root, and sudo is not installed. Run this as root (for example: su -c 'bash install.sh'), or install what is missing yourself ($DOCKER_DOCS)."
  fi
}
# allow_install "what is missing": succeeds when it may be installed now. A person at a terminal is asked once; otherwise it goes ahead.
allow_install() {
  [ "$NO_INSTALL" = false ] || return 1
  root_available || die "$1 Installing it needs root, and this is neither root nor a user whose sudo works from here. Run this as root (for example: su -c 'bash install.sh'), or install what is missing yourself ($DOCKER_DOCS)."
  if [ -z "$INSTALL_OK" ]; then
    if [ "$ASSUME_YES" = false ] && have_terminal; then
      if confirm "$1 Install it now? (It needs root; sudo may ask for your password.)" y; then INSTALL_OK=yes; else INSTALL_OK=no; fi
    else INSTALL_OK=yes; fi
  fi
  [ "$INSTALL_OK" = yes ]
}
ensure_tools() {
  local missing="" tool
  for tool in curl tar; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
  [ -n "$missing" ] || return 0
  [ -n "$PM" ] || die "Needed and not found:$missing. Install them with your system's package manager and run this again."
  allow_install "Needed and not found:$missing." || die "Needed and not found:$missing. Install them with your system's package manager, or run this again without --no-install-docker."
  log "Installing$missing..."
  pkg_install $missing ca-certificates || die "Could not install$missing. Install them yourself and run this again."
  for tool in $missing; do command -v "$tool" >/dev/null 2>&1 || die "$tool is still missing after installing it."; done
}
# Docker's own installation script (it supports Debian, Ubuntu, Raspberry Pi OS, Fedora, CentOS and RHEL and their relatives).
docker_script() {
  local script; script="$(mktemp)"
  if curl -fsSL "$DOCKER_SCRIPT_URL" -o "$script" && as_root sh "$script"; then rm -f "$script"; return 0; fi
  rm -f "$script"; log "Docker's installation script did not finish on this system."; return 1
}
docker_packages() {
  case "$PM" in
    apt-get) pkg_install docker.io ;;
    dnf|yum) pkg_install docker || pkg_install moby-engine ;;
    zypper) pkg_install docker ;;
    pacman) pkg_install docker docker-compose ;;
    apk) pkg_install docker docker-cli-compose ;;
    *) return 1 ;;
  esac
}
# Starts the Docker service and sets it to start with the machine, whichever init system there is. Best effort: the caller checks that it answers.
start_docker_service() {
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    as_root systemctl enable --now docker >/dev/null 2>&1 || as_root systemctl start docker >/dev/null 2>&1 || true
  elif command -v rc-service >/dev/null 2>&1; then
    as_root rc-update add docker boot >/dev/null 2>&1 || true; as_root rc-service docker start >/dev/null 2>&1 || true
  elif command -v service >/dev/null 2>&1; then
    as_root service docker start >/dev/null 2>&1 || true
  fi
}
install_docker() {
  log "Installing Docker Engine with the Compose plugin..."
  local done=false
  case "$PM" in
    apt-get|dnf|yum|zypper) log "Using Docker's installation script ($DOCKER_SCRIPT_URL)."; if docker_script; then done=true; fi ;;
  esac
  if [ "$done" = false ]; then
    log "Installing the distribution's own Docker packages."
    docker_packages || die "Docker could not be installed here. Install Docker Engine with the Compose plugin ($DOCKER_DOCS) and run this again."
  fi
  start_docker_service
  command -v docker >/dev/null 2>&1 || die "Docker was installed but the docker command was not found. Open a new terminal and run this again."
}
# The Compose plugin from Docker's release page, accepted only if it matches the checksum published beside it.
compose_binary() {
  local arch name tmp hash
  case "$(uname -m)" in x86_64|amd64) arch=x86_64 ;; aarch64|arm64) arch=aarch64 ;; armv7l|armv7) arch=armv7 ;; armv6l) arch=armv6 ;; *) return 1 ;; esac
  name="docker-compose-linux-$arch"; tmp="$(mktemp -d)"
  if curl -fsSL "$COMPOSE_BASE/$name" -o "$tmp/$name" && curl -fsSL "$COMPOSE_BASE/checksums.txt" -o "$tmp/checksums.txt"; then
    hash="$(grep -E " \*?$name\$" "$tmp/checksums.txt" | head -n1 | cut -d' ' -f1 || true)"
    if [ -n "$hash" ] && [ "$(sha256sum "$tmp/$name" | cut -d' ' -f1)" = "$hash" ]; then
      if as_root install -D -m 0755 "$tmp/$name" "$COMPOSE_DIR/docker-compose"; then rm -rf "$tmp"; return 0; fi
    else
      log "The Compose plugin that was downloaded did not match its published checksum, so it was not installed."
    fi
  fi
  rm -rf "$tmp"; return 1
}
install_compose() {
  log "Installing the Docker Compose plugin..."
  case "$PM" in
    apt-get) pkg_install docker-compose-plugin >/dev/null 2>&1 || pkg_install docker-compose-v2 >/dev/null 2>&1 || true ;;
    dnf|yum) pkg_install docker-compose-plugin >/dev/null 2>&1 || pkg_install docker-compose >/dev/null 2>&1 || true ;;
    zypper|pacman) pkg_install docker-compose >/dev/null 2>&1 || true ;;
    apk) pkg_install docker-cli-compose >/dev/null 2>&1 || true ;;
  esac
  if docker compose version >/dev/null 2>&1; then return 0; fi
  if compose_binary && docker compose version >/dev/null 2>&1; then return 0; fi
  die "The Docker Compose plugin could not be installed. See https://docs.docker.com/compose/install/linux/ and run this again."
}
# Docker answers only to root here (the user is not in the docker group): run it through sudo for the rest of this run.
use_sudo_for_docker() {
  [ "$(id -u)" != 0 ] || return 1
  command -v sudo >/dev/null 2>&1 || return 1
  sudo docker info >/dev/null 2>&1 || return 1
  docker() { sudo docker "$@"; }
  DOCKER_PREFIX="sudo "
  log "Docker answers only to root on this machine, so the installer runs it with sudo (you are not added to the docker group)."
  return 0
}
ensure_docker_running() {
  local out="" waited=0
  if out="$(docker info 2>&1)"; then return 0; fi
  case "$out" in *ermission*denied*) if use_sudo_for_docker; then return 0; fi ;; esac
  if [ "$(uname -s)" = Linux ] && [ -z "${DOCKER_HOST:-}" ]; then
    [ "$NO_INSTALL" = false ] || die "Docker is installed but is not running. Start it (for example: sudo systemctl start docker) and run this again."
    root_available || die "Docker is installed but is not running, and starting it needs root. Start it (for example: sudo systemctl start docker) and run this again."
    log "Docker is not running; starting it..."
    start_docker_service
    while [ "$waited" -lt 45 ]; do
      if out="$(docker info 2>&1)"; then return 0; fi
      case "$out" in *ermission*denied*) if use_sudo_for_docker; then return 0; fi; break ;; esac
      sleep 1; waited=$((waited + 1))
    done
  fi
  die "Docker is installed but cannot be reached ($(printf '%s' "$out" | head -n1)). Start it, or run this as a user allowed to use Docker, and run this again."
}
# Everything the installer needs from the machine, installing what is missing (Linux) unless told not to.
prepare_host() {
  local os; os="$(uname -s)"
  PM="$(pkg_manager || true)"
  ensure_tools
  if ! command -v docker >/dev/null 2>&1; then
    case "$os" in
      Linux) ;;
      Darwin) die "Docker is not installed. On a Mac, install Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/) or Colima, start it, and run this again." ;;
      *) die "Docker is not installed. On Windows, install Docker Desktop with the WSL 2 backend and run this installer from a WSL terminal (https://docs.docker.com/desktop/setup/install/windows-install/)." ;;
    esac
    allow_install "Docker is not installed." || die "Docker is not installed. Install Docker Engine with the Compose plugin ($DOCKER_DOCS), or run this again without --no-install-docker."
    install_docker
  fi
  if ! docker compose version >/dev/null 2>&1; then
    [ "$os" = Linux ] || die "The Docker Compose plugin is required (docker compose). See https://docs.docker.com/compose/install/"
    allow_install "The Docker Compose plugin is not installed." || die "The Docker Compose plugin is required (docker compose). See https://docs.docker.com/compose/install/linux/, or run this again without --no-install-docker."
    install_compose
  fi
  ensure_docker_running
}

resolve_tag() {
  if [ -n "$REF" ] && [ "$BUILD" = false ]; then TAG="${REF#v}"; return; fi
  TAG="latest"
}

main() {
  [ "$UNINSTALL" = false ] || NO_INSTALL=true   # removing what is installed never installs anything
  prepare_host
  if [ "$PREPARE_ONLY" = true ]; then
    log "This machine is ready: Docker, the Compose plugin, curl and tar are installed, and Docker is running. Run install.sh again, without --prepare, to install StreamRD."
    return 0
  fi
  DIR="${DIR/#\~/$HOME}"
  if [ "$ASSUME_YES" = false ] && [ "$UNINSTALL" = false ] && have_terminal && { [ ! -f "$DIR/docker-compose.yml" ] || [ "$ADVANCED" = true ]; }; then
    wizard; DIR="${DIR/#\~/$HOME}"
  fi
  mkdir -p "$DIR"; DIR="$(cd "$DIR" && pwd)"
  [ ! -f "$DIR/.compose-file" ] || die "$DIR uses an older layout (no config/ and data/ folders). See docs/single-container.md ('Moving from the first all-in-one layout') before re-running."

  if [ "$UNINSTALL" = true ]; then
    [ -f "$DIR/docker-compose.yml" ] || die "No installation found in $DIR."
    compose down
    log "Stopped and removed the container. $DIR/config and $DIR/data were kept."
    return 0
  fi

  case "$MEDIA_SERVER" in ""|jellyfin|plex|both|none) ;; *) die "--media-server must be jellyfin, plex, both or none." ;; esac
  for value in "$PORT" "$PHOSPHOR_PORT" "$TORRENT_PORT" "$JELLYFIN_PORT" "$PLEX_PORT"; do
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
  set_env JELLYFIN_PORT "${JELLYFIN_PORT:-8096}" "$([ -n "$JELLYFIN_PORT" ] && echo yes || echo no)"
  set_env PLEX_PORT "${PLEX_PORT:-32400}" "$([ -n "$PLEX_PORT" ] && echo yes || echo no)"
  [ -z "$PLEX_CLAIM" ] || set_env PLEX_CLAIM "$PLEX_CLAIM" yes
  [ -z "$ADMIN_EMAIL" ] || set_env ADMIN_EMAIL "$ADMIN_EMAIL" yes
  # Phosphor is off for a new install unless it was asked for. An installation that was already running it keeps it: its settings
  # file is written from what it was running, so it is not switched off by this change (or by --refresh-compose).
  if [ -n "$PHOSPHOR" ]; then set_env ENABLE_PHOSPHOR "$PHOSPHOR" yes
  elif [ "$FIRST" = true ]; then set_env ENABLE_PHOSPHOR false
  else set_env ENABLE_PHOSPHOR true; fi
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
  [ "$use_zilean" != true ] || [ "$(env_value ENABLE_PHOSPHOR)" != false ] || log "Zilean is added to Phosphor, which is not running. Run Phosphor too with --phosphor."
  local use_jellyfin=false use_plex=false
  case "$MEDIA_SERVER" in
    jellyfin) use_jellyfin=true ;; plex) use_plex=true ;; both) use_jellyfin=true; use_plex=true ;; none) ;;
    *) env_value COMPOSE_FILE | grep -q jellyfin && use_jellyfin=true; env_value COMPOSE_FILE | grep -q plex && use_plex=true ;;
  esac
  local zurg_flag=none; [ "$use_zurg" = true ] && zurg_flag=zurg
  local use_manager=false
  # Docker control is part of every install unless it was declined, so Plex and Jellyfin start from StreamRD's Setup page and the Update
  # and Restart buttons work with no extra step. Declined means: --no-media-manager, or "no" to the question below; older installers
  # recorded only that the question had been asked. An install with the helper in a second container counts as having it, and is moved.
  local has_manager=false declined=false separate=false
  env_value COMPOSE_FILE | grep -Eq 'manager|control' && has_manager=true
  env_value COMPOSE_FILE | grep -q manager && separate=true
  if [ "$(env_value MEDIA_MANAGER_OPTOUT)" = 1 ] || { [ -n "$(env_value MEDIA_MANAGER_ASKED)" ] && [ "$has_manager" = false ]; }; then declined=true; fi
  # An existing install without it is asked when someone is there to answer; with --yes or no terminal it is added.
  if [ "$FIRST" != true ] && [ -z "$MEDIA_MANAGER" ] && [ "$has_manager" = false ] && [ "$declined" = false ] && [ "$ASSUME_YES" != true ] && [ -t 0 ]; then
    if confirm "Let StreamRD start Plex and Jellyfin, update itself and restart from its web pages (it is given Docker's socket; one small helper inside it is the only thing that uses it)?" y; then MEDIA_MANAGER=on; else MEDIA_MANAGER=off; fi
  fi
  case "$MEDIA_MANAGER" in
    on) use_manager=true; set_env MEDIA_MANAGER_OPTOUT 0 yes ;;
    off) set_env MEDIA_MANAGER_OPTOUT 1 yes ;;
    *) [ "$declined" = true ] || use_manager=true ;;
  esac
  if [ "$use_manager" = true ] && [ "$has_manager" = false ] && [ "$FIRST" != true ]; then log "Turning Docker control on: StreamRD can start Plex and Jellyfin, update itself and restart from its web pages. Turn it off with --no-media-manager."; fi
  if [ "$use_manager" = true ] && [ "$separate" = true ]; then log "Moving the helper into the StreamRD container: one container instead of two. Media servers it started keep running."; fi
  if [ "$use_manager" = true ]; then
    write_control
    set_env DOCKER_SOCKET_PATH "$(docker_socket_path)" yes
  fi
  # The second container's overlay, secret and folder setting are no longer used, whether the helper moved or was turned off.
  rm -f "$DIR/docker-compose.manager.yml"; drop_env MEDIA_MANAGER_TOKEN; drop_env HOST_INSTALL_DIR
  [ "$use_manager" = true ] || rm -f "$DIR/docker-compose.control.yml"
  [ "$use_jellyfin" = false ] || write_jellyfin "$zurg_flag"
  [ "$use_plex" = false ] || write_plex "$zurg_flag"
  local files="docker-compose.yml"
  [ "$use_zilean" = true ] && files="$files:docker-compose.zilean.yml"
  [ "$use_zurg" = true ] && files="$files:docker-compose.zurg.yml"
  [ "$use_jellyfin" = true ] && files="$files:docker-compose.jellyfin.yml"
  [ "$use_plex" = true ] && files="$files:docker-compose.plex.yml"
  [ "$use_manager" = true ] && files="$files:docker-compose.control.yml"
  # Always name the files explicitly: Compose otherwise prefers a stray compose.yaml over docker-compose.yml.
  set_env COMPOSE_FILE "$files" yes
  for stray in compose.yaml compose.yml docker-compose.yaml; do
    [ ! -f "$DIR/$stray" ] || log "Ignoring $DIR/$stray (not part of this installation; delete it if it is an old copy)."
  done

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
  ensure_dirs "$image" streamrd/library phosphor/library
  [ "$use_jellyfin" = false ] || ensure_dirs "$image" jellyfin/config jellyfin/cache
  [ "$use_plex" = false ] || ensure_dirs "$image" plex/config plex/transcode
  [ "$use_manager" = false ] || ensure_dirs "$image" jellyfin/config jellyfin/cache plex/config plex/transcode
  if [ -n "$IMPORT_DB" ]; then
    mkdir -p "$DIR/config/streamrd"; cp "$IMPORT_DB" "$DIR/config/streamrd/streamrd.db"; chmod 600 "$DIR/config/streamrd/streamrd.db"
    [ "$(id -u)" != 0 ] || chown -R 1000:1000 "$DIR/config"
    log "Imported your database. It is upgraded (with a verified snapshot first) when the container starts."
  fi

  if [ "$START" = false ]; then
    log "Ready. Start it with: cd $DIR && ${DOCKER_PREFIX}docker compose up -d$([ "$separate" = true ] && echo ' --remove-orphans   (once: it removes the old helper container)')"
    return 0
  fi

  if [ -z "$(compose ps -q 2>/dev/null)" ]; then
    local names="STREAMRD_PORT PHOSPHOR_PORT TORRENT_PORT"
    [ "$use_jellyfin" = false ] || names="$names JELLYFIN_PORT"
    [ "$use_plex" = false ] || names="$names PLEX_PORT"
    for name in $names; do
      local p; p="$(env_value "$name")"
      ! port_busy "$p" || die "Port $p is already in use. Re-run with --port, --phosphor-port, --torrent-port, --jellyfin-port or --plex-port to choose another."
    done
  fi
  [ "$mode" = build ] || compose pull
  if [ "$ZILEAN" = off ] || [ "$ZURG" = off ] || [ "$MEDIA_SERVER" = none ] || [ "$MEDIA_MANAGER" = off ] || [ "$separate" = true ]; then compose up -d --remove-orphans; else compose up -d; fi

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
$( [ "$(env_value ENABLE_PHOSPHOR)" = false ] || echo "  Phosphor   http://localhost:$(env_value PHOSPHOR_PORT)   (set ENABLE_PHOSPHOR=false in .env to turn it off)" )

Create your account on the StreamRD page$( [ -n "$(env_value ADMIN_EMAIL)" ] && echo " with $(env_value ADMIN_EMAIL), which is reserved for the first administrator." || echo "; the first account becomes the administrator." )
Put a reverse proxy with HTTPS in front before exposing it to the internet.

  Folder     $DIR
  Settings   $DIR/config   (database, secrets, backups: back this up)
  Downloads  $DIR/data
  Update     cd $DIR && ${DOCKER_PREFIX}docker compose pull && ${DOCKER_PREFIX}docker compose up -d     (or re-run install.sh)
  Logs       cd $DIR && ${DOCKER_PREFIX}docker compose logs -f
  Remove     bash install.sh --uninstall --dir $DIR   (config/ and data/ are kept)
$(addon_notes)
EOF
}
addon_notes() {
  [ "$(env_value ENABLE_PHOSPHOR)" != false ] || echo "  Phosphor   not running. To run it too: bash install.sh --phosphor --dir $DIR"
  env_value COMPOSE_FILE | grep -q zilean && echo "  Zilean     internal only; it appears in Phosphor as the 'Zilean' indexer (its first import takes a while)"
  env_value COMPOSE_FILE | grep -q control && echo "  Docker     StreamRD starts Plex and Jellyfin (Admin -> Plex / Jellyfin), updates itself and restarts (Admin -> System) from its pages; see docs/plex-jellyfin.md"
  env_value COMPOSE_FILE | grep -q jellyfin && echo "  Jellyfin   http://localhost:$(env_value JELLYFIN_PORT)   libraries: Movies /library/streamrd/Movies, Shows \"/library/streamrd/TV Shows\" (see docs/plex-jellyfin.md)"
  env_value COMPOSE_FILE | grep -q plex && echo "  Plex       http://localhost:$(env_value PLEX_PORT)/web   libraries: Movies /library/streamrd/Movies, TV Shows \"/library/streamrd/TV Shows\" (see docs/plex-jellyfin.md)"
  env_value COMPOSE_FILE | grep -q zurg && echo "  Zurg       your Real-Debrid movies and shows are mounted at $DIR/mnt/zurg (edit zurg/config.yml, then: docker compose restart zurg)"
  return 0
}
# Everything runs through one function so a truncated download cannot execute half a script.
main "$@"
