/** Build a headless config from the ABAP FS settings of a local VS Code installation */
import { existsSync, readFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import { parse, type ParseError } from "jsonc-parser/lib/esm/main.js"

export function vscodeSettingsCandidates(): string[] {
  const home = homedir()
  const bases =
    platform() === "darwin"
      ? [join(home, "Library", "Application Support")]
      : platform() === "win32"
        ? [process.env.APPDATA ?? join(home, "AppData", "Roaming")]
        : [process.env.XDG_CONFIG_HOME ?? join(home, ".config")]
  const products = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"]
  return bases.flatMap(b => products.map(p => join(b, p, "User", "settings.json")))
}

const envName = (id: string) => `ABAPFS_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PASSWORD`

export function configFromVscodeSettings(settingsPath?: string) {
  const path = settingsPath ?? vscodeSettingsCandidates().find(p => existsSync(p))
  if (!path || !existsSync(path))
    throw new Error(
      `VS Code settings not found (looked in ${vscodeSettingsCandidates().join(", ")})`
    )
  const errors: ParseError[] = []
  const settings = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true }) ?? {}
  if (errors.length) throw new Error(`Cannot parse ${path}`)

  // settings may be flat ("abapfs.remote") or nested ({ abapfs: { remote } })
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries<any>(settings)) {
    if (k === "abapfs" && v && typeof v === "object")
      for (const [k2, v2] of Object.entries(v)) flat[`abapfs.${k2}`] = v2
    else if (k.startsWith("abapfs.")) flat[k] = v
  }
  const remotes = (flat["abapfs.remote"] ?? {}) as Record<string, Record<string, unknown>>
  delete flat["abapfs.remote"]
  // the MCP block replaces these
  for (const k of Object.keys(flat)) if (k.startsWith("abapfs.mcpServer")) delete flat[k]

  const systems: Record<string, unknown> = {}
  const env: string[] = []
  for (const [id, remote] of Object.entries(remotes)) {
    const { password, ...rest } = remote
    const authMethod = (rest.authMethod as string | undefined) ?? "basic"
    const sys: Record<string, unknown> = { ...rest }
    if (authMethod === "basic") {
      sys.password = `\${env:${envName(id)}}`
      env.push(envName(id))
      if (password) sys.password = `\${env:${envName(id)}}` // never copy plain text passwords
    }
    systems[id] = sys
  }
  return {
    source: path,
    env,
    config: { systems, mcp: { transport: "stdio", port: 4847 }, settings: flat, logLevel: "warn" }
  }
}
