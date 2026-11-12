import { cpSync, copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "tsdown"

// Bundles upstream's client sources (client/src) together with the headless runtime into a
// single ESM file. Upstream code is consumed untouched; the only interventions are:
//   - "vscode" is aliased to the generated shim (src/vscode/index.ts)
//   - every import of client/src/langClient.ts is redirected to src/overrides/langClient.ts
//   - two upstream module-internal bindings get an extra export appended (see `exposeInternals`)
// A build error here after an upstream merge means one of those hooks no longer matches.

const here = dirname(fileURLToPath(import.meta.url))
const at = (p: string) => resolve(here, p)
const clientSrc = at("../client/src")
const LANGCLIENT = resolve(clientSrc, "langClient.ts")
const LANGCLIENT_OVERRIDE = at("src/overrides/langClient.ts")

const exposeInternals: Record<string, { needle: RegExp; append: string }> = {
  [resolve(clientSrc, "services/mcpServer.ts")]: {
    needle: /\nfunction createMcpServer\(\)/,
    append: "\nexport { createMcpServer as __headlessCreateMcpServer }\n"
  },
  [resolve(clientSrc, "extension.ts")]: {
    needle: /\nexport let context: ExtensionContext/,
    append: "\nexport function __headlessSetContext(c: ExtensionContext) { context = c }\n"
  }
}

const norm = (p: string) => p.replace(/\\/g, "/")

const upstreamPlugin = {
  name: "abapfs-headless:upstream",
  async resolveId(this: any, source: string, importer: string | undefined) {
    // "upstream-dep:pkg": a dependency resolved from upstream's client package, so patches and
    // instanceof checks apply to the very module instance upstream code uses
    if (source.startsWith("upstream-dep:")) {
      const dep = source.slice("upstream-dep:".length)
      const r = await this.resolve(dep, resolve(clientSrc, "extension.ts"), { skipSelf: true })
      if (!r) throw new Error(`Cannot resolve ${dep} from upstream's client`)
      return r
    }
    if (source.startsWith("upstream:")) {
      const target = resolve(clientSrc, source.slice("upstream:".length))
      const r = await this.resolve(target, importer, { skipSelf: true })
      if (!r) throw new Error(`Cannot resolve ${source} (${target})`)
      return r
    }
    if (!importer || norm(importer) === norm(LANGCLIENT_OVERRIDE)) return null
    if (!/langClient/.test(source)) return null
    const r = await this.resolve(source, importer, { skipSelf: true })
    if (r && norm(r.id) === norm(LANGCLIENT)) return LANGCLIENT_OVERRIDE
    return null
  },
  transform(code: string, id: string) {
    const hook = exposeInternals[resolve(id.replace(/\?.*$/, ""))]
    if (!hook) return null
    if (!hook.needle.test(code))
      throw new Error(
        `abapfs-headless: ${id} no longer matches ${hook.needle} — update tsdown.config.ts`
      )
    return { code: code + hook.append, map: null }
  }
}

function copyDir(src: string, dest: string) {
  if (!existsSync(src)) throw new Error(`asset missing: ${src}`)
  mkdirSync(dest, { recursive: true })
  cpSync(realpathSync(src), dest, { recursive: true, force: true, dereference: true })
}

const copyAssets = {
  name: "abapfs-headless:assets",
  writeBundle() {
    // same layout as the installed extension: <ext>/client/dist/media, <ext>/client/media
    const ext = at("dist/extension")
    copyDir(at("../client/media"), resolve(ext, "client/media"))
    copyDir(at("../client/media"), resolve(ext, "client/dist/media"))
    copyFileSync(at("../DOCUMENTATION.md"), resolve(ext, "client/dist/media/DOCUMENTATION.md"))
    copyFileSync(at("../package.json"), resolve(ext, "package.json"))
  }
}

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node20",
  dts: false,
  clean: true,
  sourcemap: true,
  minify: false,
  shims: true,
  tsconfig: "tsconfig.json",
  outExtensions: () => ({ js: ".js" }),
  deps: { alwaysBundle: [/.*/] },
  // optional native/browser-only packages pulled in by UI code paths never used headless
  inputOptions: {
    external: [/^@playwright\//, /^playwright(-core)?$/, "keytar", "bufferutil", "utf-8-validate"],
    resolve: { alias: { vscode: at("src/vscode/index.ts") } }
  },
  outputOptions: { codeSplitting: false, banner: "#!/usr/bin/env node" },
  plugins: [upstreamPlugin, copyAssets]
})
