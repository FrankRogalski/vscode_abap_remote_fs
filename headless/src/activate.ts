/**
 * Headless activation: the subset of upstream's extension.ts `activate()` that the language
 * model tools and the MCP server need, run against the vscode shim.
 *
 * Upstream modules are imported dynamically, after the shim holds the configuration, because
 * several of them read settings while they are being loaded.
 */
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
// the extension manifest: setting defaults and the tool descriptions/input schemas
import packageJSON from "../../package.json"
import { type HeadlessConfig, type SystemConfig, resolvePassword } from "./config"
import { createExtensionContext, type SecretResolver } from "./context"
import { log, setLogLevel } from "./log"
import { runtime, type ContributedTool } from "./vscode/impl"

const manifest = packageJSON as any

/** Mirrors the extension's install folder: assets live in <root>/client/dist/media like in a VSIX */
export function extensionPath() {
  const bundleDir = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(bundleDir, "extension"), join(bundleDir, "..", "dist", "extension")])
    if (existsSync(join(candidate, "client"))) return candidate
  return join(bundleDir, "extension")
}

function contributedSettings(): Map<string, unknown> {
  const defaults = new Map<string, unknown>()
  const conf = manifest.contributes?.configuration
  const blocks = Array.isArray(conf) ? conf : conf ? [conf] : []
  for (const b of blocks)
    for (const [key, prop] of Object.entries<any>(b.properties ?? {}))
      defaults.set(key, prop.default)
  return defaults
}

/** Accept both flat ids ("abapfs.atc.autoRefresh") and nested objects, stopping at known ids */
function flattenSettings(input: Record<string, unknown>, known: Map<string, unknown>) {
  const out = new Map<string, unknown>()
  const walk = (prefix: string, value: unknown) => {
    const isObj = value && typeof value === "object" && !Array.isArray(value)
    if (!isObj || known.has(prefix)) {
      if (!known.has(prefix)) log.warn(`settings: '${prefix}' is not an ABAP FS setting (kept anyway)`)
      out.set(prefix, value)
      return
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(prefix ? `${prefix}.${k}` : k, v)
  }
  for (const [k, v] of Object.entries(input)) walk(k, v)
  return out
}

const SECRET_ONLY_FIELDS = ["password", "passwordCommand", "certPassphrase"] as const

function storedRemote(sys: SystemConfig) {
  const copy: Record<string, unknown> = { ...sys }
  for (const f of SECRET_ONLY_FIELDS) delete copy[f]
  return copy
}

export function applyConfig(cfg: HeadlessConfig) {
  setLogLevel(cfg.logLevel)
  const known = contributedSettings()
  runtime.settings.clear()
  for (const [k, v] of known) runtime.settings.set(k, v)
  for (const [k, v] of flattenSettings(cfg.settings, known)) runtime.settings.set(k, v)

  // connections, keyed like VS Code: lower case connection ids
  const remotes: Record<string, unknown> = {}
  for (const [id, sys] of Object.entries(cfg.systems)) remotes[id.toLowerCase()] = storedRemote(sys)
  runtime.settings.set("abapfs.remote", remotes)

  // the MCP server section is driven by the "mcp" block
  runtime.settings.set("abapfs.mcpServer.autoStart", false)
  runtime.settings.set("abapfs.mcpServer.port", cfg.mcp.port)
  runtime.settings.set("abapfs.mcpServer.apiKey", cfg.mcp.apiKey ?? "")
  runtime.settings.set("abapfs.mcpServer.exposeEditTool", cfg.mcp.exposeEditTool)

  // secrets the extension would read from the OS keychain
  const resolvers = new Map<string, SecretResolver>()
  for (const [rawId, sys] of Object.entries(cfg.systems)) {
    const id = rawId.toLowerCase()
    resolvers.set(`vscode.abapfs.${id}:${sys.username}`, () => resolvePassword(sys) || undefined)
    if (sys.certPassphrase) resolvers.set(`vscode.abapfs.cert:${id}`, () => sys.certPassphrase)
  }
  for (const [k, v] of Object.entries(cfg.secrets)) resolvers.set(k, () => v)

  runtime.contributedTools.clear()
  for (const t of (manifest.contributes?.languageModelTools ?? []) as ContributedTool[])
    runtime.contributedTools.set(t.name, t)

  runtime.extensionIds.clear()
  for (const e of cfg.extensions) runtime.extensionIds.add(e.toLowerCase())

  // every configured system is a "connected" workspace folder adt://<id>/ (logon is lazy)
  runtime.setFolders(Object.keys(cfg.systems))
  return resolvers
}

/** Connection ids a tool call refers to: connectionId-like fields and adt://<id>/ URIs */
export function referencedSystems(input: unknown): Set<string> {
  const ids = new Set<string>()
  const visit = (v: unknown, key = "", depth = 0) => {
    if (depth > 4 || v == null) return
    if (typeof v === "string") {
      if (/^(connectionId|connId|sourceConnectionId|targetConnectionId|system)$/i.test(key) && v) ids.add(v.toLowerCase())
      for (const m of v.matchAll(/\badt:\/\/([\w-]+)/gi)) ids.add(m[1]!.toLowerCase())
      return
    }
    if (Array.isArray(v)) return v.forEach(x => visit(x, key, depth + 1))
    if (typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k, depth + 1)
  }
  visit(input)
  return ids
}

export interface HeadlessRuntime {
  context: ReturnType<typeof createExtensionContext>
  toolNames(): string[]
  dispose(): Promise<void>
}

export async function activateHeadless(cfg: HeadlessConfig): Promise<HeadlessRuntime> {
  const secretResolvers = applyConfig(cfg)
  const context = createExtensionContext({
    extensionPath: extensionPath(),
    stateDir: cfg.stateDir,
    packageJSON: manifest,
    secretResolvers
  })

  runtime.ownExtension = context.extension

  const ext = await import("upstream:extension")
  ;(ext as any).__headlessSetContext(context)

  // local, file-based usage statistics (globalStorage/telemetry). App Insights stays off headless.
  const { TelemetryService } = await import("upstream:services/telemetry")
  TelemetryService.initialize(context as any)

  const { registerBdefType } = await import("upstream:adt/operations/BdefCreator")
  registerBdefType()

  const { SapSystemValidator } = await import("upstream:services/sapSystemValidator")
  await SapSystemValidator.getInstance()
    .initialize()
    .catch((e: unknown) => log.warn(`SAP system validator: ${e}`))

  const { PasswordVault } = await import("upstream:lib")
  new PasswordVault(context as any)
  const { loadTokens } = await import("upstream:oauth")
  loadTokens()

  const { ADTSCHEME } = await import("upstream:adt/conections")
  const { FsProvider } = await import("upstream:fs/FsProvider")
  const { workspace } = await import("vscode")
  context.subscriptions.push(workspace.registerFileSystemProvider(ADTSCHEME, FsProvider.get(context as any), { isCaseSensitive: true }))

  // commands: several tools delegate to them (object creation, test includes, ...)
  await import("upstream:commands")
  const { registerCommands } = await import("upstream:commands/register")
  registerCommands(context as any)

  // VS Code connects every workspace folder when it opens; headless connects on first use
  const { getOrCreateClient } = await import("upstream:adt/conections")
  const configured = new Set(Object.keys(cfg.systems).map(k => k.toLowerCase()))
  runtime.beforeToolInvoke = async (_name, input) => {
    for (const id of referencedSystems(input))
      if (configured.has(id))
        await getOrCreateClient(id).catch((e: unknown) => {
          throw new Error(`Cannot connect to ${id}: ${e instanceof Error ? e.message : e}`)
        })
  }

  const { registerAllTools } = await import("upstream:services/lm-tools")
  await registerAllTools(context as any)
  // registered separately in upstream's activate()
  const { registerChatTools } = await import("upstream:adt/ai/tools")
  registerChatTools(context as any)

  return {
    context,
    toolNames: () => [...runtime.tools.keys()],
    async dispose() {
      const { disconnect } = await import("upstream:adt/conections")
      await Promise.race([disconnect([], true), new Promise(r => setTimeout(r, 5000))]).catch(() => undefined)
      for (const s of context.subscriptions.splice(0))
        try {
          s.dispose()
        } catch {
          /* ignore */
        }
    }
  }
}
