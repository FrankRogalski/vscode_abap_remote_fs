/**
 * abapfs-mcp — ABAP FS MCP server without VS Code.
 *
 *   abapfs-mcp [serve] [--config file] [--http] [--port n] [--host h]
 *   abapfs-mcp init [file]        write a config template
 *   abapfs-mcp schema             print the config JSON schema
 *   abapfs-mcp tools [--json]     list the tools this build exposes
 *   abapfs-mcp check [--system id]  validate the config and log on to the systems
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"
import {
  type HeadlessConfig,
  configJsonSchema,
  configTemplate,
  defaultConfigLocations,
  findConfigFile,
  loadConfig,
  parseConfig
} from "./config"
import { log } from "./log"
import { deleteStoredPassword, secretStoreName, storePassword } from "./secretStore"
import { runSupervisor, serviceCommand, watchSupervisor } from "./service"

// stdout belongs to the MCP stdio transport: route all console output to stderr
for (const m of ["log", "info", "debug", "trace"] as const)
  console[m] = (...args: unknown[]) =>
    log.debug(args.map(a => (typeof a === "string" ? a : String(a))).join(" "))
console.warn = (...args: unknown[]) => log.warn(args.map(String).join(" "))
console.error = (...args: unknown[]) => log.error(args.map(String).join(" "))

process.removeAllListeners("warning")
process.on("warning", w => log.debug(`node warning: ${w.name}: ${w.message}`))
process.on("unhandledRejection", e =>
  log.warn(`unhandled rejection: ${e instanceof Error ? e.stack : e}`)
)

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", short: "c" },
    http: { type: "boolean" },
    stdio: { type: "boolean" },
    port: { type: "string" },
    host: { type: "string" },
    system: { type: "string", short: "s" },
    json: { type: "boolean" },
    force: { type: "boolean" },
    "from-vscode": { type: "boolean" },
    "vscode-settings": { type: "string" },
    "no-update": { type: "boolean" },
    help: { type: "boolean", short: "h" }
  }
})

const usage = `abapfs-mcp — ABAP FS MCP server without VS Code

Usage:
  abapfs-mcp [serve] [--config <file>] [--stdio | --http [--host <h>] [--port <n>]]
  abapfs-mcp init [<file>] [--force] [--from-vscode [--vscode-settings <settings.json>]]
                                       write a config (default ~/.config/abapfs/config.json),
                                       optionally converted from your VS Code ABAP FS settings
  abapfs-mcp schema                    print the config JSON schema
  abapfs-mcp tools [--json]            list exposed tools
  abapfs-mcp check [--system <id>]     validate config and log on to the systems
  abapfs-mcp password set|delete <id>  store/remove a system's password in the OS credential
                                       store (macOS keychain, Windows Credential Manager,
                                       Linux Secret Service)
  abapfs-mcp service install [--config <file>] [--no-update]
                                       run the HTTP server at logon (launchd, Task Scheduler,
                                       systemd --user), updated hourly from git
  abapfs-mcp service status|restart|uninstall

Config lookup: --config, $ABAPFS_CONFIG, ./abapfs.json, ~/.config/abapfs/config.json
`

async function boot(cfg: HeadlessConfig) {
  const { activateHeadless } = await import("./activate")
  return activateHeadless(cfg)
}

function withOverrides(cfg: HeadlessConfig) {
  if (values.http) cfg.mcp.transport = "http"
  if (values.stdio) cfg.mcp.transport = "stdio"
  if (values.port) cfg.mcp.port = Number(values.port)
  if (values.host) cfg.mcp.host = values.host
  return cfg
}

async function serve() {
  watchSupervisor()
  const cfg = withOverrides(loadConfig(values.config))
  const rt = await boot(cfg)
  log.info(
    `${rt.toolNames().length} tools registered, systems: ${Object.keys(cfg.systems).join(", ")}`
  )
  const { serveHttp, serveStdio } = await import("./mcp")
  const stop = cfg.mcp.transport === "http" ? await serveHttp(cfg.mcp) : await serveStdio()
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    await stop().catch(() => undefined)
    await rt.dispose()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  if (cfg.mcp.transport === "stdio") process.stdin.on("end", shutdown)
}

async function init() {
  const target = resolve(positionals[1] ?? defaultConfigLocations()[1]!)
  if (existsSync(target) && !values.force)
    throw new Error(`${target} exists (use --force to overwrite)`)
  let content: object = configTemplate()
  let note = ""
  if (values["from-vscode"]) {
    const { configFromVscodeSettings } = await import("./fromVscode")
    const r = configFromVscodeSettings(values["vscode-settings"])
    content = { $schema: configTemplate().$schema, ...r.config }
    note =
      `Converted ${Object.keys(r.config.systems).length} system(s) from ${r.source}.\n` +
      r.needPassword.map(id => `Store the password: abapfs-mcp password set ${id}\n`).join("")
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(content, null, 2) + "\n", { mode: 0o600 })
  process.stdout.write(`Wrote ${target}\n${note}`)
}

async function tools() {
  // no SAP logon needed: tools register lazily
  const cfg = parseConfig({
    systems: { dummy: { url: "http://localhost", username: "x" } },
    logLevel: "error"
  })
  cfg.stateDir = resolve(tmpdir(), "abapfs-mcp-tools")
  const rt = await boot(cfg)
  const { runtime } = await import("./vscode/impl")
  const { lm } = await import("vscode")
  const exposeEdit = true
  const names = rt.toolNames()
  const list = lm.tools
    .filter(
      (t: any) =>
        t.tags.includes("abap-fs") && (exposeEdit || t.name !== "replace_string_in_abap_object")
    )
    .map((t: any) => ({ name: t.name, description: t.description }))
  list.push({
    name: "get_abap_diagnostics",
    description: "Syntax check results (registered by the MCP server itself)"
  })
  if (values.json) process.stdout.write(JSON.stringify(list, null, 2) + "\n")
  else {
    for (const t of list) process.stdout.write(`${t.name}\n`)
    const hidden = names.filter(n => !list.some((t: any) => t.name === n))
    process.stdout.write(
      `\n${list.length} exposed via MCP (${names.length} registered${hidden.length ? `, not exposed: ${hidden.join(", ")}` : ""})\n`
    )
  }
  void runtime
  await rt.dispose()
}

async function check() {
  const cfg = loadConfig(values.config)
  process.stdout.write(`Config ${cfg.configPath} is valid\n`)
  await boot(cfg)
  const { getOrCreateClient } = await import("upstream:adt/conections")
  const ids = values.system ? [values.system] : Object.keys(cfg.systems)
  let failed = 0
  for (const id of ids) {
    try {
      const client = await getOrCreateClient(id.toLowerCase())
      await client.login()
      process.stdout.write(`✔ ${id}: logged on as ${client.username}\n`)
    } catch (e) {
      failed++
      process.stdout.write(`✘ ${id}: ${e instanceof Error ? e.message : e}\n`)
    }
  }
  process.exit(failed ? 1 : 0)
}

async function password() {
  const [, sub, id] = positionals
  if (!id || !["set", "delete"].includes(sub ?? ""))
    throw new Error("Usage: abapfs-mcp password set|delete <system id>")
  try {
    const cfg = loadConfig(values.config)
    if (!cfg.systems[id])
      log.warn(`'${id}' is not a system in ${cfg.configPath} (ids are case-sensitive)`)
  } catch {
    // storing a password before the config exists is fine
  }
  if (sub === "set") {
    storePassword(id)
    return void process.stdout.write(`Stored the password for ${id} in the ${secretStoreName()}\n`)
  }
  const removed = deleteStoredPassword(id)
  process.stdout.write(
    removed ? `Removed the password for ${id}\n` : `No password stored for ${id}\n`
  )
}

async function service() {
  if (positionals[1] === "run") {
    return runSupervisor(findConfigFile(values.config), !values["no-update"])
  }
  await serviceCommand(positionals[1], { config: values.config, noUpdate: values["no-update"] })
  process.exit(0)
}

async function main() {
  if (values.help) return void process.stdout.write(usage)
  const cmd = positionals[0] ?? "serve"
  switch (cmd) {
    case "serve":
      return serve()
    case "init":
      return await init()
    case "schema":
      return void process.stdout.write(JSON.stringify(configJsonSchema(), null, 2) + "\n")
    case "tools":
      await tools()
      return process.exit(0)
    case "check":
      return check()
    case "password":
      return await password()
    case "service":
      return await service()
    default:
      process.stderr.write(usage)
      process.exit(2)
  }
}

main().catch(e => {
  process.stderr.write(`abapfs-mcp: ${e instanceof Error ? e.message : e}\n`)
  log.debug(e instanceof Error ? (e.stack ?? "") : "")
  process.exit(1)
})
