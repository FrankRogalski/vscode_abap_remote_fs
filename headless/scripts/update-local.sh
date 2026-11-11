#!/usr/bin/env bash
# Update a local checkout of this fork and rebuild the MCP server.
# Running MCP clients pick the new build up on their next start (stdio) or restart (http).
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
git pull --ff-only
pnpm install --ignore-scripts --frozen-lockfile
pnpm --filter abapfs-headless build
echo "abapfs-mcp rebuilt at $(git rev-parse --short HEAD)"
