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
for dir in streamrd/library phosphor/library jellyfin/config plex/config streamrd/library/Movies "streamrd/library/TV Shows" phosphor/library/Movies "phosphor/library/TV Shows"; do [ -d "$d/config/$dir" ] || { echo "FAIL: config/$dir missing" >&2; exit 1; }; done   # Movies and TV Shows are there before anything is exported

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

# Phosphor is off for a new install unless it is asked for. An installation that was already running it keeps it, including when its
# container definition is written again, and Phosphor can be turned on and off by re-running.
dp="$work/phosphor-default"; run --dir "$dp"
check "$dp/.env" '^ENABLE_PHOSPHOR=false$'; check "$dp/docker-compose.yml" 'ENABLE_PHOSPHOR: ${ENABLE_PHOSPHOR:-}'
run --dir "$dp"; check "$dp/.env" '^ENABLE_PHOSPHOR=false$'            # a plain re-run keeps it off
run --dir "$dp" --phosphor; check "$dp/.env" '^ENABLE_PHOSPHOR=true$'  # and --phosphor turns it on
run --dir "$dp"; check "$dp/.env" '^ENABLE_PHOSPHOR=true$'             # which a plain re-run keeps
run --dir "$dp" --no-phosphor; check "$dp/.env" '^ENABLE_PHOSPHOR=false$'
dq="$work/phosphor-asked"; run --dir "$dq" --phosphor --phosphor-port 8091
check "$dq/.env" '^ENABLE_PHOSPHOR=true$'; check "$dq/.env" '^PHOSPHOR_PORT=8091$'
# An installation from before this changed (Phosphor on by default, nothing about it in .env) is recorded as running it, so writing its
# container definition again does not switch it off.
dr="$work/phosphor-before"; run --dir "$dr"
sed -i '/^ENABLE_PHOSPHOR=/d' "$dr/.env"; sed -i 's/ENABLE_PHOSPHOR: ${ENABLE_PHOSPHOR:-}/ENABLE_PHOSPHOR: ${ENABLE_PHOSPHOR:-true}/' "$dr/docker-compose.yml"
absent "$dr/.env" ENABLE_PHOSPHOR; run --dir "$dr" --refresh-compose
check "$dr/.env" '^ENABLE_PHOSPHOR=true$'; check "$dr/docker-compose.yml" 'ENABLE_PHOSPHOR: ${ENABLE_PHOSPHOR:-}'
# Zilean is added to Phosphor, so asking for it with Phosphor off says so.
zilean_note="$(PATH="$work/bin:$PATH" bash "$root/install.sh" --yes --no-start --dir "$work/phosphor-zilean" --zilean 2>&1)"
printf '%s' "$zilean_note" | grep -q 'Zilean is added to Phosphor, which is not running' || { echo "FAIL: Zilean without Phosphor was not explained" >&2; exit 1; }
zilean_on="$(PATH="$work/bin:$PATH" bash "$root/install.sh" --yes --no-start --dir "$work/phosphor-zilean-on" --zilean --phosphor 2>&1)"
! printf '%s' "$zilean_on" | grep -q 'which is not running' || { echo "FAIL: Zilean with Phosphor on was told Phosphor is off" >&2; exit 1; }

# ---- The host: what is missing is installed (Docker, the Compose plugin, curl, tar), unless told not to. ----------------------------------
# Each case runs the real installer in a sandbox that has the system's tools but no Docker, package manager, sudo or init system of its own,
# plus stand-ins that record what they were asked and change the sandbox the way the real thing would.
fail() { echo "FAIL: $*" >&2; exit 1; }
has() { grep -Eq -- "$2" "$1" || { echo "FAIL: $1 lacks: $2" >&2; sed 's/^/   | /' "$1" | tail -20 >&2; exit 1; }; }
lacks() { ! grep -Eq -- "$2" "$1" || { echo "FAIL: $1 has: $2" >&2; exit 1; }; }
real_bash="$(command -v bash)"; real_tar="$(command -v tar)"; real_curl="$(command -v curl)"
stub() { printf '#!/bin/sh\n%s\n' "$2" > "$bin/$1"; chmod +x "$bin/$1"; }
docker_template() { cat > "$state/docker.template" <<'STUB'
#!/bin/sh
echo "docker $*" >> "$LOG"
case "$1" in
  info)
    [ -e "$STATE/running" ] || { echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1; }
    if [ -n "${STUB_NEED_SUDO:-}" ] && [ -z "${STUB_AS_ROOT:-}" ]; then echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1; fi ;;
  compose) if [ "$2" = version ]; then [ -e "$STATE/compose" ] || [ -x "${STREAMRD_COMPOSE_DIR:-/nonexistent}/docker-compose" ] || exit 1; fi ;;
esac
exit 0
STUB
chmod +x "$state/docker.template"; }
# sandbox NAME PM(apt|pacman|none) HAS_SUDO(0|1) HAS_DOCKER(0|1) HAS_TAR(0|1)
sandbox() {
  local name="$1" pm="$2" has_sudo="$3" has_docker="$4" has_tar="$5" f b
  bin="$work/$name/bin"; state="$work/$name/state"; log="$work/$name/log"; mkdir -p "$bin" "$state"; : > "$log"
  for f in /usr/bin/* /bin/*; do
    b="${f##*/}"
    case "$b" in docker|docker-*|sudo|su|systemctl|service|rc-service|rc-update|apt-get|apt|dnf|yum|zypper|pacman|apk|curl|tar|id|uname|chown) continue ;; esac
    [ -e "$bin/$b" ] || ln -s "$f" "$bin/$b" 2>/dev/null || true
  done
  docker_template
  stub id 'if [ "$1" = -u ]; then echo "${STUB_UID:-1000}"; else exec /usr/bin/id "$@"; fi'
  stub uname 'if [ "$1" = -s ] && [ -n "${STUB_OS:-}" ]; then echo "$STUB_OS"; else exec /usr/bin/uname "$@"; fi'
  stub chown 'exit 0'
  stub systemctl 'echo "systemctl $*" >> "$LOG"; case "$*" in *docker*) touch "$STATE/running" ;; esac; exit 0'
  stub service 'echo "service $*" >> "$LOG"; case "$*" in *docker*) touch "$STATE/running" ;; esac; exit 0'
  [ "$has_sudo" = 0 ] || stub sudo 'echo "sudo $*" >> "$LOG"; STUB_AS_ROOT=1 exec "$@"'
  [ "$has_tar" = 0 ] || ln -s "$real_tar" "$bin/tar"
  stub curl 'url=""; out=""; prev=""
for a in "$@"; do
  [ "$prev" != -o ] || out="$a"
  case "$a" in -*) ;; *) [ "$prev" = -o ] || url="$a" ;; esac
  prev="$a"
done
echo "curl $url" >> "$LOG"
case "$url" in
  *get.docker.com)
    if [ -n "${STUB_SCRIPT_FAILS:-}" ]; then printf "#!/bin/sh\nexit 1\n" > "$out"
    else printf "#!/bin/sh\necho docker-script-ran >> \"%s\"\ntouch \"%s/running\" \"%s/compose\"\ncp \"%s/docker.template\" \"%s/docker\"\n" "$LOG" "$STATE" "$STATE" "$STATE" "$BIN" > "$out"; fi ;;
  */checksums.txt) cp "$STATE/checksums.txt" "$out" ;;
  */docker-compose-linux-*) cp "$STATE/compose-binary" "$out" ;;
  *) exec "$REAL_CURL" "$@" ;;
esac'
  case "$pm" in
    apt) stub apt-get 'echo "apt-get $*" >> "$LOG"
case "$*" in
  *install*docker.io*) cp "$STATE/docker.template" "$BIN/docker" ;;
  *install*docker-compose-plugin*|*install*docker-compose-v2*) [ -z "${STUB_COMPOSE_PKG_FAILS:-}" ] || exit 1; touch "$STATE/compose" ;;
  *install*tar*) ln -sf "$REAL_TAR" "$BIN/tar" ;;
esac
exit 0' ;;
    pacman) stub pacman 'echo "pacman $*" >> "$LOG"; case "$*" in *docker*) cp "$STATE/docker.template" "$BIN/docker"; touch "$STATE/compose" ;; esac; exit 0' ;;
  esac
  if [ "$has_docker" = 1 ]; then cp "$state/docker.template" "$bin/docker"; touch "$state/running" "$state/compose"; fi
}
# scenario NAME [VAR=value ...] -- installer options: runs the installer in that sandbox; leaves the exit code in rc and what it printed in out
scenario() {
  local name="$1"; shift; local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  set +e
  out="$(env ${envs[@]+"${envs[@]}"} PATH="$bin" LOG="$log" STATE="$state" BIN="$bin" REAL_TAR="$real_tar" REAL_CURL="$real_curl" STREAMRD_COMPOSE_DIR="$state/plugins" \
    "$real_bash" "$root/install.sh" --yes --no-start --dir "$work/$name/d" "$@" 2>&1)"; rc=$?
  set -e
  printf '%s\n' "$out" > "$work/$name/out"
}

# 1. A bare machine, as root: Docker comes from Docker's own script, the service is started, and the install goes on.
sandbox h1 apt 0 0 1; scenario h1 STUB_UID=0 -- ; [ "$rc" = 0 ] || { echo "$out" >&2; fail "a bare machine was not set up (exit $rc)"; }
has "$log" '^curl https://get.docker.com$'; has "$log" 'docker-script-ran'; has "$log" 'systemctl enable --now docker|service docker start'
[ -f "$work/h1/d/.env" ] || fail "the install did not go on after installing Docker"; has "$work/h1/out" 'Installing Docker Engine'
# 2. --no-install-docker installs nothing, and says what to do.
sandbox h2 apt 0 0 1; scenario h2 STUB_UID=0 -- --no-install-docker; [ "$rc" != 0 ] || fail "--no-install-docker went on without Docker"
has "$work/h2/out" 'Docker is not installed'; has "$work/h2/out" 'docs.docker.com/engine/install'; lacks "$log" 'docker-script-ran'; [ ! -e "$work/h2/d" ] || fail "--no-install-docker made files"
sandbox h2b apt 0 0 1; scenario h2b STUB_UID=0 STREAMRD_NO_INSTALL_DOCKER=1 -- ; [ "$rc" != 0 ] || fail "STREAMRD_NO_INSTALL_DOCKER=1 went on without Docker"
# 3. A missing tar is installed first (with the certificates), through the machine's package manager.
sandbox h3 apt 0 1 0; scenario h3 STUB_UID=0 -- ; [ "$rc" = 0 ] || { echo "$out" >&2; fail "a missing tar stopped the install"; }
has "$log" 'apt-get install -y -qq tar ca-certificates'
# 4. Docker without the Compose plugin: the packages are tried, then Docker's own release of the plugin, accepted only with its published checksum.
arch=""; case "$(uname -m)" in x86_64|amd64) arch=x86_64 ;; aarch64|arm64) arch=aarch64 ;; esac
if [ -n "$arch" ]; then
  sandbox h4 apt 0 1 1; printf '#!/bin/sh\nexit 0\n' > "$state/compose-binary"; rm -f "$state/compose"
  printf '%s *docker-compose-linux-%s\n' "$(sha256sum "$state/compose-binary" | cut -d' ' -f1)" "$arch" > "$state/checksums.txt"
  scenario h4 STUB_UID=0 STUB_COMPOSE_PKG_FAILS=1 -- ; [ "$rc" = 0 ] || { echo "$out" >&2; fail "the Compose plugin was not installed (exit $rc)"; }
  [ -x "$state/plugins/docker-compose" ] || fail "the Compose plugin was not put in place"; has "$log" 'docker-compose-linux-'
  has "$log" 'apt-get install -y -qq docker-compose-plugin'; has "$log" 'apt-get install -y -qq docker-compose-v2'
  sandbox h4b apt 0 1 1; printf '#!/bin/sh\nexit 0\n' > "$state/compose-binary"; rm -f "$state/compose"
  printf '%s *docker-compose-linux-%s\n' "0000000000000000000000000000000000000000000000000000000000000000" "$arch" > "$state/checksums.txt"
  scenario h4b STUB_UID=0 STUB_COMPOSE_PKG_FAILS=1 -- ; [ "$rc" != 0 ] || fail "a Compose plugin that did not match its checksum was accepted"
  has "$work/h4b/out" 'did not match its published checksum'; [ ! -e "$state/plugins/docker-compose" ] || fail "the unchecked plugin was installed"
fi
# 5. Docker installed but not running: it is started, and the install goes on.
sandbox h5 apt 0 1 1; rm -f "$state/running"; scenario h5 STUB_UID=0 -- ; [ "$rc" = 0 ] || { echo "$out" >&2; fail "a stopped Docker was not started (exit $rc)"; }
has "$log" 'systemctl enable --now docker|service docker start'; has "$work/h5/out" 'Docker is not running; starting it'
sandbox h5b apt 0 1 1; rm -f "$state/running"; scenario h5b STUB_UID=0 -- --no-install-docker; [ "$rc" != 0 ] || fail "--no-install-docker started a service"
lacks "$log" 'systemctl|service docker'; has "$work/h5b/out" 'is not running'
# 6. Docker answers only to root: it is run through sudo, nobody is added to the docker group, and the printed commands say sudo.
sandbox h6 apt 1 1 1; scenario h6 STUB_UID=1000 STUB_NEED_SUDO=1 -- ; [ "$rc" = 0 ] || { echo "$out" >&2; fail "Docker that answers only to root was not used through sudo (exit $rc)"; }
has "$log" '^sudo docker info'; has "$work/h6/out" 'sudo docker compose up -d'; lacks "$log" 'usermod|docker group|groupadd'
# 7. A Mac or Windows machine without Docker is told what to install; nothing is installed.
sandbox h7 none 0 0 1; scenario h7 STUB_OS=Darwin -- ; [ "$rc" != 0 ] || fail "a Mac without Docker went on"; has "$work/h7/out" 'Docker Desktop'
# 8. Arch: no Docker script, the distribution's packages.
sandbox h8 pacman 0 0 1; scenario h8 STUB_UID=0 -- ; [ "$rc" = 0 ] || { echo "$out" >&2; fail "Arch was not set up (exit $rc)"; }
has "$log" 'pacman -S --noconfirm --needed docker docker-compose'; lacks "$log" 'get.docker.com'
# 9. Docker's script failing falls back to the distribution's packages.
sandbox h9 apt 0 0 1; scenario h9 STUB_UID=0 STUB_SCRIPT_FAILS=1 -- ; [ "$rc" = 0 ] || { echo "$out" >&2; fail "the fallback to packages failed (exit $rc)"; }
has "$log" 'apt-get install -y -qq docker.io'; has "$log" 'apt-get install -y -qq docker-compose-plugin'; has "$work/h9/out" 'distribution.s own Docker packages'
# 10. Neither root nor a working sudo: it says so, and installs nothing.
sandbox h10 apt 0 0 1; scenario h10 STUB_UID=1000 -- ; [ "$rc" != 0 ] || fail "an unprivileged user without sudo went on"
has "$work/h10/out" 'needs root'; lacks "$log" 'docker-script-ran|apt-get install'
# 11. --prepare stops once the machine is ready, before anything of StreamRD's is made.
sandbox h11 apt 0 0 1; set +e; out="$(env STUB_UID=0 PATH="$bin" LOG="$log" STATE="$state" BIN="$bin" REAL_TAR="$real_tar" REAL_CURL="$real_curl" "$real_bash" "$root/install.sh" --yes --prepare --dir "$work/h11/d" 2>&1)"; rc=$?; set -e
[ "$rc" = 0 ] || { echo "$out" >&2; fail "--prepare failed"; }; printf '%s' "$out" | grep -q 'This machine is ready' || fail "--prepare did not say it was done"; [ ! -e "$work/h11/d" ] || fail "--prepare made StreamRD's folders"
# 12. Removing never installs anything.
sandbox h12 apt 0 0 1; scenario h12 STUB_UID=0 -- --uninstall; [ "$rc" != 0 ] || fail "--uninstall went on without Docker"; lacks "$log" 'docker-script-ran'
echo "install.sh checks passed"
