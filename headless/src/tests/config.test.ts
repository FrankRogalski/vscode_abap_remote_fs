import { interpolateEnv, parseConfig } from "../config"
import { applyConfig, referencedSystems } from "../activate"
import { runtime } from "../vscode/impl"
import { workspace } from "../vscode/index"

const base = { systems: { dev100: { url: "https://h:443", username: "DEV", password: "secret", client: "100" } } }

describe("config", () => {
  it("interpolates ${env:VAR} and fails on unset variables", () => {
    expect(interpolateEnv({ a: ["${env:X}-y"] }, { X: "x" })).toEqual({ a: ["x-y"] })
    expect(() => interpolateEnv("${env:NOPE}", {})).toThrow(/NOPE is not set/)
  })

  it("applies defaults and rejects unknown top level keys", () => {
    const cfg = parseConfig(base)
    expect(cfg.mcp).toMatchObject({ transport: "stdio", port: 4847, exposeEditTool: true })
    expect(cfg.systems.dev100!.language).toBe("EN")
    expect(() => parseConfig({ ...base, bogus: 1 })).toThrow(/bogus/)
    expect(() => parseConfig({ systems: { x: { url: "u", username: "u" } } })).toThrow(/3\+ characters/)
  })

  it("keeps extra abapfs.remote fields on systems", () => {
    const cfg = parseConfig({ systems: { dev100: { ...base.systems.dev100, sapGui: { server: "h" }, oauth: { clientId: "c" } } } })
    expect((cfg.systems.dev100 as any).oauth).toEqual({ clientId: "c" })
  })
})

describe("applyConfig", () => {
  it("maps systems to abapfs.remote without secrets and exposes passwords as secrets", async () => {
    const resolvers = applyConfig(
      parseConfig({ ...base, settings: { "abapfs.atc": { autoRefresh: false }, abapfs: { custom: { x: 1 } } } })
    )
    const remote = workspace.getConfiguration("abapfs").get("remote")
    expect(remote.dev100).toMatchObject({ url: "https://h:443", username: "DEV" })
    expect(remote.dev100.password).toBeUndefined()
    expect(resolvers.get("vscode.abapfs.dev100:DEV")?.()).toBe("secret")
    expect(workspace.workspaceFolders?.map((f: any) => f.uri.toString())).toEqual(["adt://dev100/"])
    expect(runtime.settings.get("abapfs.mcpServer.exposeEditTool")).toBe(true)
    expect(runtime.contributedTools.get("abapfs_search_objects")?.inputSchema).toBeTruthy()
  })

  it("assembles nested sections from flat ids", () => {
    applyConfig(parseConfig({ ...base, mcp: { port: 9999 } }))
    const mcp = workspace.getConfiguration("abapfs").get("mcpServer")
    expect(mcp.port).toBe(9999)
    expect(workspace.getConfiguration("abapfs.mcpServer").port).toBe(9999)
  })
})

describe("referencedSystems", () => {
  it("finds connection ids and adt URIs", () => {
    const ids = referencedSystems({
      connectionId: "DEV100",
      fileUri: "adt://qa200/System Library/x",
      requests: [{ uri: "adt://prd300/y" }],
      text: "nothing"
    })
    expect([...ids].sort()).toEqual(["dev100", "prd300", "qa200"])
  })
})
