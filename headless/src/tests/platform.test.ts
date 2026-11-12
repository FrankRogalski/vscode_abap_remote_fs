import { join } from "node:path"
import { defaultConfigLocations, parseConfig, resolvePassword, stateHome } from "../config"
import * as store from "../secretStore"

const realPlatform = process.platform
const setPlatform = (p: string) => Object.defineProperty(process, "platform", { value: p })

describe("per-platform folders", () => {
  const env = { ...process.env }
  afterEach(() => {
    setPlatform(realPlatform)
    process.env = { ...env }
  })

  it("uses %APPDATA% and %LOCALAPPDATA% on Windows", () => {
    setPlatform("win32")
    process.env.APPDATA = join("C:", "Users", "u", "AppData", "Roaming")
    process.env.LOCALAPPDATA = join("C:", "Users", "u", "AppData", "Local")
    expect(defaultConfigLocations()[1]).toBe(join(process.env.APPDATA, "abapfs", "config.json"))
    expect(stateHome()).toBe(process.env.LOCALAPPDATA)
    expect(parseConfig({ systems: {} }).stateDir).toBe(join(process.env.LOCALAPPDATA, "abapfs-mcp"))
  })

  it("uses XDG folders elsewhere", () => {
    setPlatform("linux")
    process.env.XDG_CONFIG_HOME = "/cfg"
    process.env.XDG_STATE_HOME = "/state"
    expect(defaultConfigLocations()[1]).toBe(join("/cfg", "abapfs", "config.json"))
    expect(stateHome()).toBe("/state")
  })
})

describe("password resolution", () => {
  const sys = (extra: object = {}) =>
    parseConfig({ systems: { dev100: { url: "u", username: "a", ...extra } } }).systems.dev100!

  afterEach(() => vi.restoreAllMocks())

  it("prefers password, then passwordCommand, then the credential store", () => {
    const read = vi.spyOn(store, "readStoredPassword").mockReturnValue("stored")
    expect(resolvePassword(sys({ password: "plain" }), "dev100")).toBe("plain")
    expect(resolvePassword(sys({ passwordCommand: "echo fromcmd" }), "dev100")).toBe("fromcmd")
    expect(resolvePassword(sys(), "dev100")).toBe("stored")
    expect(read).toHaveBeenCalledWith("dev100")
  })

  it("explains how to store a missing password", () => {
    vi.spyOn(store, "readStoredPassword").mockReturnValue(undefined)
    expect(() => resolvePassword(sys(), "dev100")).toThrow(/abapfs-mcp password set dev100/)
  })

  it("does not ask the store for systems without basic auth", () => {
    const read = vi.spyOn(store, "readStoredPassword")
    expect(resolvePassword(sys({ authMethod: "cert", certAuth: { certPath: "c" } }), "x")).toBe("")
    expect(read).not.toHaveBeenCalled()
  })
})

// real Credential Manager round trip; runs on the Windows CI runner
describe.runIf(process.platform === "win32")("Windows Credential Manager", () => {
  it("stores, reads and deletes a password", () => {
    const id = `ci-${process.pid}`
    const secret = "pä$$ wörd'\"`"
    store.storePassword(id, { ABAPFS_CRED_SECRET: secret })
    try {
      expect(store.readStoredPassword(id)).toBe(secret)
    } finally {
      expect(store.deleteStoredPassword(id)).toBe(true)
    }
    expect(store.readStoredPassword(id)).toBeUndefined()
  })
})
