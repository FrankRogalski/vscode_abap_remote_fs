/** An ExtensionContext for the headless runtime: state on disk, secrets from the JSON config */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs"
import { join } from "node:path"
import { URI } from "vscode-uri"
import { EventEmitter, runtime } from "./vscode/impl"

class FileMemento {
  private data: Record<string, unknown> = {}
  constructor(private file: string) {
    if (existsSync(file))
      try {
        this.data = JSON.parse(readFileSync(file, "utf8"))
      } catch {
        this.data = {}
      }
  }
  keys() {
    return Object.keys(this.data)
  }
  get<T>(key: string, defaultValue?: T): T | undefined {
    return key in this.data ? (structuredClone(this.data[key]) as T) : defaultValue
  }
  async update(key: string, value: unknown) {
    if (value === undefined) delete this.data[key]
    else this.data[key] = value
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
  }
  setKeysForSync() {}
}

export type SecretResolver = () => string | undefined

export function createExtensionContext(opts: {
  extensionPath: string
  stateDir: string
  packageJSON: Record<string, unknown>
  secretResolvers: Map<string, SecretResolver>
}) {
  const { extensionPath, stateDir, packageJSON, secretResolvers } = opts
  const globalStorage = join(stateDir, "globalStorage")
  const workspaceStorage = join(stateDir, "workspaceStorage")
  const logDir = join(stateDir, "logs")
  for (const d of [globalStorage, workspaceStorage, logDir]) mkdirSync(d, { recursive: true })

  const secretChanged = new EventEmitter<{ key: string }>()
  const secrets = {
    async get(key: string) {
      if (runtime.secrets.has(key)) return runtime.secrets.get(key)
      const resolver = secretResolvers.get(key)
      const v = resolver?.()
      if (v !== undefined) runtime.secrets.set(key, v)
      return v
    },
    async store(key: string, value: string) {
      // in memory only: the JSON config is the source of truth
      runtime.secrets.set(key, value)
      secretChanged.fire({ key })
    },
    async delete(key: string) {
      runtime.secrets.delete(key)
      secretChanged.fire({ key })
    },
    async keys() {
      return [...new Set([...runtime.secrets.keys(), ...secretResolvers.keys()])]
    },
    onDidChange: secretChanged.event
  }

  const extensionUri = URI.file(extensionPath)
  const id = `${packageJSON.publisher}.${packageJSON.name}`
  return {
    subscriptions: [] as { dispose(): unknown }[],
    extensionPath,
    extensionUri,
    asAbsolutePath: (p: string) => join(extensionPath, p),
    globalState: new FileMemento(join(stateDir, "globalState.json")),
    workspaceState: new FileMemento(join(stateDir, "workspaceState.json")),
    secrets,
    storagePath: workspaceStorage,
    storageUri: URI.file(workspaceStorage),
    globalStoragePath: globalStorage,
    globalStorageUri: URI.file(globalStorage),
    logPath: logDir,
    logUri: URI.file(logDir),
    extensionMode: 1,
    extension: { id, extensionUri, extensionPath, isActive: true, packageJSON, extensionKind: 1, exports: undefined, activate: async () => undefined },
    environmentVariableCollection: {
      persistent: false,
      replace() {},
      append() {},
      prepend() {},
      get() {},
      forEach() {},
      delete() {},
      clear() {},
      getScoped() {
        return this
      }
    },
    languageModelAccessInformation: { onDidChange: () => ({ dispose() {} }), canSendRequest: () => undefined }
  }
}
