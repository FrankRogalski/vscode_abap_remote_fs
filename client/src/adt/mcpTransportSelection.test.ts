const getClientMock = jest.fn()
const readTransportsMock = jest.fn()

jest.mock("./conections", () => ({ getClient: (id: string) => getClientMock(id) }))
jest.mock("./transportsService", () => ({
  readTransports: (connId: string, user: string) => readTransportsMock(connId, user)
}))

import {
  collectModifiable,
  clearMcpWorkingTransport,
  getMcpWorkingTransport,
  hasTransportElicitor,
  promptMcpTransport,
  resolveMcpTransport,
  setTransportElicitor,
  TransportChoice
} from "./mcpTransportSelection"

const sampleTransports = {
  workbench: [
    {
      modifiable: [
        { "tm:number": "DEVK900001", "tm:desc": "first" },
        { "tm:number": "DEVK900002", "tm:desc": "second" }
      ],
      released: [{ "tm:number": "DEVK900099", "tm:desc": "gone" }]
    }
  ],
  customizing: [{ modifiable: [{ "tm:number": "DEVK900003", "tm:desc": "cust" }] }],
  transportofcopies: [{ modifiable: [{ "tm:number": "DEVK900004", "tm:desc": "copy" }] }]
}

describe("collectModifiable", () => {
  it("collects only modifiable transports across all buckets", () => {
    const result = collectModifiable(sampleTransports)
    expect(result.map(r => r.transport)).toEqual([
      "DEVK900001",
      "DEVK900002",
      "DEVK900003",
      "DEVK900004"
    ])
    expect(result[0]).toEqual({ transport: "DEVK900001", description: "first" })
  })

  it("tolerates missing buckets", () => {
    expect(collectModifiable({})).toEqual([])
    expect(collectModifiable(undefined)).toEqual([])
  })
})

describe("mcp transport selection", () => {
  beforeEach(() => {
    setTransportElicitor(undefined)
    clearMcpWorkingTransport()
    getClientMock.mockReset()
    readTransportsMock.mockReset()
    getClientMock.mockReturnValue({ username: "developer" })
    readTransportsMock.mockResolvedValue(sampleTransports)
  })

  it("returns undefined with no elicitor registered", async () => {
    expect(hasTransportElicitor()).toBe(false)
    expect(await resolveMcpTransport("TRL")).toBeUndefined()
  })

  it("asks the elicitor and remembers the choice per connection", async () => {
    const elicitor = jest.fn(async () => "DEVK900002")
    setTransportElicitor(elicitor)

    expect(await resolveMcpTransport("TRL")).toBe("DEVK900002")
    expect(getMcpWorkingTransport("trl")).toBe("DEVK900002")

    // second call reuses the cache: no new elicitation, no extra reads
    expect(await resolveMcpTransport("TRL")).toBe("DEVK900002")
    expect(elicitor).toHaveBeenCalledTimes(1)
    expect(readTransportsMock).toHaveBeenCalledTimes(1)
  })

  it("passes the modifiable transports to the elicitor", async () => {
    let received: TransportChoice[] = []
    setTransportElicitor(async (_c, choices) => {
      received = choices
      return choices[0].transport
    })
    await resolveMcpTransport("TRL")
    expect(received.map(r => r.transport)).toEqual([
      "DEVK900001",
      "DEVK900002",
      "DEVK900003",
      "DEVK900004"
    ])
  })

  it("caches an empty 'local' choice and does not re-ask", async () => {
    const elicitor = jest.fn(async () => "")
    setTransportElicitor(elicitor)

    expect(await resolveMcpTransport("TRL")).toBeUndefined()
    expect(getMcpWorkingTransport("TRL")).toBeUndefined()
    // cached: a repeat resolve must not prompt again
    expect(await resolveMcpTransport("TRL")).toBeUndefined()
    expect(elicitor).toHaveBeenCalledTimes(1)
  })

  it("does not cache a cancelled selection", async () => {
    const elicitor = jest.fn(async () => undefined)
    setTransportElicitor(elicitor)

    expect(await resolveMcpTransport("TRL")).toBeUndefined()
    expect(await resolveMcpTransport("TRL")).toBeUndefined()
    expect(elicitor).toHaveBeenCalledTimes(2)
  })

  it("returns undefined when the user has no modifiable transports", async () => {
    readTransportsMock.mockResolvedValue({})
    const elicitor = jest.fn(async () => "DEVK900001")
    setTransportElicitor(elicitor)

    expect(await resolveMcpTransport("TRL")).toBeUndefined()
    expect(elicitor).not.toHaveBeenCalled()
  })

  it("clears one connection while keeping the others", async () => {
    setTransportElicitor(async () => "DEVK900001")
    await resolveMcpTransport("TRL")
    await resolveMcpTransport("PRD")

    clearMcpWorkingTransport("TRL")
    expect(getMcpWorkingTransport("TRL")).toBeUndefined()
    expect(getMcpWorkingTransport("PRD")).toBe("DEVK900001")
  })

  it("promptMcpTransport forces a fresh selection ignoring the cache", async () => {
    const elicitor = jest
      .fn()
      .mockResolvedValueOnce("DEVK900001")
      .mockResolvedValueOnce("DEVK900002")
    setTransportElicitor(elicitor)

    expect(await resolveMcpTransport("TRL")).toBe("DEVK900001")
    expect(await promptMcpTransport("TRL")).toBe("DEVK900002")
    expect(getMcpWorkingTransport("TRL")).toBe("DEVK900002")
    expect(elicitor).toHaveBeenCalledTimes(2)
  })
})
