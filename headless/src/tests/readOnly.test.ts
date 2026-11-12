import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ADTClient } from "upstream-dep:abap-adt-api"
import {
  ADT_READ_METHODS,
  ADT_WRITE_METHODS,
  ReadOnlyError,
  TOOL_ACCESS,
  assertToolAllowed,
  clientKey,
  installAdtGuard,
  toolAccess
} from "../readOnly"

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "package.json"), "utf8"))
const mcpTools: string[] = manifest.contributes.languageModelTools
  .filter((t: any) => t.tags?.includes("abap-fs"))
  .map((t: any) => t.name)

describe("tool classification", () => {
  it("classifies every MCP tool upstream ships (new tools must be added to TOOL_ACCESS)", () => {
    const missing = [...mcpTools, "get_abap_diagnostics"].filter(n => !(n in TOOL_ACCESS))
    expect(missing).toEqual([])
  })

  it("treats unknown tools as writes", () => {
    expect(toolAccess("some_future_tool", {})).toBe("write")
  })

  it("decides by action where a tool both reads and writes", () => {
    expect(toolAccess("abapfs_manage_text_elements", { action: "read" })).toBe("read")
    expect(toolAccess("abapfs_manage_text_elements", { action: "update" })).toBe("write")
    expect(toolAccess("abapfs_activate_object", { action: "get_inactive_objects" })).toBe("read")
    expect(toolAccess("abapfs_activate_object", { action: "activate" })).toBe("write")
    expect(toolAccess("abapfs_manage_debug_session", { action: "status" })).toBe("read")
    expect(toolAccess("abapfs_manage_debug_session", { action: "start" })).toBe("write")
    expect(toolAccess("replace_string_in_abap_object", {})).toBe("write")
    expect(toolAccess("abapfs_get_object_source", {})).toBe("read")
  })
})

describe("assertToolAllowed", () => {
  const readOnly = new Map([["prd100", "PRD100"]])

  it("blocks writes that reference a read-only system", () => {
    expect(() => assertToolAllowed("abapfs_create_object", new Set(["prd100"]), readOnly)).toThrow(
      ReadOnlyError
    )
    expect(() => assertToolAllowed("abapfs_create_object", new Set(["prd100"]), readOnly)).toThrow(
      /PRD100 is read-only/
    )
  })

  it("allows reads on read-only systems and writes elsewhere", () => {
    expect(() =>
      assertToolAllowed("abapfs_get_object_source", new Set(["prd100"]), readOnly)
    ).not.toThrow()
    expect(() =>
      assertToolAllowed("abapfs_create_object", new Set(["dev100"]), readOnly)
    ).not.toThrow()
  })
})

describe("ADT client guard", () => {
  const ownMethods = Object.getOwnPropertyNames(ADTClient.prototype).filter(
    n =>
      n !== "constructor" &&
      typeof Object.getOwnPropertyDescriptor(ADTClient.prototype, n)?.value === "function"
  )

  it("classifies every ADTClient method (new library methods must be added)", () => {
    const known = new Set<string>([...ADT_READ_METHODS, ...ADT_WRITE_METHODS])
    expect(ownMethods.filter(m => !known.has(m))).toEqual([])
  })

  it("only lists write methods that exist", () => {
    expect(ADT_WRITE_METHODS.filter(m => !ownMethods.includes(m))).toEqual([])
  })

  it("rejects write methods of read-only clients and lets the rest through", async () => {
    class Fake {
      baseUrl = "https://PRD.example.com/"
      client = "100"
      username = "dev"
      async setObjectSource() {
        return "written"
      }
      async getObjectSource() {
        return "source"
      }
    }
    const names = { write: ["setObjectSource"] as const }
    const readOnlyKeys = new Map([[clientKey("https://prd.example.com", "100", "DEV"), "prd100"]])
    installAdtGuard(
      Fake.prototype,
      c => readOnlyKeys.get(clientKey(c.baseUrl, c.client, c.username)),
      names.write
    )
    const prd = new Fake() as any
    await expect(prd.setObjectSource()).rejects.toThrow(/prd100 is read-only/)
    await expect(prd.getObjectSource()).resolves.toBe("source")
    const dev = Object.assign(new Fake(), { baseUrl: "https://dev.example.com" }) as any
    await expect(dev.setObjectSource()).resolves.toBe("written")
  })
})

describe("installReadOnly (config -> guards)", () => {
  it("guards real ADT clients of read-only systems only", async () => {
    const { installReadOnly } = await import("../activate")
    const { parseConfig } = await import("../config")
    const cfg = parseConfig({
      systems: {
        PRD100: {
          url: "https://prd.example.com:44300/",
          username: "dev",
          client: "100",
          readOnly: true
        },
        DEV100: { url: "https://dev.example.com:44300", username: "dev", client: "100" }
      }
    })
    expect([...installReadOnly(cfg).ids]).toEqual([["prd100", "PRD100"]])
    // no network: the guard rejects before any request, and the dev call fails on connect instead
    const prd = new ADTClient("https://prd.example.com:44300", "DEV", "pw", "100")
    await expect(prd.setObjectSource("/x", "src", "lock")).rejects.toThrow(/PRD100 is read-only/)
    await expect(prd.lock("/x")).rejects.toThrow(ReadOnlyError)
    const dev = new ADTClient("https://dev.example.com:44300", "DEV", "pw", "100")
    await expect(dev.lock("/x")).rejects.not.toThrow(ReadOnlyError)
  })
})
