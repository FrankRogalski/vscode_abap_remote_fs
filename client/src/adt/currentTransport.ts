import { ConfigurationTarget, workspace } from "vscode"

const CONFIGROOT = "abapfs"
const KEY = "currentTransport"

/**
 * Per-connection "currently working on" transport request.
 *
 * New objects created by the AI/MCP tools and objects modified for the first
 * time by the AI are auto-assigned to this transport, skipping the interactive
 * transport prompt. Clearing the entry restores the ask-every-time behaviour.
 *
 * Stored as a `{ [connId]: TRKORR }` map so each connected system keeps its own
 * transport (a request only exists in a single system).
 */
type TransportMap = Record<string, string>

const readMap = (): TransportMap =>
  workspace.getConfiguration(CONFIGROOT).get<TransportMap>(KEY) || {}

export const getCurrentTransport = (connId: string): string | undefined => {
  const transport = readMap()[connId.toLowerCase()]
  return transport || undefined
}

export const setCurrentTransport = async (connId: string, transport: string) => {
  const key = connId.toLowerCase()
  const map = { ...readMap() }
  if (transport) map[key] = transport
  else delete map[key]
  await workspace.getConfiguration(CONFIGROOT).update(KEY, map, ConfigurationTarget.Global)
}

export const clearCurrentTransport = (connId: string) => setCurrentTransport(connId, "")
