#!/usr/bin/env bash
# Update a local checkout of this fork and rebuild the MCP server when the fork has moved.
# Restarts the launchd service (install-launchd.sh) after a rebuild; stdio clients pick the new
# build up on their next start. FORCE=1 rebuilds even without new commits.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
echo "[$(date '+%F %T')] checking for updates"
git fetch --quiet origin
if [[ "$(git rev-parse HEAD)" == "$(git rev-parse '@{u}')" && -f headless/dist/cli.js && "${FORCE:-}" != 1 ]]; then
  echo "up to date at $(git rev-parse --short HEAD)"
  exit 0
fi
git pull --ff-only
pnpm install --ignore-scripts --frozen-lockfile
pnpm --filter abapfs-headless build
echo "abapfs-mcp rebuilt at $(git rev-parse --short HEAD)"
service="gui/$(id -u)/com.abapfs.mcp"
if launchctl print "$service" >/dev/null 2>&1; then
  launchctl kickstart -k "$service"
  echo "restarted $service"
fi
