import { ExtensionContext, StatusBarAlignment, StatusBarItem, Uri, window, workspace } from "vscode"
import { AbapFsCommands } from "../commands"
import { ADTSCHEME } from "./conections"
import { getCurrentTransport } from "./currentTransport"

let item: StatusBarItem | undefined

const adtRoots = () => (workspace.workspaceFolders || []).filter(r => r.uri.scheme === ADTSCHEME)

/** Connection the status bar refers to: the active ADT editor, else the sole
 *  connected system. Undefined when the choice is ambiguous or nothing is
 *  connected. The active editor's uri is passed to the command so a click
 *  edits the connection shown. */
const resolveContext = (): { connId?: string; uri?: Uri } => {
  const active = window.activeTextEditor?.document.uri
  if (active?.scheme === ADTSCHEME) return { connId: active.authority, uri: active }
  const roots = adtRoots()
  if (roots.length === 1) return { connId: roots[0].uri.authority }
  return {}
}

const render = () => {
  if (!item) return
  if (adtRoots().length === 0) {
    item.hide()
    return
  }
  const { connId, uri } = resolveContext()
  item.command = {
    title: "Set current transport",
    command: AbapFsCommands.setCurrentTransport,
    arguments: uri ? [uri] : []
  }
  if (!connId) {
    item.text = "$(git-commit) ABAP transport"
    item.tooltip = "Set the transport AI-created / first-edited objects are assigned to"
    item.show()
    return
  }
  const transport = getCurrentTransport(connId)
  item.text = transport ? `$(git-commit) ${transport}` : "$(git-commit) No transport"
  item.tooltip = transport
    ? `Current transport for ${connId}: ${transport}\nClick to change or clear (AI-created and first-edited objects are assigned to it)`
    : `No current transport for ${connId} — you are prompted on each create / first edit.\nClick to set one.`
  item.show()
}

/** Refresh the status bar (e.g. after the current transport changes). */
export const updateCurrentTransportStatusBar = () => render()

export function initCurrentTransportStatusBar(context: ExtensionContext) {
  // Right side, just left of the blame item (which uses priority 1000).
  item = window.createStatusBarItem(StatusBarAlignment.Right, 999)
  item.name = "ABAP FS Current Transport"
  context.subscriptions.push(item)

  context.subscriptions.push(
    window.onDidChangeActiveTextEditor(render),
    workspace.onDidChangeWorkspaceFolders(render),
    workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("abapfs.currentTransport")) render()
    }),
    { dispose: () => (item = undefined) }
  )

  render()
}
