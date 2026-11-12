#!/usr/bin/env bash
# macOS: run the MCP server as a login service and keep it updated, via two launchd agents.
#
#   install-launchd.sh install [--config <file>]   install/refresh both agents and start them
#   install-launchd.sh uninstall                    stop and remove both agents
#   install-launchd.sh status                       show agent state and the server's /health
#
# com.abapfs.mcp         `abapfs-mcp serve --http` at login, restarted if it exits
# com.abapfs.mcp-update  hourly: scripts/update-local.sh (pull + rebuild + restart when the fork moved)
#
# Agents run in your login session, so passwordCommand can read the login keychain.
# Logs: ~/Library/Logs/com.abapfs.mcp.log and ~/Library/Logs/com.abapfs.mcp-update.log
set -euo pipefail

SERVER=com.abapfs.mcp
UPDATER=com.abapfs.mcp-update
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs"
DOMAIN="gui/$(id -u)"
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
CLI="$REPO/headless/dist/cli.js"

plist_path() { echo "$AGENTS/$1.plist"; }

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

# PATH for the agents: wherever node, pnpm and git live now, plus the system dirs
agent_path() {
  local dirs=() d
  for tool in node pnpm git; do
    d="$(dirname "$(command -v "$tool")")" || { echo "$tool not found on PATH" >&2; exit 1; }
    dirs+=("$d")
  done
  printf '%s:' "${dirs[@]}" /usr/bin /bin /usr/sbin /sbin | sed 's/:$//'
}

program_args() {
  local out="" a
  for a in "$@"; do out+="    <string>$(xml_escape "$a")</string>"$'\n'; done
  printf '%s' "$out"
}

write_plist() { # label, extra keys, args...
  local label="$1" extra="$2"
  shift 2
  cat >"$(plist_path "$label")" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
$(program_args "$@")
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "$PATH_FOR_AGENTS")</string>
  </dict>
  <key>WorkingDirectory</key><string>$(xml_escape "$REPO")</string>
  <key>StandardOutPath</key><string>$LOGS/$label.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$label.log</string>
$extra
</dict>
</plist>
EOF
  plutil -lint -s "$(plist_path "$label")"
}

load() {
  launchctl bootout "$DOMAIN/$1" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$(plist_path "$1")"
}

install() {
  local config=""
  [[ "${1:-}" == "--config" ]] && config="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
  [[ -f "$CLI" ]] || { echo "Build first: pnpm --filter abapfs-headless build" >&2; exit 1; }
  mkdir -p "$AGENTS" "$LOGS"
  PATH_FOR_AGENTS="$(agent_path)"
  local node
  node="$(command -v node)"
  local args=("$node" "$CLI" serve --http)
  [[ -n "$config" ]] && args+=(--config "$config")
  "$node" "$CLI" check ${config:+--config "$config"} >/dev/null 2>&1 ||
    echo "warning: \`abapfs-mcp check\` fails; the service starts anyway" >&2

  write_plist "$SERVER" '  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>' "${args[@]}"
  write_plist "$UPDATER" '  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>3600</integer>' \
    /bin/bash "$REPO/headless/scripts/update-local.sh"

  load "$SERVER"
  load "$UPDATER"
  echo "Installed $SERVER and $UPDATER"
  status
}

uninstall() {
  for label in "$SERVER" "$UPDATER"; do
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    rm -f "$(plist_path "$label")"
  done
  echo "Removed $SERVER and $UPDATER"
}

status() {
  for label in "$SERVER" "$UPDATER"; do
    if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$label" | awk -v l="$label" '/^\tstate =|^\tpid =|last exit code/ {gsub(/^\t+/,""); printf "%s: %s\n", l, $0}'
    else
      echo "$label: not installed"
    fi
  done
}

case "${1:-}" in
  install) shift; install "$@" ;;
  uninstall) uninstall ;;
  status) status ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
