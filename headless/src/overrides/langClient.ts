/**
 * Replaces client/src/langClient.ts for every upstream importer (see tsdown.config.ts).
 *
 * In VS Code, syntax checks run in the ABAP language server, a separate LSP process driven by
 * vscode-languageclient. That client cannot run without the editor, so this module re-exports
 * the original and swaps `triggerSyntaxCheck` for a direct ADT syntax check. Results go into a
 * diagnostic collection, so upstream's getDiagnosticsForUri / get_abap_diagnostics work unchanged.
 */
import { Diagnostic, DiagnosticSeverity, Position, Range, Uri, languages, workspace } from "vscode"
import { isAbapFile } from "abapfs"
// "upstream:" ids are resolved by the build to client/src (the bare path would loop back here)
import { vsCodeUri } from "upstream:langClient"
import { getClient, getOrCreateRoot } from "upstream:adt/conections"
import { IncludeService } from "upstream:adt/includes"

export * from "upstream:langClient"

const collection = languages.createDiagnosticCollection("abapfs")
/** uris that received diagnostics from a check of a given document, to clear them next time */
const previousTargets = new Map<string, string[]>()

const severity = (s: string) => {
  switch (s) {
    case "E":
    case "A":
    case "X":
      return DiagnosticSeverity.Error
    case "W":
      return DiagnosticSeverity.Warning
    case "I":
    case "S":
      return DiagnosticSeverity.Information
  }
  return DiagnosticSeverity.Warning
}

const endIdent = /([\w/$%<>~-]+)$/
const startIdent = /^([\w/$%<>~-]+)/

/** Same token-range heuristic as the language server's sourceRange */
function sourceRange(source: string, oline: number, character: number) {
  const line = oline === 0 ? 0 : oline - 1
  const lineText = source.split(/\r?\n/)[line] ?? ""
  let startChar = character
  const lastword = lineText.slice(0, character).match(endIdent)
  if (lastword) startChar -= lastword[1]!.length
  const match = lineText.slice(startChar).match(startIdent)
  const endChar = startChar + (match ? match[1]!.length : 1)
  return new Range(new Position(line, startChar), new Position(line, endChar))
}

export async function triggerSyntaxCheck(uri: string) {
  const docUri = Uri.parse(uri)
  const connId = docUri.authority
  const root = await getOrCreateRoot(connId)
  const node = await root.getNodeAsync(docUri.path)
  if (!isAbapFile(node)) return
  if (!node.object.structure) await node.object.loadStructure()
  const client = getClient(connId)

  const url = node.object.path
  const mainUrl = node.object.contentsPath()
  let mainProgram: string | undefined
  if (node.object.type === "PROG/I") {
    mainProgram = IncludeService.get(connId)?.current(docUri.path)?.["adtcore:uri"]
    if (!mainProgram) mainProgram = (await client.mainPrograms(url))[0]?.["adtcore:uri"]
    if (!mainProgram) return // includes without a main program can't be checked
  }

  const open = workspace.textDocuments.find((d: any) => d.uri.toString() === docUri.toString())
  const source: string = open ? open.getText() : await client.getObjectSource(mainUrl, { version: "inactive" })
  const checks = await client.syntaxCheck(url, mainUrl, source, mainProgram)

  const byTarget = new Map<string, { uri: any; diags: any[] }>()
  for (const key of previousTargets.get(uri) ?? []) byTarget.set(key, { uri: Uri.parse(key), diags: [] })
  byTarget.set(uri, { uri: docUri, diags: [] })
  const sources = new Map<string, string>()

  for (const c of checks ?? []) {
    let target = docUri
    let text = source
    if (c.uri !== mainUrl) {
      try {
        target = Uri.parse(await vsCodeUri(connId, c.uri, true))
        const base = c.uri.replace(/[?#].*/, "")
        if (!sources.has(base)) sources.set(base, await client.getObjectSource(base, { version: "inactive" }))
        text = sources.get(base)!
      } catch {
        continue
      }
    }
    const key = target.toString()
    const entry = byTarget.get(key) ?? { uri: target, diags: [] }
    const d = new Diagnostic(sourceRange(text, c.line, c.offset), c.text, severity(c.severity))
    d.source = "ABAPfs"
    entry.diags.push(d)
    byTarget.set(key, entry)
  }

  for (const { uri: u, diags } of byTarget.values()) collection.set(u, diags)
  previousTargets.set(
    uri,
    [...byTarget.entries()].filter(([k, v]) => k !== uri && v.diags.length).map(([k]) => k)
  )
}
