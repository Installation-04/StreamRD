#!/usr/bin/env bash
# This script was renamed to install.sh. This stub keeps older one-line install commands working:
# it runs install.sh from the same place with the same options.
set -euo pipefail
REPO="${STREAMRD_REPO:-Installation-04/StreamRD}"
RAW_BASE="${STREAMRD_RAW_BASE:-https://raw.githubusercontent.com/$REPO}"
exec bash <(curl -fsSL "$RAW_BASE/main/install.sh") "$@"
