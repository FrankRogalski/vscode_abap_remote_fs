const store: Record<string, any> = {}
const update = jest.fn(async (key: string, value: any) => {
  store[key] = value
})

jest.mock(
  "vscode",
  () => ({
    ConfigurationTarget: { Global: 1 },
    workspace: {
      getConfiguration: () => ({
        get: (key: string) => store[key],
        update
      })
    }
  }),
  { virtual: true }
)

import { getCurrentTransport, setCurrentTransport, clearCurrentTransport } from "./currentTransport"

describe("currentTransport", () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    update.mockClear()
  })

  it("returns undefined when nothing is stored", () => {
    expect(getCurrentTransport("TRL")).toBeUndefined()
  })

  it("stores per connection, case-insensitive, at global scope", async () => {
    await setCurrentTransport("TRL", "DEVK900123")
    expect(update).toHaveBeenCalledWith("currentTransport", { trl: "DEVK900123" }, 1)
    expect(getCurrentTransport("TRL")).toBe("DEVK900123")
    expect(getCurrentTransport("trl")).toBe("DEVK900123")
  })

  it("keeps other connections when setting one", async () => {
    await setCurrentTransport("TRL", "DEVK900123")
    await setCurrentTransport("PRD", "PRDK900999")
    expect(getCurrentTransport("TRL")).toBe("DEVK900123")
    expect(getCurrentTransport("PRD")).toBe("PRDK900999")
  })

  it("clears an entry so it falls back to prompting", async () => {
    await setCurrentTransport("TRL", "DEVK900123")
    await clearCurrentTransport("TRL")
    expect(getCurrentTransport("TRL")).toBeUndefined()
    expect(store["currentTransport"]).toEqual({})
  })

  it("treats an empty stored value as not set", async () => {
    await setCurrentTransport("TRL", "")
    expect(getCurrentTransport("TRL")).toBeUndefined()
  })
})
