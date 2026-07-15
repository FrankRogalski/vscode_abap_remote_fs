jest.mock("vscode", () => ({}), { virtual: true })
jest.mock("abap-adt-api", () => ({}))
jest.mock("../services/funMessenger", () => ({
  funWindow: {
    showQuickPick: jest.fn(),
    showInformationMessage: jest.fn(),
    showErrorMessage: jest.fn()
  }
}))
jest.mock("../config", () => ({ pickAdtRoot: jest.fn() }))
jest.mock("../adt/conections", () => ({ getClient: jest.fn() }))
jest.mock("../adt/transportsService", () => ({ readTransports: jest.fn() }))
jest.mock("../adt/currentTransport", () => ({
  getCurrentTransport: jest.fn(),
  setCurrentTransport: jest.fn(),
  clearCurrentTransport: jest.fn()
}))
jest.mock("../lib", () => ({ caughtToString: (e: any) => String(e) }))

import {
  setCurrentTransportCommand,
  clearCurrentTransportCommand
} from "./currentTransportCommands"
import { funWindow as window } from "../services/funMessenger"
import { pickAdtRoot } from "../config"
import { getClient } from "../adt/conections"
import { readTransports } from "../adt/transportsService"
import {
  getCurrentTransport,
  setCurrentTransport,
  clearCurrentTransport
} from "../adt/currentTransport"

const mockWindow = window as jest.Mocked<typeof window>
const req = (num: string, desc = "") => ({ "tm:number": num, "tm:desc": desc })

beforeEach(() => {
  jest.clearAllMocks()
  ;(pickAdtRoot as jest.Mock).mockResolvedValue({ uri: { authority: "TRL" } })
  ;(getClient as jest.Mock).mockReturnValue({ username: "tester" })
  ;(getCurrentTransport as jest.Mock).mockReturnValue(undefined)
})

describe("setCurrentTransportCommand", () => {
  it("flattens modifiable transports from every bucket into the picker", async () => {
    ;(readTransports as jest.Mock).mockResolvedValue({
      workbench: [{ modifiable: [req("WB1", "wb")], released: [req("REL1")] }],
      customizing: [{ modifiable: [req("CU1", "cu")] }],
      transportofcopies: [{ modifiable: [req("TOC1")] }]
    })
    mockWindow.showQuickPick.mockResolvedValue({ transport: "WB1" } as any)

    await setCurrentTransportCommand()

    const items = mockWindow.showQuickPick.mock.calls[0][0] as any[]
    expect(items.map(i => i.transport)).toEqual(["WB1", "CU1", "TOC1"]) // no released, no Clear
    expect(setCurrentTransport).toHaveBeenCalledWith("TRL", "WB1")
  })

  it("offers a Clear entry when a transport is already set, and clears on pick", async () => {
    ;(getCurrentTransport as jest.Mock).mockReturnValue("WB1")
    ;(readTransports as jest.Mock).mockResolvedValue({
      workbench: [{ modifiable: [req("WB1")] }]
    })
    mockWindow.showQuickPick.mockResolvedValue({ transport: "" } as any)

    await setCurrentTransportCommand()

    const items = mockWindow.showQuickPick.mock.calls[0][0] as any[]
    expect(items[0].transport).toBe("") // Clear entry first
    expect(setCurrentTransport).toHaveBeenCalledWith("TRL", "")
  })

  it("informs and saves nothing when there are no modifiable transports", async () => {
    ;(readTransports as jest.Mock).mockResolvedValue({ workbench: [{ modifiable: [] }] })

    await setCurrentTransportCommand()

    expect(mockWindow.showQuickPick).not.toHaveBeenCalled()
    expect(mockWindow.showInformationMessage).toHaveBeenCalled()
    expect(setCurrentTransport).not.toHaveBeenCalled()
  })

  it("does nothing when the user cancels the connection pick", async () => {
    ;(pickAdtRoot as jest.Mock).mockResolvedValue(undefined)
    await setCurrentTransportCommand()
    expect(readTransports).not.toHaveBeenCalled()
    expect(setCurrentTransport).not.toHaveBeenCalled()
  })

  it("does nothing when the user dismisses the transport picker", async () => {
    ;(readTransports as jest.Mock).mockResolvedValue({
      workbench: [{ modifiable: [req("WB1")] }]
    })
    mockWindow.showQuickPick.mockResolvedValue(undefined)
    await setCurrentTransportCommand()
    expect(setCurrentTransport).not.toHaveBeenCalled()
  })

  it("reports errors instead of throwing", async () => {
    ;(readTransports as jest.Mock).mockRejectedValue(new Error("boom"))
    await setCurrentTransportCommand()
    expect(mockWindow.showErrorMessage).toHaveBeenCalled()
  })
})

describe("clearCurrentTransportCommand", () => {
  it("clears the transport for the resolved connection", async () => {
    await clearCurrentTransportCommand()
    expect(clearCurrentTransport).toHaveBeenCalledWith("TRL")
  })

  it("does nothing when no connection is resolved", async () => {
    ;(pickAdtRoot as jest.Mock).mockResolvedValue(undefined)
    await clearCurrentTransportCommand()
    expect(clearCurrentTransport).not.toHaveBeenCalled()
  })
})
