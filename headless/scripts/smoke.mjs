// End-to-end smoke test: spawn the built server over stdio, list tools, call the tools that
// work without an SAP system. Used locally and by the nightly upstream sync.
//
//   node scripts/smoke.mjs [--min-tools N]
// Exit code 0 = healthy. Prints a JSON report on stdout.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, "..", "package.json"))
const sdk = p => import(require.resolve(`@modelcontextprotocol/sdk/${p}`))
const { Client } = await sdk("client/index.js")
const { StdioClientTransport } = await sdk("client/stdio.js")

const minIdx = process.argv.indexOf("--min-tools")
const minTools = minIdx > 0 ? Number(process.argv[minIdx + 1]) : 40

const dir = mkdtempSync(join(tmpdir(), "abapfs-smoke-"))
const configPath = join(dir, "config.json")
writeFileSync(
  configPath,
  JSON.stringify({
    systems: { smoke100: { url: "http://127.0.0.1:9", username: "SMOKE", password: "x", client: "100" } },
    stateDir: join(dir, "state"),
    logLevel: "error"
  })
)

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(here, "..", "dist", "cli.js"), "serve", "--config", configPath],
  stderr: "pipe"
})
let stderr = ""
transport.stderr?.on("data", d => (stderr += d))
const client = new Client({ name: "abapfs-smoke", version: "1.0.0" })

const report = { ok: false, tools: 0, calls: {}, errors: [] }
const fail = m => report.errors.push(m)
try {
  await client.connect(transport)
  const { tools } = await client.listTools()
  report.tools = tools.length
  report.toolNames = tools.map(t => t.name).sort()
  if (tools.length < minTools) fail(`only ${tools.length} tools exposed, expected >= ${minTools}`)
  // parity: every tool upstream's manifest exposes over MCP (tag "abap-fs") must be served
  const manifest = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8"))
  const expected = (manifest.contributes?.languageModelTools ?? [])
    .filter(t => t.tags?.includes("abap-fs"))
    .map(t => t.name)
  const served = new Set(tools.map(t => t.name))
  report.missingFromManifest = expected.filter(n => !served.has(n))
  if (report.missingFromManifest.length)
    fail(`upstream tools not served headless: ${report.missingFromManifest.join(", ")}`)
  for (const name of ["abapfs_search_objects", "abapfs_get_object_source", "replace_string_in_abap_object", "get_abap_diagnostics"])
    if (!tools.some(t => t.name === name)) fail(`core tool missing: ${name}`)

  const call = async (name, args, check) => {
    if (!tools.some(t => t.name === name)) return
    try {
      const r = await client.callTool({ name, arguments: args })
      const text = r.content?.map(c => c.text ?? "").join("\n") ?? ""
      report.calls[name] = { isError: !!r.isError, chars: text.length, head: text.slice(0, 160) }
      const problem = check(r, text)
      if (problem) fail(`${name}: ${problem}`)
    } catch (e) {
      fail(`${name} threw: ${e.message}`)
    }
  }
  // offline tools: must succeed
  await call("abapfs_get_configured_systems", {}, (r, t) => (r.isError ? t : !/smoke100/i.test(t) && "system not listed"))
  await call("abapfs_get_sql_syntax", {}, (r, t) => (r.isError ? t : t.length < 200 && "suspiciously short"))
  await call("abapfs_search_documentation", { action: "search_documentation", searchQuery: "transport" }, r => r.isError && "error")
  // online tool against an unreachable system: must fail cleanly, not crash the server
  await call("abapfs_search_objects", { connectionId: "smoke100", pattern: "CL_ABAP_TYPEDESCR", types: ["CLAS"] }, () => undefined)
  const again = await client.listTools().catch(e => fail(`server died after failed SAP call: ${e.message}`))
  if (again && again.tools.length !== tools.length) fail("tool list changed after calls")
} catch (e) {
  fail(`MCP session failed: ${e.message}`)
} finally {
  await client.close().catch(() => undefined)
}
report.ok = report.errors.length === 0
if (!report.ok) report.stderrTail = stderr.split("\n").slice(-30).join("\n")
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
