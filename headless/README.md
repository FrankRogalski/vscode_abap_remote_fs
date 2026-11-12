# abapfs-mcp — ABAP FS MCP server without VS Code

This fork of [vscode_abap_remote_fs](https://github.com/marcellourbani/vscode_abap_remote_fs) runs the
extension's **MCP server and all of its language model tools as a plain Node process**. No VS Code
and no extension host are needed. All configuration lives in one JSON file.

It is not a rewrite. The tools are upstream's own code, bundled together with a small
`vscode` stand-in, so the tool names, schemas, descriptions and behaviour match the extension.
A nightly job merges upstream and only publishes the result when the headless build still serves
every tool. See [Staying in sync with upstream](#staying-in-sync-with-upstream).

## Quick start

```bash
git clone https://github.com/FrankRogalski/vscode_abap_remote_fs.git
cd vscode_abap_remote_fs
pnpm install --ignore-scripts
pnpm --filter abapfs-headless build
```

`--ignore-scripts` skips upstream's Playwright/Chromium download, which the MCP server does not need.
Everything works the same on macOS, Windows and Linux (Node 20+, git and pnpm on the PATH); on
Windows use PowerShell and `node headless\dist\cli.js`.

Create a config, either from your existing VS Code settings or from a template:

```bash
node headless/dist/cli.js init --from-vscode
```

```bash
node headless/dist/cli.js init
```

Both write the config to `~/.config/abapfs/config.json` (macOS, Linux; mode 600) or
`%APPDATA%\abapfs\config.json` (Windows). Store each system's password in the operating system's
credential store, then check that the server can log on:

```bash
node headless/dist/cli.js password set dev100
```

```bash
node headless/dist/cli.js check
```

`password set` lets the OS prompt for the password (macOS keychain, Windows Credential Manager,
Linux Secret Service via `secret-tool`); it never appears in the config, the shell history or the
process list.

Register it with your MCP client, e.g. Claude Code:

```bash
claude mcp add abap-fs -- node /path/to/vscode_abap_remote_fs/headless/dist/cli.js
```

Or in any client's JSON config (stdio):

```json
{
  "mcpServers": {
    "abap-fs": {
      "command": "node",
      "args": ["/path/to/vscode_abap_remote_fs/headless/dist/cli.js", "--config", "/path/to/config.json"]
    }
  }
}
```

## Commands

| Command | |
| --- | --- |
| `abapfs-mcp [serve]` | Start the MCP server (stdio unless the config says `http`). `--http`, `--stdio`, `--host`, `--port` override the config. |
| `abapfs-mcp init [file] [--from-vscode] [--force]` | Write a config, converted from VS Code's `abapfs.*` settings or from a template. |
| `abapfs-mcp check [--system id]` | Validate the config and log on to each system. |
| `abapfs-mcp password set\|delete <id>` | Store or remove a system's password in the OS credential store. |
| `abapfs-mcp service install [--no-update]` | Run the HTTP server at logon, updated hourly from git (see [Running as a service](#running-as-a-service)). |
| `abapfs-mcp service status\|restart\|uninstall` | Manage that service. |
| `abapfs-mcp tools [--json]` | List the tools this build serves. |
| `abapfs-mcp schema` | Print the config JSON schema (also in [config.schema.json](config.schema.json)). |

Config lookup order: `--config`, `$ABAPFS_CONFIG`, `./abapfs.json`, then
`~/.config/abapfs/config.json` (macOS, Linux; `$XDG_CONFIG_HOME` respected) or
`%APPDATA%\abapfs\config.json` and `~\.config\abapfs\config.json` (Windows).

## Configuration

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/FrankRogalski/vscode_abap_remote_fs/master/headless/config.schema.json",
  "systems": {
    "dev100": {
      "url": "https://my-sap-host:44300",
      "username": "DEVELOPER",
      "client": "100",
      "language": "EN",
      "allowSelfSigned": false,
      "atcVariant": "MY_VARIANT"
    },
    "qa200": {
      "url": "https://qa-host:44300",
      "username": "DEVELOPER",
      "password": "${env:ABAPFS_QA200_PASSWORD}",
      "client": "200"
    }
  },
  "mcp": { "transport": "stdio", "host": "127.0.0.1", "port": 4847, "apiKey": "${env:ABAPFS_MCP_KEY}", "exposeEditTool": true },
  "settings": { "abapfs.heartbeat.enabled": false },
  "logLevel": "warn"
}
```

| Key | Meaning |
| --- | --- |
| `systems` | Connections by id. The id is the `connectionId` the tools take. Each entry accepts every field of a VS Code `abapfs.remote` entry (`url`, `username`, `client`, `language`, `allowSelfSigned`, `customCA`, `atcVariant`, `sapGui`, `authMethod`, `certAuth`, …). |
| `systems.*.password` | Optional. Without `password` and `passwordCommand`, the password comes from the OS credential store entry for the system id (`abapfs-mcp password set <id>`). If you set it, use `${env:VAR}` rather than a literal. |
| `systems.*.passwordCommand` | Optional: a shell command printing the password (`pass`, 1Password CLI, …). |
| `systems.*.certPassphrase` | Passphrase for `authMethod: "cert"`. |
| `mcp.transport` | `stdio` (the client spawns the server) or `http` (long-running, endpoint `http://host:port/mcp`, health check at `/health`). |
| `mcp.apiKey` | When set, HTTP clients must send `Authorization: Bearer <key>`. |
| `mcp.exposeEditTool` | Expose `replace_string_in_abap_object` (default `true`). |
| `settings` | Any other ABAP FS setting by its VS Code id, flat (`"abapfs.atc.autoRefresh": false`) or nested. Unset settings use the extension's defaults. |
| `secrets` | Raw secret-storage entries, for the rare tool that reads its own secret. |
| `extensions` | VS Code extension ids to report as installed to tools that check for them. |
| `stateDir` | Where state that VS Code would keep in globalState/storage goes. Default `~/.local/state/abapfs-mcp` (`%LOCALAPPDATA%\abapfs-mcp` on Windows). |
| `logLevel` | `error`, `warn`, `info` or `debug`. Logs go to stderr. `$ABAPFS_LOG_LEVEL` overrides it. |

Every string in the file may use `${env:NAME}`. Relative paths are resolved against the config file.

Systems connect lazily: the first tool call that names a system logs on to it, with upstream's own
connection code.

## What works and what doesn't

All 47 tools upstream exposes over MCP are served, and the ones that talk to SAP run upstream's own
code paths: search, source, write (`replace_string_in_abap_object`, with upstream's locking and
transport handling), activation, ATC, unit tests, SQL, transports, where-used, dumps, traces,
version history, text elements, object creation, and so on.

Some upstream behaviour depends on the editor itself and is adapted or unavailable:

- **Diagnostics.** In VS Code, syntax checks come from the ABAP language server. Headless,
  `get_abap_diagnostics` runs the same ADT syntax check directly and returns results in the same format.
  abaplint diagnostics are not available.
- **Interactive prompts.** Quick picks and input boxes are cancelled. A write to a transportable
  object without `transportChoice` would open the transport picker in VS Code. Headless it is
  cancelled and the write does not happen, so always pass `transportChoice` (local `$TMP` objects
  need none).
- **UI output.** SQL `displayMode: "ui"`, Mermaid webviews and "open in editor" have no screen to
  render on. Use `displayMode: "internal"` or `"download_to_file"` for SQL.
- **Debugger tools.** These drive a VS Code debug session and are not functional headless.
- **Authentication.** `basic` and `cert` work. `browser_sso`, `kerberos` and `oauth_onprem` need a
  browser or Windows SSPI and are untested headless.

## How it works

- `scripts/gen-vscode-shim.mjs` reads `@types/vscode` and generates `src/vscode/index.ts`, which has
  one export for every runtime name of the VS Code API. Enums are exact copies. Everything else comes
  from [src/vscode/impl.ts](src/vscode/impl.ts) when implemented (configuration, `workspace.fs`,
  text documents, commands, language model tools, diagnostics, …) or becomes a harmless no-op stub.
  When upstream starts using new API, the build still resolves it.
- [src/activate.ts](src/activate.ts) is a slim version of upstream's `activate()`. It puts the JSON
  config into the shim, registers upstream's `adt://` file system provider and commands, and calls
  upstream's `registerAllTools`.
- The build ([tsdown.config.ts](tsdown.config.ts)) never edits upstream files. It aliases `vscode`,
  redirects `langClient.ts` to [an override](src/overrides/langClient.ts) that replaces only
  `triggerSyntaxCheck`, and appends two exports to upstream modules: `createMcpServer` and a setter
  for `extension.ts`'s `context`. If upstream renames either, the build fails loudly.
- The fork changes exactly one upstream file: `pnpm-workspace.yaml` gets a `- headless` line.

## Staying in sync with upstream

[.github/workflows/headless-upstream-sync.yml](../.github/workflows/headless-upstream-sync.yml)
runs every night at 00:00 Europe/Berlin (and on demand). It runs
[scripts/sync-upstream.sh](scripts/sync-upstream.sh), which:

1. merges `marcellourbani/vscode_abap_remote_fs@master`, resolving lockfile and workspace conflicts automatically,
2. typechecks, runs the unit tests and builds,
3. runs the [MCP smoke test](scripts/smoke.mjs): starts the server over stdio, checks that **every tool
   upstream tags for MCP is served**, and calls the tools that need no SAP system.

The merge is pushed only if all of that passes. Otherwise `master` stays as it was, the failed state
is pushed to `upstream-sync/failed-<date>`, and an issue is opened.

Upstream's own workflows (CI, docs, changesets, release, publish) also live in the fork and run on
every push to `master`. Without upstream's secrets they fail, and the docs workflow commits a
regenerated `DOCUMENTATION.md`. Disable them in the fork's Actions tab, or set the repository
variable `DISABLE_UPSTREAM_WORKFLOWS` to `true` so the nightly job disables them, including new ones
upstream adds later.

GitHub's built-in token cannot push commits that change `.github/workflows/*`, which upstream does
now and then. To cover those nights, add a fine-grained personal access token for this repository
with **Contents: read and write** and **Workflows: read and write** as the secret `SYNC_TOKEN`.

Before master moves, the merge is pushed to `upstream-sync/candidate` and verified again on Windows
and macOS by [headless-ci.yml](../.github/workflows/headless-ci.yml), which also runs on every push
that touches `headless/`. Only a merge that passes on all three systems is fast-forwarded onto master.

To follow the fork on your machine, install the service below (it updates itself) or run
`node headless/scripts/update-local.mjs` by hand: it pulls and rebuilds only when the fork moved.

## Running as a service

```bash
node headless/dist/cli.js service install --config ~/.config/abapfs/config.json
```

This starts the HTTP server now and at every logon, restarts it if it exits, and checks the git
checkout for updates every hour (pull, rebuild, restart; `--no-update` turns that off). It runs
inside your login session, so it can read the passwords from the OS credential store.

| | Runs as | Log |
| --- | --- | --- |
| macOS | launchd agent `com.abapfs.mcp` | `~/Library/Logs/abapfs-mcp.log` |
| Windows | Task Scheduler task `\abapfs\abapfs-mcp` (hidden PowerShell window at logon) | `%LOCALAPPDATA%\abapfs-mcp\logs\abapfs-mcp.log` |
| Linux | systemd user unit `abapfs-mcp.service` | `~/.local/state/abapfs-mcp/logs/abapfs-mcp.log` |

`service status` shows the platform state and the server's health; `service restart` and
`service uninstall` do what they say. Set `mcp.apiKey` in the config and register the server with
your client, for example:

```bash
claude mcp add --transport http abap-fs -s user http://127.0.0.1:4848/mcp --header "Authorization: Bearer <apiKey>"
```

Pick a port other than 4847 (the VS Code extension's default) if both may run at once.

## Development

```bash
pnpm --filter abapfs-headless typecheck
pnpm --filter abapfs-headless test
pnpm --filter abapfs-headless build
pnpm --filter abapfs-headless smoke
```
