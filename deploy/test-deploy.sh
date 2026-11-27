#!/usr/bin/env bash
set -euo pipefail
root=$(mktemp -d)
root=$(cd "$root" && pwd -P)
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/bin" "$root/releases/old" "$root/releases/new" "$root/session"
printf 'OMI_GATEWAY_SECRET=12345678901234567890123456789012\nOMI_SESSION_DIR=%s/session\nOMI_CHROMIUM_PATH=/usr/bin/true\n' "$root" > "$root/env"
printf 'ok' > "$root/releases/old/ecosystem.config.cjs"
printf 'ok' > "$root/releases/new/ecosystem.config.cjs"
ln -s "$root/releases/old" "$root/current"
cat > "$root/bin/npm" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
cat > "$root/bin/pm2" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
cat > "$root/bin/curl" <<'MOCK'
#!/usr/bin/env bash
[ "${MOCK_HEALTH:-ok}" = ok ]
MOCK
chmod +x "$root/bin/"*
export PATH="$root/bin:$PATH" OMI_GATEWAY_ENV_FILE="$root/env" DEPLOY_HEALTH_ATTEMPTS=1
bash deploy/remote-deploy.sh "$root" new
[ "$(readlink "$root/current")" = "$root/releases/new" ]
ln -s "$root/releases/old" "$root/current.next"
node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$root/current.next" "$root/current"
if MOCK_HEALTH=fail bash deploy/remote-deploy.sh "$root" new; then echo 'Expected failed deployment' >&2; exit 1; fi
[ "$(readlink "$root/current")" = "$root/releases/old" ]
echo 'Deployment and rollback verified'
