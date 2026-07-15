import { QuickPickItem, Uri } from "vscode"
import { TransportRequest } from "abap-adt-api"
import { funWindow as window } from "../services/funMessenger"
import { pickAdtRoot } from "../config"
import { getClient } from "../adt/conections"
import { readTransports } from "../adt/transportsService"
import {
  clearCurrentTransport,
  getCurrentTransport,
  setCurrentTransport
} from "../adt/currentTransport"
import { caughtToString } from "../lib"

interface TransportPick extends QuickPickItem {
  transport: string // empty string means "clear"
}

const clearPick = (current: string): TransportPick => ({
  label: "$(clear-all) Clear — ask every time",
  detail: `Remove the current transport (${current}); you will be prompted on each create / first edit`,
  transport: ""
})

// readTransports returns TransportsOfUser; the tree view also reads the
// undeclared "transportofcopies" bucket, so widen the access here too.
const collectModifiable = (transports: unknown): TransportRequest[] => {
  const groups = transports as Record<string, { modifiable?: TransportRequest[] }[]>
  const out: TransportRequest[] = []
  for (const cat of ["workbench", "customizing", "transportofcopies"]) {
    for (const target of groups?.[cat] || []) out.push(...(target.modifiable || []))
  }
  return out
}

const resolveConnId = async (uri?: Uri) => {
  const root = await pickAdtRoot(uri)
  return root?.uri.authority
}

export async function setCurrentTransportCommand(uri?: Uri) {
  try {
    const connId = await resolveConnId(uri)
    if (!connId) return
    const client = getClient(connId)
    const current = getCurrentTransport(connId)
    const transports = await readTransports(connId, client.username)
    const picks: TransportPick[] = collectModifiable(transports).map(r => ({
      label: r["tm:number"],
      description: r["tm:desc"],
      detail: current === r["tm:number"] ? "$(check) current" : undefined,
      transport: r["tm:number"]
    }))
    const items = current ? [clearPick(current), ...picks] : picks
    if (items.length === 0) {
      window.showInformationMessage(
        `No modifiable transports found for ${client.username.toUpperCase()} on ${connId}.`
      )
      return
    }
    const selection = await window.showQuickPick(items, {
      placeHolder: current
        ? `Current transport: ${current} — pick a new one or clear`
        : "Transport that AI-created and first-edited objects will be assigned to",
      ignoreFocusOut: true
    })
    if (!selection) return
    await setCurrentTransport(connId, selection.transport)
    window.showInformationMessage(
      selection.transport
        ? `Current transport for ${connId} set to ${selection.transport}`
        : `Current transport for ${connId} cleared — you will be asked every time`
    )
  } catch (e) {
    window.showErrorMessage(caughtToString(e))
  }
}

export async function clearCurrentTransportCommand(uri?: Uri) {
  try {
    const connId = await resolveConnId(uri)
    if (!connId) return
    await clearCurrentTransport(connId)
    window.showInformationMessage(
      `Current transport for ${connId} cleared — you will be asked every time`
    )
  } catch (e) {
    window.showErrorMessage(caughtToString(e))
  }
}
