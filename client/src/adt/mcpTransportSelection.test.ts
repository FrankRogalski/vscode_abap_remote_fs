import {
  elicitTransport,
  hasTransportElicitor,
  setTransportElicitor,
  TransportChoice
} from "./mcpTransportSelection"

const choices: TransportChoice[] = [
  { transport: "DEVK900001", description: "first" },
  { transport: "DEVK900002", description: "second" }
]

describe("mcp transport selection", () => {
  afterEach(() => setTransportElicitor(undefined))

  it("returns undefined with no elicitor registered", async () => {
    expect(hasTransportElicitor()).toBe(false)
    expect(await elicitTransport("/path", choices)).toBeUndefined()
  })

  it("forwards the request to the registered elicitor", async () => {
    const elicitor = jest.fn(async () => "DEVK900002")
    setTransportElicitor(elicitor)
    expect(hasTransportElicitor()).toBe(true)

    expect(await elicitTransport("/path", choices)).toBe("DEVK900002")
    expect(elicitor).toHaveBeenCalledWith("/path", choices)
  })

  it("asks again on every call - nothing is remembered", async () => {
    const elicitor = jest
      .fn()
      .mockResolvedValueOnce("DEVK900001")
      .mockResolvedValueOnce("DEVK900002")
    setTransportElicitor(elicitor)

    expect(await elicitTransport("/path", choices)).toBe("DEVK900001")
    expect(await elicitTransport("/path", choices)).toBe("DEVK900002")
    expect(elicitor).toHaveBeenCalledTimes(2)
  })

  it("returns undefined when the user declines", async () => {
    setTransportElicitor(async () => undefined)
    expect(await elicitTransport("/path", choices)).toBeUndefined()
  })

  it("can be unregistered", async () => {
    setTransportElicitor(async () => "DEVK900001")
    setTransportElicitor(undefined)
    expect(hasTransportElicitor()).toBe(false)
    expect(await elicitTransport("/path", choices)).toBeUndefined()
  })
})
