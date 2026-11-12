/**
 * JSON configuration for the headless ABAP FS MCP server.
 *
 * Replaces everything the VS Code extension keeps in settings.json and in the OS keychain:
 *   - systems   -> `abapfs.remote` (same fields), plus the password (literal, ${env:VAR} or a command)
 *   - mcp       -> transport / port / API key of the MCP server
 *   - settings  -> any other `abapfs.*` setting, by its VS Code id
 *   - secrets   -> raw entries of the extension's secret storage (rarely needed)
 * Any string may reference an environment variable as ${env:NAME}.
 */
import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { z } from "zod/v4"
import { readStoredPassword, secretStoreName } from "./secretStore"

export const systemSchema = z
  .looseObject({
    url: z.string().describe("Base URL of the ABAP server, e.g. https://host:44300"),
    username: z.string().describe("SAP user"),
    password: z
      .string()
      .optional()
      .describe(
        "Password. Leave out (with passwordCommand) to use the OS credential store, see `abapfs-mcp password set`"
      ),
    passwordCommand: z
      .string()
      .optional()
      .describe(
        "Shell command printing the password, e.g. `security find-generic-password -s sap-dev -w`"
      ),
    client: z.string().default("").describe("SAP client (Mandant), e.g. 100"),
    language: z.string().default("EN").describe("Logon language"),
    readOnly: z
      .boolean()
      .optional()
      .describe(
        "Refuse every tool and ADT call that changes this system or runs code on it (edit, create, activate, transports, unit tests, debugger)"
      ),
    allowSelfSigned: z.boolean().optional().describe("Accept self-signed TLS certificates"),
    customCA: z.string().optional().describe("Path to a PEM CA bundle"),
    atcVariant: z.string().optional().describe("ATC check variant"),
    atcapprover: z.string().optional().describe("ATC exemption approver"),
    diff_formatter: z.string().optional(),
    authMethod: z
      .enum(["basic", "cert", "kerberos", "browser_sso", "oauth_onprem"])
      .optional()
      .describe("basic (default) or cert work headless; the others need a browser or Windows SSPI"),
    certAuth: z
      .looseObject({
        certPath: z.string(),
        keyPath: z.string().optional(),
        caPath: z.string().optional()
      })
      .optional()
      .describe("X.509 client certificate (authMethod cert)"),
    certPassphrase: z.string().optional().describe("Passphrase of the client certificate key"),
    landscape: z.string().optional().describe("Free text: landscape this system belongs to"),
    clientType: z.string().optional().describe("Free text: role, e.g. Development, QA, Production"),
    sapGui: z.record(z.string(), z.unknown()).optional().describe("SAP GUI connection data")
  })
  .describe("Same fields as an `abapfs.remote` entry in VS Code, plus how to get the password")

export const mcpSchema = z.strictObject({
  transport: z
    .enum(["stdio", "http"])
    .default("stdio")
    .describe(
      "stdio: the MCP client spawns the server. http: long-running server on host:port/mcp"
    ),
  host: z.string().default("127.0.0.1").describe("HTTP bind address"),
  port: z.number().int().positive().default(4847).describe("HTTP port"),
  apiKey: z
    .string()
    .optional()
    .describe("When set, HTTP clients must send Authorization: Bearer <key>"),
  exposeEditTool: z.boolean().default(true).describe("Expose replace_string_in_abap_object")
})

export const configSchema = z.strictObject({
  $schema: z.string().optional(),
  systems: z
    .record(z.string(), systemSchema)
    .superRefine((systems, ctx) => {
      for (const id of Object.keys(systems))
        if (!/^[\w-]{3,}$/.test(id))
          ctx.addIssue({
            code: "custom",
            path: [id],
            message: `System id '${id}': use 3+ characters: letters, digits, - and _`
          })
    })
    .describe("ABAP systems by connection id, as used in the tools' connectionId parameter"),
  mcp: mcpSchema.default(mcpSchema.parse({})),
  settings: z
    .record(z.string(), z.unknown())
    .default({})
    .describe('Any other ABAP FS setting by its VS Code id, e.g. "abapfs.atc.autoRefresh": true'),
  secrets: z.record(z.string(), z.string()).default({}).describe("Raw secret storage entries"),
  extensions: z
    .array(z.string())
    .default([])
    .describe("VS Code extension ids to report as installed to tools that check for them"),
  stateDir: z.string().optional().describe("Where state (globalState, tool caches) is kept"),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("warn")
})

export type SystemConfig = z.infer<typeof systemSchema>
export type McpConfig = z.infer<typeof mcpSchema>
export type HeadlessConfig = z.infer<typeof configSchema> & { configPath: string; stateDir: string }

const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

/** What to do with an unset variable at a path: return a replacement, or throw */
export type MissingEnv = (name: string, path: string[]) => string | undefined

const throwMissing: MissingEnv = name => {
  throw new Error(`Environment variable ${name} is not set`)
}

/** Replace ${env:NAME} references in every string of a parsed JSON value */
export function interpolateEnv<T>(
  value: T,
  env: NodeJS.ProcessEnv = process.env,
  onMissing: MissingEnv = throwMissing,
  path: string[] = []
): T {
  if (typeof value === "string") {
    let missing = false
    const out = value.replace(ENV_REF, (_, name: string) => {
      const v = env[name]
      if (v !== undefined) return v
      const r = onMissing(name, path)
      if (r === undefined) missing = true
      return r ?? ""
    })
    return (missing ? undefined : out) as T
  }
  if (Array.isArray(value))
    return value.map((v, i) => interpolateEnv(v, env, onMissing, [...path, String(i)])) as T
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .map(([k, v]) => [k, interpolateEnv(v, env, onMissing, [...path, k])])
        .filter(([, v]) => v !== undefined)
    ) as T
  return value
}

const isWindows = () => process.platform === "win32"
const xdgConfigHome = () => process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
/** Per-user config folder: %APPDATA% on Windows, $XDG_CONFIG_HOME or ~/.config elsewhere */
const configHome = () =>
  isWindows() ? process.env.APPDATA || join(homedir(), "AppData", "Roaming") : xdgConfigHome()
/** Per-user state folder: %LOCALAPPDATA% on Windows, $XDG_STATE_HOME or ~/.local/state elsewhere */
export const stateHome = () =>
  isWindows()
    ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
    : process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")

export const defaultConfigLocations = () => {
  const list = [resolve("abapfs.json"), join(configHome(), "abapfs", "config.json")]
  // ~/.config works on Windows too (shared dotfiles)
  if (isWindows()) list.push(join(xdgConfigHome(), "abapfs", "config.json"))
  return list
}

export function findConfigFile(explicit?: string): string {
  const candidate = explicit || process.env.ABAPFS_CONFIG
  if (candidate) {
    const p = resolve(candidate)
    if (!existsSync(p)) throw new Error(`Config file not found: ${p}`)
    return p
  }
  const found = defaultConfigLocations().find(p => existsSync(p))
  if (!found)
    throw new Error(
      `No config file found. Pass --config, set ABAPFS_CONFIG, or create one of:\n  ${defaultConfigLocations().join("\n  ")}\nRun \`abapfs-mcp init\` to write a template.`
    )
  return found
}

const expandHome = (p: string) => (/^~[/\\]/.test(p) ? join(homedir(), p.slice(2)) : p)

export function parseConfig(raw: unknown, configPath = "<inline>"): HeadlessConfig {
  const result = configSchema.safeParse(raw)
  if (!result.success)
    throw new Error(`Invalid config ${configPath}:\n${z.prettifyError(result.error)}`)
  const cfg = result.data
  const base = configPath.startsWith("<") ? process.cwd() : dirname(configPath)
  const abs = (p?: string) => {
    if (!p || p.includes("-----BEGIN")) return p
    const e = expandHome(p)
    return isAbsolute(e) ? e : join(base, e)
  }
  for (const sys of Object.values(cfg.systems)) {
    sys.customCA = abs(sys.customCA)
    if (sys.certAuth) {
      sys.certAuth.certPath = abs(sys.certAuth.certPath)!
      sys.certAuth.keyPath = abs(sys.certAuth.keyPath)
      sys.certAuth.caPath = abs(sys.certAuth.caPath)
    }
  }
  const stateDir = abs(cfg.stateDir) ?? join(stateHome(), "abapfs-mcp")
  return { ...cfg, configPath, stateDir }
}

export function loadConfig(explicit?: string): HeadlessConfig {
  const path = findConfigFile(explicit)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    throw new Error(`Cannot parse ${path}: ${(e as Error).message}`)
  }
  // an unset password variable only disables that system, with a clear message on first use
  const missingPasswords = new Map<string, string>()
  const onMissing: MissingEnv = (name, p) => {
    if (p.length === 3 && p[0] === "systems" && /^(password|certPassphrase)$/.test(p[2]!)) {
      missingPasswords.set(p[1]!, name)
      return undefined
    }
    return throwMissing(name, p)
  }
  const cfg = parseConfig(interpolateEnv(raw, process.env, onMissing), path)
  for (const [id, name] of missingPasswords)
    (cfg.systems[id] as Record<string, unknown>).passwordEnv = name
  return cfg
}

const needsPassword = (sys: SystemConfig) => !sys.authMethod || sys.authMethod === "basic"

/**
 * Password of a system: literal value (or ${env:VAR}), then passwordCommand, then the OS
 * credential store entry for the system id (see `abapfs-mcp password set <id>`).
 */
export function resolvePassword(sys: SystemConfig, id: string): string {
  if (sys.password) return sys.password
  if (sys.passwordCommand)
    return execSync(sys.passwordCommand, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }).replace(/\r?\n$/, "")
  if (typeof sys.passwordEnv === "string")
    throw new Error(`No password: environment variable ${sys.passwordEnv} is not set`)
  if (!needsPassword(sys)) return ""
  const stored = readStoredPassword(id)
  if (stored !== undefined) return stored
  throw new Error(
    `No password for ${id}: run \`abapfs-mcp password set ${id}\` to store it in the ${secretStoreName()}`
  )
}

export const configJsonSchema = () =>
  z.toJSONSchema(configSchema, { io: "input", unrepresentable: "any" })

export const configTemplate = () => ({
  $schema:
    "https://raw.githubusercontent.com/FrankRogalski/vscode_abap_remote_fs/master/headless/config.schema.json",
  systems: {
    dev100: {
      url: "https://my-sap-host:44300",
      username: "DEVELOPER",
      client: "100",
      language: "EN",
      allowSelfSigned: false,
      clientType: "Development"
    }
  },
  mcp: { transport: "stdio", host: "127.0.0.1", port: 4847, exposeEditTool: true },
  settings: {},
  logLevel: "warn"
})
