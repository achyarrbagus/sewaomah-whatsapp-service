#!/usr/bin/env bash
set -euo pipefail
base="$1"
release="$2"
[[ "$release" =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'Invalid release name' >&2; exit 1; }
dir="$base/releases/$release"
env_file="${OMI_GATEWAY_ENV_FILE:-/etc/sewaomah-whatsapp-service/env}"
[ -r "$env_file" ] || { echo 'Gateway environment file is unavailable' >&2; exit 1; }
# This is a trusted server-side file, readable by the deployment user.
set -a
source "$env_file"
set +a
: "${OMI_GATEWAY_SECRET:?Missing gateway secret}"
: "${OMI_SESSION_DIR:?Missing persistent session directory}"
: "${OMI_CHROMIUM_PATH:?Set a system Chromium executable}"
[ -x "$OMI_CHROMIUM_PATH" ] && [ -d "$OMI_SESSION_DIR" ] || { echo 'Chromium or session directory unavailable' >&2; exit 1; }
cd "$dir"
PUPPETEER_SKIP_DOWNLOAD=true npm ci --omit=dev --ignore-scripts --no-audit --no-fund
previous=''
[ ! -L "$base/current" ] || previous=$(readlink -f "$base/current")
activate() {
  ln -sfn "$1" "$base/current.next" || return 1
  node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$base/current.next" "$base/current" || return 1
  OMI_GATEWAY_ENV_FILE="$env_file" pm2 startOrRestart "$base/current/ecosystem.config.cjs" --only omi-gateway --update-env
}
healthy() {
  for ((i=0; i<${DEPLOY_HEALTH_ATTEMPTS:-20}; i++)); do
    if curl -fsS --max-time 3 -o /dev/null -H "Authorization: Bearer $OMI_GATEWAY_SECRET" "http://127.0.0.1:${OMI_GATEWAY_PORT:-8095}/status"; then return 0; fi
    sleep 2
  done
  return 1
}
if ! activate "$dir" || ! healthy; then
  echo 'Gateway activation failed' >&2
  if [ -n "$previous" ] && [ -f "$previous/ecosystem.config.cjs" ] && [ "$previous" != "$dir" ]; then
    echo 'Restoring previous release' >&2
    activate "$previous" || true
  else
    pm2 delete omi-gateway >/dev/null 2>&1 || true
  fi
  exit 1
fi
pm2 save
printf 'Gateway deployed: %s\n' "$release"
