/**
 * Working implementation of the parts of the VS Code API the ABAP FS tools rely on.
 *
 * Exported names here override the generated stubs in ./index.ts. `runtime` is the control
 * surface used by the headless entry point (settings, secrets, workspace folders, tool registry).
 *
 * Never import "vscode" from this file: "vscode" resolves to ./index.ts, which imports this one.
 */
import { existsSync, promises as fsp } from "node:fs"
import { dirname, extname } from "node:path"
import { URI, Utils } from "vscode-uri"
import { log } from "../log"

// ---------------------------------------------------------------------------------------------
// basic value types
// ---------------------------------------------------------------------------------------------

// vscode.Uri has a few statics vscode-uri keeps in Utils
const UriClass = URI as any
if (!UriClass.joinPath)
  UriClass.joinPath = (base: URI, ...paths: string[]) => Utils.joinPath(base, ...paths)
export const Uri = UriClass as typeof URI & { joinPath(base: URI, ...p: string[]): URI }

export class Disposable {
  constructor(private callOnDispose: () => unknown = () => undefined) {}
  static from(...items: { dispose(): unknown }[]) {
    return new Disposable(() => items.forEach(i => i?.dispose?.()))
  }
  dispose() {
    const f = this.callOnDispose
    this.callOnDispose = () => undefined
    f()
  }
}

type Listener<T> = (e: T) => unknown
export class EventEmitter<T> {
  private listeners = new Set<Listener<T>>()
  readonly event = (listener: Listener<T>, thisArgs?: unknown, disposables?: Disposable[]) => {
    const bound: Listener<T> = thisArgs ? listener.bind(thisArgs) : listener
    this.listeners.add(bound)
    const d = new Disposable(() => this.listeners.delete(bound))
    disposables?.push(d)
    return d
  }
  fire(data: T) {
    for (const l of [...this.listeners])
      try {
        l(data)
      } catch (e) {
        log.warn(`event listener failed: ${e}`)
      }
  }
  dispose() {
    this.listeners.clear()
  }
}

export class CancellationError extends Error {
  constructor() {
    super("Canceled")
    this.name = "Canceled"
  }
}

export class CancellationTokenSource {
  private emitter = new EventEmitter<void>()
  private cancelled = false
  readonly token: {
    readonly isCancellationRequested: boolean
    onCancellationRequested: EventEmitter<void>["event"]
  }
  constructor() {
    const isCancelled = () => this.cancelled
    this.token = {
      get isCancellationRequested() {
        return isCancelled()
      },
      onCancellationRequested: this.emitter.event
    }
  }
  cancel() {
    if (!this.cancelled) {
      this.cancelled = true
      this.emitter.fire()
    }
  }
  dispose() {
    this.emitter.dispose()
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number
  ) {}
  isBefore(o: Position) {
    return this.line < o.line || (this.line === o.line && this.character < o.character)
  }
  isBeforeOrEqual(o: Position) {
    return this.isBefore(o) || this.isEqual(o)
  }
  isAfter(o: Position) {
    return !this.isBeforeOrEqual(o)
  }
  isAfterOrEqual(o: Position) {
    return !this.isBefore(o)
  }
  isEqual(o: Position) {
    return this.line === o.line && this.character === o.character
  }
  compareTo(o: Position) {
    return this.isBefore(o) ? -1 : this.isEqual(o) ? 0 : 1
  }
  translate(
    lineDelta: number | { lineDelta?: number; characterDelta?: number } = 0,
    characterDelta = 0
  ) {
    if (typeof lineDelta === "object")
      return new Position(
        this.line + (lineDelta.lineDelta ?? 0),
        this.character + (lineDelta.characterDelta ?? 0)
      )
    return new Position(this.line + lineDelta, this.character + characterDelta)
  }
  with(
    line: number | { line?: number; character?: number } = this.line,
    character = this.character
  ) {
    if (typeof line === "object")
      return new Position(line.line ?? this.line, line.character ?? this.character)
    return new Position(line, character)
  }
}

export class Range {
  readonly start: Position
  readonly end: Position
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    const s = typeof a === "number" ? new Position(a, b as number) : a
    const e = typeof a === "number" ? new Position(c!, d!) : (b as Position)
    ;[this.start, this.end] = s.isBeforeOrEqual(e) ? [s, e] : [e, s]
  }
  get isEmpty() {
    return this.start.isEqual(this.end)
  }
  get isSingleLine() {
    return this.start.line === this.end.line
  }
  contains(p: Position | Range): boolean {
    if (p instanceof Range) return this.contains(p.start) && this.contains(p.end)
    return p.isAfterOrEqual(this.start) && p.isBeforeOrEqual(this.end)
  }
  isEqual(o: Range) {
    return this.start.isEqual(o.start) && this.end.isEqual(o.end)
  }
  intersection(o: Range) {
    const start = this.start.isAfter(o.start) ? this.start : o.start
    const end = this.end.isBefore(o.end) ? this.end : o.end
    return start.isAfter(end) ? undefined : new Range(start, end)
  }
  union(o: Range) {
    return new Range(
      this.start.isBefore(o.start) ? this.start : o.start,
      this.end.isAfter(o.end) ? this.end : o.end
    )
  }
  with(start: Position | { start?: Position; end?: Position } = this.start, end = this.end) {
    if (start instanceof Position) return new Range(start, end)
    return new Range(start.start ?? this.start, start.end ?? this.end)
  }
}

export class Selection extends Range {
  constructor(
    readonly anchor: Position,
    readonly active: Position
  ) {
    super(anchor, active)
  }
  get isReversed() {
    return this.anchor.isAfter(this.active)
  }
}

export class Location {
  readonly range: Range
  constructor(
    readonly uri: URI,
    rangeOrPosition: Range | Position
  ) {
    this.range =
      rangeOrPosition instanceof Position
        ? new Range(rangeOrPosition, rangeOrPosition)
        : rangeOrPosition
  }
}

export class Diagnostic {
  source?: string
  code?: string | number | { value: string | number; target: URI }
  relatedInformation?: unknown[]
  tags?: number[]
  constructor(
    public range: Range,
    public message: string,
    public severity = 0
  ) {}
}

export class TextEdit {
  constructor(
    public range: Range,
    public newText: string
  ) {}
  static replace(range: Range, newText: string) {
    return new TextEdit(range, newText)
  }
  static insert(position: Position, newText: string) {
    return new TextEdit(new Range(position, position), newText)
  }
  static delete(range: Range) {
    return new TextEdit(range, "")
  }
}

export class WorkspaceEdit {
  private edits = new Map<string, { uri: URI; edits: TextEdit[] }>()
  private add(uri: URI, edit: TextEdit) {
    const key = uri.toString()
    const entry = this.edits.get(key) ?? { uri, edits: [] }
    entry.edits.push(edit)
    this.edits.set(key, entry)
  }
  replace(uri: URI, range: Range, newText: string) {
    this.add(uri, TextEdit.replace(range, newText))
  }
  insert(uri: URI, position: Position, newText: string) {
    this.add(uri, TextEdit.insert(position, newText))
  }
  delete(uri: URI, range: Range) {
    this.add(uri, TextEdit.delete(range))
  }
  set(uri: URI, edits: TextEdit[]) {
    this.edits.set(uri.toString(), { uri, edits: [...edits] })
  }
  get(uri: URI) {
    return this.edits.get(uri.toString())?.edits ?? []
  }
  has(uri: URI) {
    return this.edits.has(uri.toString())
  }
  entries(): [URI, TextEdit[]][] {
    return [...this.edits.values()].map(e => [e.uri, e.edits])
  }
  get size() {
    return this.edits.size
  }
}

export class MarkdownString {
  isTrusted?: boolean
  supportHtml?: boolean
  supportThemeIcons?: boolean
  constructor(public value = "") {}
  appendText(t: string) {
    this.value += t.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&")
    return this
  }
  appendMarkdown(t: string) {
    this.value += t
    return this
  }
  appendCodeblock(code: string, language = "") {
    this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`
    return this
  }
}

export class ThemeIcon {
  static readonly File = new ThemeIcon("file")
  static readonly Folder = new ThemeIcon("folder")
  constructor(
    readonly id: string,
    readonly color?: unknown
  ) {}
}
export class ThemeColor {
  constructor(readonly id: string) {}
}

export class TreeItem {
  [k: string]: unknown
  constructor(
    public label?: unknown,
    public collapsibleState?: number
  ) {
    if (label instanceof URI) {
      this.resourceUri = label
      this.label = undefined
    }
  }
}

export class RelativePattern {
  constructor(
    public base: unknown,
    public pattern: string
  ) {}
}

export class FileSystemError extends Error {
  constructor(
    messageOrUri?: unknown,
    readonly code = "Unknown"
  ) {
    super(messageOrUri === undefined ? code : String(messageOrUri))
    this.name = `${code} (FileSystemError)`
  }
  static FileNotFound(m?: unknown) {
    return new FileSystemError(m ?? "File not found", "FileNotFound")
  }
  static FileExists(m?: unknown) {
    return new FileSystemError(m ?? "File exists", "FileExists")
  }
  static FileNotADirectory(m?: unknown) {
    return new FileSystemError(m ?? "Not a directory", "FileNotADirectory")
  }
  static FileIsADirectory(m?: unknown) {
    return new FileSystemError(m ?? "Is a directory", "FileIsADirectory")
  }
  static NoPermissions(m?: unknown) {
    return new FileSystemError(m ?? "No permissions", "NoPermissions")
  }
  static Unavailable(m?: unknown) {
    return new FileSystemError(m ?? "Unavailable", "Unavailable")
  }
}

// language model tool result parts
export class LanguageModelTextPart {
  constructor(public value: string) {}
}
export class LanguageModelDataPart {
  constructor(
    public data: Uint8Array,
    public mimeType: string
  ) {}
  static json(value: unknown, mime = "text/x-json") {
    return new LanguageModelDataPart(Buffer.from(JSON.stringify(value, null, 2)), mime)
  }
  static text(value: string, mime = "text/plain") {
    return new LanguageModelDataPart(Buffer.from(value), mime)
  }
}
export class LanguageModelPromptTsxPart {
  constructor(public value: unknown) {}
}
export class LanguageModelToolResult {
  constructor(public content: unknown[]) {}
}
export class LanguageModelToolResult2 extends LanguageModelToolResult {}
export class LanguageModelError extends Error {
  static NotFound(m?: string) {
    return new LanguageModelError(m ?? "NotFound")
  }
  static NoPermissions(m?: string) {
    return new LanguageModelError(m ?? "NoPermissions")
  }
  static Blocked(m?: string) {
    return new LanguageModelError(m ?? "Blocked")
  }
}

// ---------------------------------------------------------------------------------------------
// runtime state, populated by the headless entry point
// ---------------------------------------------------------------------------------------------

export interface ContributedTool {
  name: string
  modelDescription?: string
  displayName?: string
  inputSchema?: object
  tags?: string[]
}

interface FsProvider {
  stat(uri: URI): any
  readDirectory(uri: URI): any
  createDirectory(uri: URI): any
  readFile(uri: URI): any
  writeFile(uri: URI, content: Uint8Array, options: { create: boolean; overwrite: boolean }): any
  delete(uri: URI, options: { recursive: boolean }): any
  rename(oldUri: URI, newUri: URI, options: { overwrite: boolean }): any
  copy?(source: URI, destination: URI, options: { overwrite: boolean }): any
  onDidChangeFile?: unknown
}

const configChanged = new EventEmitter<{ affectsConfiguration(section: string): boolean }>()
const foldersChanged = new EventEmitter<{ added: unknown[]; removed: unknown[] }>()
const docOpened = new EventEmitter<TextDocument>()
const docClosed = new EventEmitter<TextDocument>()
const docChanged = new EventEmitter<{
  document: TextDocument
  contentChanges: unknown[]
  reason?: number
}>()
const docSaved = new EventEmitter<TextDocument>()
const docWillSave = new EventEmitter<{
  document: TextDocument
  reason: number
  waitUntil(p: unknown): void
}>()
const diagnosticsChanged = new EventEmitter<{ uris: URI[] }>()

export const runtime = {
  /** flat map of setting id -> value: contributed defaults overlaid with the JSON config */
  settings: new Map<string, unknown>(),
  secrets: new Map<string, string>(),
  providers: new Map<string, FsProvider>(),
  contributedTools: new Map<string, ContributedTool>(),
  tools: new Map<string, any>(),
  commands: new Map<string, (...args: any[]) => unknown>(),
  diagnosticCollections: new Set<DiagnosticCollection>(),
  documents: new Map<string, TextDocument>(),
  folders: [] as { uri: URI; name: string; index: number }[],
  /** ids of the VS Code extensions reported as installed */
  extensionIds: new Set<string>(),
  /** this extension, as returned by extensions.getExtension(<own id>) */
  ownExtension: undefined as undefined | { id: string; [k: string]: unknown },
  /** awaited before every tool invocation, e.g. to connect the systems a call refers to */
  beforeToolInvoke: undefined as undefined | ((name: string, input: unknown) => Promise<void>),
  setSetting(key: string, value: unknown) {
    runtime.settings.set(key, value)
    configChanged.fire({
      affectsConfiguration: (s: string) => key === s || key.startsWith(`${s}.`)
    })
  },
  setFolders(ids: string[]) {
    const removed = runtime.folders
    runtime.folders = ids.map((id, index) => ({
      uri: URI.parse(`adt://${id.toLowerCase()}/`),
      name: id,
      index
    }))
    foldersChanged.fire({ added: runtime.folders, removed })
  },
  provider(uri: URI) {
    return runtime.providers.get(uri.scheme)
  }
}

// ---------------------------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------------------------

function lookupSetting(key: string): unknown {
  if (runtime.settings.has(key)) return runtime.settings.get(key)
  // assemble an object out of nested keys, e.g. "abapfs.mcpServer" -> { port, apiKey, ... }
  const prefix = `${key}.`
  let found = false
  const result: Record<string, unknown> = {}
  for (const [k, v] of runtime.settings) {
    if (!k.startsWith(prefix)) continue
    found = true
    const parts = k.slice(prefix.length).split(".")
    let node = result
    for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Record<string, unknown>
    node[parts[parts.length - 1]!] = v
  }
  return found ? result : undefined
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v))

function getConfiguration(section?: string) {
  const full = (key: string) => (section ? `${section}.${key}` : key)
  const api = {
    get<T>(key: string, defaultValue?: T): T | undefined {
      const v = lookupSetting(full(key))
      return (v === undefined ? defaultValue : clone(v)) as T
    },
    has(key: string) {
      return lookupSetting(full(key)) !== undefined
    },
    inspect(key: string) {
      const v = lookupSetting(full(key))
      return { key: full(key), defaultValue: v, globalValue: v }
    },
    async update(key: string, value: unknown) {
      runtime.setSetting(full(key), value)
    }
  }
  return new Proxy(api, {
    get(t, key) {
      if (typeof key === "symbol" || key in t) return (t as any)[key]
      return api.get(key)
    }
  })
}

// ---------------------------------------------------------------------------------------------
// text documents
// ---------------------------------------------------------------------------------------------

const languageOf = (uri: URI) => {
  const p = uri.path.toLowerCase()
  if (
    /\.(asddls|acds|ddls\.asddls|dcls|asdcls|ddlx|asddlxs|ddla|asbdef|srvdsrv)$/.test(p) ||
    p.endsWith(".cds")
  )
    return "abap_cds"
  if (p.endsWith(".abap")) return "abap"
  const ext = extname(p).slice(1)
  return (
    (
      {
        json: "json",
        md: "markdown",
        ts: "typescript",
        js: "javascript",
        xml: "xml",
        txt: "plaintext"
      } as Record<string, string>
    )[ext] ?? "plaintext"
  )
}

export class TextDocument {
  version = 1
  isDirty = false
  isClosed = false
  readonly isUntitled: boolean
  readonly eol = 1
  readonly encoding = "utf8"
  languageId: string
  private lines: string[] = []
  constructor(
    readonly uri: URI,
    private text: string,
    languageId?: string
  ) {
    this.isUntitled = uri.scheme === "untitled"
    this.languageId = languageId ?? languageOf(uri)
    this.lines = text.split(/\r?\n/)
  }
  get fileName() {
    return this.uri.scheme === "file" ? this.uri.fsPath : this.uri.path
  }
  get lineCount() {
    return this.lines.length
  }
  getText(range?: Range) {
    if (!range) return this.text
    return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end))
  }
  lineAt(lineOrPos: number | Position) {
    const line = typeof lineOrPos === "number" ? lineOrPos : lineOrPos.line
    if (line < 0 || line >= this.lines.length) throw new Error(`Illegal line ${line}`)
    const text = this.lines[line]!
    const firstNonWs = text.search(/\S/)
    return {
      lineNumber: line,
      text,
      range: new Range(line, 0, line, text.length),
      rangeIncludingLineBreak: new Range(line, 0, line + 1, 0),
      firstNonWhitespaceCharacterIndex: firstNonWs < 0 ? text.length : firstNonWs,
      isEmptyOrWhitespace: firstNonWs < 0
    }
  }
  offsetAt(p: Position) {
    let offset = 0
    const lineEnd = this.text.includes("\r\n") ? 2 : 1
    const line = Math.min(Math.max(p.line, 0), this.lines.length - 1)
    for (let i = 0; i < line; i++) offset += this.lines[i]!.length + lineEnd
    return offset + Math.min(p.character, this.lines[line]!.length)
  }
  positionAt(offset: number) {
    const before = this.text.slice(0, Math.max(0, offset)).split(/\r?\n/)
    return new Position(before.length - 1, before[before.length - 1]!.length)
  }
  validateRange(r: Range) {
    return r
  }
  validatePosition(p: Position) {
    return p
  }
  getWordRangeAtPosition(p: Position, regex = /[\w/$%<>~-]+/g) {
    const text = this.lines[p.line] ?? ""
    const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g")
    for (const m of text.matchAll(re))
      if (m.index! <= p.character && m.index! + m[0].length >= p.character)
        return new Range(p.line, m.index!, p.line, m.index! + m[0].length)
  }
  /** headless only: replace the buffer */
  setText(text: string, dirty = true) {
    this.text = text
    this.lines = text.split(/\r?\n/)
    this.version++
    this.isDirty = dirty
    docChanged.fire({ document: this, contentChanges: [] })
  }
  async save() {
    if (!this.isDirty) return true
    docWillSave.fire({ document: this, reason: 1, waitUntil: () => undefined })
    await fsApi.writeFile(this.uri, Buffer.from(this.text, "utf8"))
    this.isDirty = false
    docSaved.fire(this)
    return true
  }
}

async function openTextDocument(arg?: URI | string | { content?: string; language?: string }) {
  if (
    arg === undefined ||
    (typeof arg === "object" && !(arg instanceof URI) && !("scheme" in arg))
  ) {
    const opts = (arg ?? {}) as { content?: string; language?: string }
    const uri = URI.parse(`untitled:Untitled-${runtime.documents.size + 1}`)
    const doc = new TextDocument(uri, opts.content ?? "", opts.language)
    runtime.documents.set(uri.toString(), doc)
    return doc
  }
  const uri = typeof arg === "string" ? URI.file(arg) : (arg as URI)
  const key = uri.toString()
  const existing = runtime.documents.get(key)
  if (existing && !existing.isClosed) return existing
  const content = Buffer.from(await fsApi.readFile(uri)).toString("utf8")
  const doc = new TextDocument(uri, content)
  runtime.documents.set(key, doc)
  docOpened.fire(doc)
  return doc
}

export function closeTextDocument(uri: URI) {
  const doc = runtime.documents.get(uri.toString())
  if (!doc) return
  doc.isClosed = true
  runtime.documents.delete(uri.toString())
  docClosed.fire(doc)
}

async function applyEdit(edit: WorkspaceEdit) {
  for (const [uri, edits] of edit.entries()) {
    const doc = await openTextDocument(uri)
    let text = doc.getText()
    const sorted = [...edits].sort(
      (a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start)
    )
    for (const e of sorted)
      text =
        text.slice(0, doc.offsetAt(e.range.start)) +
        e.newText +
        text.slice(doc.offsetAt(e.range.end))
    doc.setText(text)
  }
  return true
}

// ---------------------------------------------------------------------------------------------
// file system
// ---------------------------------------------------------------------------------------------

const nodeFs: FsProvider = {
  async stat(uri) {
    const s = await fsp.stat(uri.fsPath).catch(() => {
      throw FileSystemError.FileNotFound(uri.toString())
    })
    return { type: s.isDirectory() ? 2 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size }
  },
  async readDirectory(uri) {
    const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true })
    return entries.map(e => [e.name, e.isDirectory() ? 2 : 1])
  },
  createDirectory: uri => fsp.mkdir(uri.fsPath, { recursive: true }),
  readFile: async uri => {
    try {
      return new Uint8Array(await fsp.readFile(uri.fsPath))
    } catch {
      throw FileSystemError.FileNotFound(uri.toString())
    }
  },
  async writeFile(uri, content) {
    await fsp.mkdir(dirname(uri.fsPath), { recursive: true })
    await fsp.writeFile(uri.fsPath, content)
  },
  delete: (uri, o) => fsp.rm(uri.fsPath, { recursive: o.recursive, force: true }),
  rename: (a, b) => fsp.rename(a.fsPath, b.fsPath),
  copy: (a, b) => fsp.cp(a.fsPath, b.fsPath, { recursive: true })
}

const providerFor = (uri: URI): FsProvider => {
  if (uri.scheme === "file") return nodeFs
  const p = runtime.providers.get(uri.scheme)
  if (!p) throw FileSystemError.Unavailable(`No file system provider for scheme ${uri.scheme}`)
  return p
}

const fsApi = {
  stat: async (uri: URI) => providerFor(uri).stat(uri),
  readDirectory: async (uri: URI) => providerFor(uri).readDirectory(uri),
  createDirectory: async (uri: URI) => providerFor(uri).createDirectory(uri),
  readFile: async (uri: URI): Promise<Uint8Array> => providerFor(uri).readFile(uri),
  writeFile: async (uri: URI, content: Uint8Array) => {
    await providerFor(uri).writeFile(uri, content, { create: true, overwrite: true })
    const doc = runtime.documents.get(uri.toString())
    if (doc && !doc.isDirty) doc.setText(Buffer.from(content).toString("utf8"), false)
  },
  delete: async (uri: URI, options: { recursive?: boolean; useTrash?: boolean } = {}) =>
    providerFor(uri).delete(uri, { recursive: !!options.recursive }),
  rename: async (a: URI, b: URI, o: { overwrite?: boolean } = {}) =>
    providerFor(a).rename(a, b, { overwrite: !!o.overwrite }),
  copy: async (a: URI, b: URI, o: { overwrite?: boolean } = {}) => {
    const p = providerFor(a)
    if (p.copy && providerFor(b) === p) return p.copy(a, b, { overwrite: !!o.overwrite })
    await fsApi.writeFile(b, await fsApi.readFile(a))
  },
  isWritableFileSystem: (scheme: string) => scheme === "file" || runtime.providers.has(scheme)
}

// ---------------------------------------------------------------------------------------------
// namespaces
// ---------------------------------------------------------------------------------------------

export const workspace = {
  fs: fsApi,
  get workspaceFolders() {
    return runtime.folders.length ? runtime.folders : undefined
  },
  get name() {
    return "abapfs-headless"
  },
  workspaceFile: undefined,
  rootPath: undefined,
  isTrusted: true,
  get textDocuments() {
    return [...runtime.documents.values()]
  },
  getWorkspaceFolder(uri: URI) {
    return runtime.folders.find(
      f => f.uri.scheme === uri.scheme && f.uri.authority === uri.authority
    )
  },
  asRelativePath(p: URI | string) {
    if (typeof p === "string") return p
    return p.scheme === "file" ? p.fsPath : p.path
  },
  updateWorkspaceFolders(
    start: number,
    deleteCount: number | undefined | null,
    ...add: { uri: URI; name?: string }[]
  ) {
    const removed = runtime.folders.splice(
      start,
      deleteCount ?? 0,
      ...add.map(a => ({ uri: a.uri, name: a.name ?? a.uri.authority, index: 0 }))
    )
    runtime.folders.forEach((f, i) => (f.index = i))
    foldersChanged.fire({ added: add, removed })
    return true
  },
  getConfiguration,
  registerFileSystemProvider(scheme: string, provider: FsProvider) {
    runtime.providers.set(scheme, provider)
    return new Disposable(() => runtime.providers.delete(scheme))
  },
  registerTextDocumentContentProvider: () => new Disposable(),
  openTextDocument,
  applyEdit,
  async save(uri: URI) {
    const doc = runtime.documents.get(uri.toString())
    if (doc) await doc.save()
    return uri
  },
  async saveAll() {
    for (const d of runtime.documents.values()) await d.save()
    return true
  },
  async findFiles(include: unknown, _exclude?: unknown, maxResults?: number) {
    // only supports file globs relative to a RelativePattern base folder
    const rp = include instanceof RelativePattern ? include : undefined
    const base =
      rp &&
      (typeof rp.base === "string"
        ? rp.base
        : ((rp.base as any)?.fsPath ?? (rp.base as any)?.uri?.fsPath))
    if (!base || !existsSync(base)) return []
    const results: URI[] = []
    for await (const f of fsp.glob(rp!.pattern, { cwd: base })) {
      results.push(URI.file(`${base}/${f}`))
      if (maxResults && results.length >= maxResults) break
    }
    return results
  },
  createFileSystemWatcher: () => ({
    onDidChange: () => new Disposable(),
    onDidCreate: () => new Disposable(),
    onDidDelete: () => new Disposable(),
    dispose() {}
  }),
  onDidChangeConfiguration: configChanged.event,
  onDidChangeWorkspaceFolders: foldersChanged.event,
  onDidOpenTextDocument: docOpened.event,
  onDidCloseTextDocument: docClosed.event,
  onDidChangeTextDocument: docChanged.event,
  onDidSaveTextDocument: docSaved.event,
  onWillSaveTextDocument: docWillSave.event,
  decode: async (content: Uint8Array) => Buffer.from(content).toString("utf8"),
  encode: async (content: string) => new Uint8Array(Buffer.from(content, "utf8"))
}

const message =
  (level: "info" | "warn" | "error") =>
  async (msg: string, ...rest: unknown[]) => {
    const items = rest.filter(
      r => typeof r === "string" || (r && typeof r === "object" && "title" in (r as object))
    )
    log[level](
      items.length
        ? `${msg} [choices: ${items.map(i => (typeof i === "string" ? i : (i as any).title)).join(", ")} — none chosen, headless]`
        : msg
    )
    return undefined
  }

function outputChannel(name: string) {
  const write =
    (level: "info" | "warn" | "error" | "debug") =>
    (m: unknown, ...args: unknown[]) =>
      log[level](
        `[${name}] ${[m, ...args].map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`.trimEnd()
      )
  return {
    name,
    logLevel: 2,
    onDidChangeLogLevel: () => new Disposable(),
    append: (v: string) => v.trim() && write("debug")(v),
    appendLine: write("debug"),
    replace: () => undefined,
    clear: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
    trace: write("debug"),
    debug: write("debug"),
    info: write("debug"),
    warn: write("warn"),
    error: write("error")
  }
}

function fakeEditor(document: TextDocument) {
  const sel = new Selection(new Position(0, 0), new Position(0, 0))
  return {
    document,
    selection: sel,
    selections: [sel],
    visibleRanges: [],
    options: {},
    viewColumn: 1,
    async edit(
      cb: (b: {
        replace(r: Range, t: string): void
        insert(p: Position, t: string): void
        delete(r: Range): void
      }) => void
    ) {
      const we = new WorkspaceEdit()
      cb({
        replace: (r, t) => we.replace(document.uri, r, t),
        insert: (p, t) => we.insert(document.uri, p, t),
        delete: r => we.delete(document.uri, r)
      })
      return applyEdit(we)
    },
    revealRange: () => undefined,
    setDecorations: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    insertSnippet: async () => false
  }
}

const statusBarItem = () => ({
  text: "",
  tooltip: "",
  command: undefined,
  show() {},
  hide() {},
  dispose() {}
})

export const window = {
  showInformationMessage: message("info"),
  showWarningMessage: message("warn"),
  showErrorMessage: message("error"),
  async showQuickPick(_items: unknown, options?: { placeHolder?: string; title?: string }) {
    log.warn(
      `Interactive selection not possible headless (${options?.title ?? options?.placeHolder ?? "quick pick"}) — cancelled`
    )
    return undefined
  },
  async showInputBox(options?: { prompt?: string; title?: string }) {
    log.warn(
      `Interactive input not possible headless (${options?.title ?? options?.prompt ?? "input box"}) — cancelled`
    )
    return undefined
  },
  showOpenDialog: async () => undefined,
  showSaveDialog: async () => undefined,
  showWorkspaceFolderPick: async () => undefined,
  async withProgress<R>(
    _options: unknown,
    task: (progress: { report(v: unknown): void }, token: any) => Promise<R>
  ) {
    return task({ report: () => undefined }, new CancellationTokenSource().token)
  },
  setStatusBarMessage: () => new Disposable(),
  createOutputChannel: outputChannel,
  createStatusBarItem: statusBarItem,
  activeTextEditor: undefined,
  visibleTextEditors: [] as unknown[],
  activeNotebookEditor: undefined,
  visibleNotebookEditors: [],
  terminals: [],
  activeTerminal: undefined,
  state: { focused: false, active: false },
  activeColorTheme: { kind: 2 },
  tabGroups: {
    all: [] as unknown[],
    activeTabGroup: { tabs: [], isActive: true, viewColumn: 1, activeTab: undefined },
    close: async () => true,
    onDidChangeTabs: () => new Disposable(),
    onDidChangeTabGroups: () => new Disposable()
  },
  async showTextDocument(docOrUri: TextDocument | URI) {
    const doc =
      docOrUri instanceof TextDocument ? docOrUri : await openTextDocument(docOrUri as URI)
    return fakeEditor(doc)
  },
  registerTreeDataProvider: () => new Disposable(),
  registerWebviewViewProvider: () => new Disposable(),
  registerWebviewPanelSerializer: () => new Disposable(),
  registerCustomEditorProvider: () => new Disposable(),
  registerFileDecorationProvider: () => new Disposable(),
  registerUriHandler: () => new Disposable(),
  registerTerminalLinkProvider: () => new Disposable(),
  registerTerminalProfileProvider: () => new Disposable()
}

const builtinCommands: Record<string, (...args: any[]) => unknown> = {
  setContext: () => undefined,
  "vscode.open": () => undefined,
  "vscode.diff": () => undefined,
  "vscode.openFolder": () => undefined,
  "workbench.action.closeActiveEditor": () => undefined,
  "workbench.files.action.refreshFilesExplorer": () => undefined,
  "workbench.action.reloadWindow": () => undefined
}

export const commands = {
  registerCommand(id: string, cb: (...args: any[]) => unknown, thisArg?: unknown) {
    runtime.commands.set(id, thisArg ? cb.bind(thisArg) : cb)
    return new Disposable(() => runtime.commands.delete(id))
  },
  registerTextEditorCommand(id: string, cb: (...args: any[]) => unknown) {
    return commands.registerCommand(id, cb)
  },
  async executeCommand(id: string, ...args: unknown[]) {
    const cmd = runtime.commands.get(id) ?? builtinCommands[id]
    if (cmd) return cmd(...args)
    if (id.startsWith("workbench.") || id.startsWith("editor.") || id.startsWith("vscode.")) {
      log.debug(`UI command ${id} ignored headless`)
      return undefined
    }
    throw new Error(`Command '${id}' is not available in the headless runtime`)
  },
  async getCommands() {
    return [...runtime.commands.keys(), ...Object.keys(builtinCommands)]
  }
}

export class DiagnosticCollection {
  private map = new Map<string, { uri: URI; diags: Diagnostic[] }>()
  constructor(readonly name = "") {
    runtime.diagnosticCollections.add(this)
  }
  set(uriOrEntries: URI | [URI, Diagnostic[] | undefined][], diags?: Diagnostic[]) {
    const entries: [URI, Diagnostic[] | undefined][] = Array.isArray(uriOrEntries)
      ? uriOrEntries
      : [[uriOrEntries, diags]]
    for (const [uri, d] of entries) {
      if (!d) this.map.delete(uri.toString())
      else this.map.set(uri.toString(), { uri, diags: [...d] })
    }
    diagnosticsChanged.fire({ uris: entries.map(e => e[0]) })
  }
  get(uri: URI) {
    return this.map.get(uri.toString())?.diags ?? []
  }
  has(uri: URI) {
    return this.map.has(uri.toString())
  }
  delete(uri: URI) {
    this.map.delete(uri.toString())
  }
  clear() {
    this.map.clear()
  }
  forEach(cb: (uri: URI, d: Diagnostic[], c: DiagnosticCollection) => void) {
    for (const { uri, diags } of this.map.values()) cb(uri, diags, this)
  }
  *[Symbol.iterator](): Iterator<[URI, Diagnostic[]]> {
    for (const { uri, diags } of this.map.values()) yield [uri, diags]
  }
  entries() {
    return [...this.map.values()].map(e => [e.uri, e.diags] as [URI, Diagnostic[]])
  }
  dispose() {
    this.map.clear()
    runtime.diagnosticCollections.delete(this)
  }
}

const sameDocument = (a: string, b: string) => decodeURIComponent(a) === decodeURIComponent(b)

export const languages = {
  createDiagnosticCollection: (name?: string) => new DiagnosticCollection(name),
  getDiagnostics(uri?: URI): any {
    if (uri) {
      const out: Diagnostic[] = []
      for (const c of runtime.diagnosticCollections)
        c.forEach((u, d) => {
          if (sameDocument(u.toString(), uri.toString())) out.push(...d)
        })
      return out
    }
    const all = new Map<string, [URI, Diagnostic[]]>()
    for (const c of runtime.diagnosticCollections)
      c.forEach((u, d) => {
        const e = all.get(u.toString()) ?? [u, []]
        e[1].push(...d)
        all.set(u.toString(), e)
      })
    return [...all.values()]
  },
  onDidChangeDiagnostics: diagnosticsChanged.event,
  getLanguages: async () => ["abap", "abap_cds"],
  setTextDocumentLanguage: async (doc: TextDocument, languageId: string) => {
    doc.languageId = languageId
    return doc
  },
  match: () => 0
}

export const lm = {
  registerTool(name: string, tool: any) {
    // the same object sits in upstream's toolRegistry, which the MCP server invokes directly
    if (tool && typeof tool.invoke === "function" && !tool.__headlessWrapped) {
      const original = tool.invoke.bind(tool)
      tool.invoke = async (options: { input?: unknown }, token: unknown) => {
        await runtime.beforeToolInvoke?.(name, options?.input)
        return original(options, token)
      }
      tool.__headlessWrapped = true
    }
    runtime.tools.set(name, tool)
    return new Disposable(() => runtime.tools.delete(name))
  },
  get tools() {
    return [...runtime.tools.keys()].map(name => {
      const c = runtime.contributedTools.get(name)
      return {
        name,
        description: c?.modelDescription ?? "",
        inputSchema: c?.inputSchema,
        tags: c?.tags ?? []
      }
    })
  },
  async invokeTool(name: string, options: { input: unknown }, token?: unknown) {
    const tool = runtime.tools.get(name)
    if (!tool) throw new Error(`Tool ${name} is not registered`)
    return tool.invoke(options, token ?? new CancellationTokenSource().token)
  },
  selectChatModels: async () => [],
  onDidChangeChatModels: () => new Disposable(),
  registerMcpServerDefinitionProvider: () => new Disposable(),
  registerLanguageModelChatProvider: () => new Disposable()
}

export const extensions = {
  getExtension(id: string) {
    if (runtime.ownExtension && id.toLowerCase() === runtime.ownExtension.id.toLowerCase())
      return runtime.ownExtension
    if (!runtime.extensionIds.has(id.toLowerCase())) return undefined
    return {
      id,
      isActive: true,
      exports: undefined,
      packageJSON: {},
      activate: async () => undefined
    }
  },
  get all() {
    return []
  },
  onDidChange: () => new Disposable()
}

export const env = {
  appName: "ABAP FS headless",
  appRoot: process.cwd(),
  appHost: "desktop",
  uriScheme: "vscode",
  language: "en",
  machineId: "abapfs-headless",
  sessionId: `abapfs-headless-${process.pid}`,
  isNewAppInstall: false,
  isAppPortable: false,
  isTelemetryEnabled: false,
  remoteName: undefined,
  shell: process.env.SHELL ?? "",
  uiKind: 1,
  logLevel: 2,
  clipboard: {
    readText: async () => "",
    writeText: async (t: string) => log.info(`clipboard (headless): ${t}`)
  },
  async openExternal(uri: URI) {
    log.warn(`Open this URL manually: ${uri.toString(true)}`)
    return false
  },
  asExternalUri: async (uri: URI) => uri,
  onDidChangeTelemetryEnabled: () => new Disposable(),
  onDidChangeLogLevel: () => new Disposable(),
  onDidChangeShell: () => new Disposable(),
  createTelemetryLogger: () => ({
    logUsage() {},
    logError() {},
    dispose() {},
    isUsageEnabled: false,
    isErrorsEnabled: false,
    onDidChangeEnableStates: () => new Disposable()
  })
}

export const debug = {
  activeDebugSession: undefined,
  activeDebugConsole: { append() {}, appendLine() {} },
  breakpoints: [],
  async startDebugging() {
    log.warn("VS Code debug sessions are not available headless")
    return false
  },
  stopDebugging: async () => undefined,
  addBreakpoints: () => undefined,
  removeBreakpoints: () => undefined,
  registerDebugConfigurationProvider: () => new Disposable(),
  registerDebugAdapterDescriptorFactory: () => new Disposable(),
  registerDebugAdapterTrackerFactory: () => new Disposable()
}

export const l10n = {
  t(message: string | { message: string; args?: unknown[] }, ...args: unknown[]) {
    const msg = typeof message === "string" ? message : message.message
    const a = typeof message === "string" ? args : (message.args ?? [])
    return msg.replace(/\{(\d+)\}/g, (_, i) => String(a[Number(i)] ?? ""))
  },
  bundle: undefined,
  uri: undefined
}

export const version = "1.105.0"
