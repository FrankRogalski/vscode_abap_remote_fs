jest.mock(
  "vscode",
  () => {
    const item = {
      text: "",
      tooltip: "",
      command: undefined as any,
      name: "",
      show: jest.fn(),
      hide: jest.fn(),
      dispose: jest.fn()
    }
    const state: { activeTextEditor: any; workspaceFolders: any } = {
      activeTextEditor: undefined,
      workspaceFolders: undefined
    }
    return {
      __item: item,
      __state: state,
      StatusBarAlignment: { Right: 2 },
      window: {
        get activeTextEditor() {
          return state.activeTextEditor
        },
        createStatusBarItem: () => item,
        onDidChangeActiveTextEditor: () => ({ dispose() {} })
      },
      workspace: {
        get workspaceFolders() {
          return state.workspaceFolders
        },
        onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
        onDidChangeConfiguration: () => ({ dispose() {} })
      }
    }
  },
  { virtual: true }
)
jest.mock("../commands", () => ({
  AbapFsCommands: { setCurrentTransport: "abapfs.setCurrentTransport" }
}))
jest.mock("./conections", () => ({ ADTSCHEME: "adt" }))
jest.mock("./currentTransport", () => ({ getCurrentTransport: jest.fn() }))

import {
  initCurrentTransportStatusBar,
  updateCurrentTransportStatusBar
} from "./currentTransportStatusBar"
import { getCurrentTransport } from "./currentTransport"

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require("vscode")
const item = vscode.__item
const state = vscode.__state
const root = (authority: string) => ({ uri: { scheme: "adt", authority } })
const adtEditor = (authority: string) => ({
  document: { uri: { scheme: "adt", authority, path: "/x" } }
})

beforeEach(() => {
  jest.clearAllMocks()
  item.text = ""
  item.tooltip = ""
  item.command = undefined
  state.activeTextEditor = undefined
  state.workspaceFolders = undefined
  ;(getCurrentTransport as jest.Mock).mockReturnValue(undefined)
  initCurrentTransportStatusBar({ subscriptions: [] } as any)
})

it("hides when no ABAP system is mounted", () => {
  expect(item.hide).toHaveBeenCalled()
  expect(item.show).not.toHaveBeenCalled()
})

it("shows the sole connection's transport when none is set", () => {
  state.workspaceFolders = [root("trl")]
  ;(getCurrentTransport as jest.Mock).mockReturnValue(undefined)
  updateCurrentTransportStatusBar()
  expect(item.show).toHaveBeenCalled()
  expect(item.text).toBe("$(git-commit) No transport")
  expect(item.command.arguments).toEqual([])
  expect(getCurrentTransport).toHaveBeenCalledWith("trl")
})

it("shows the configured transport for the active editor's connection", () => {
  state.workspaceFolders = [root("trl"), root("prd")]
  state.activeTextEditor = adtEditor("prd")
  ;(getCurrentTransport as jest.Mock).mockReturnValue("PRDK900999")
  updateCurrentTransportStatusBar()
  expect(item.text).toBe("$(git-commit) PRDK900999")
  expect(getCurrentTransport).toHaveBeenCalledWith("prd")
  // clicking edits the connection shown -> active editor uri passed through
  expect(item.command.command).toBe("abapfs.setCurrentTransport")
  expect(item.command.arguments[0].authority).toBe("prd")
})

it("shows a neutral label when the connection is ambiguous", () => {
  state.workspaceFolders = [root("trl"), root("prd")]
  state.activeTextEditor = undefined
  updateCurrentTransportStatusBar()
  expect(item.text).toBe("$(git-commit) ABAP transport")
  expect(item.command.arguments).toEqual([])
  expect(getCurrentTransport).not.toHaveBeenCalled()
})
