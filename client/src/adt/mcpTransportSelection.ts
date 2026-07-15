import { getClient } from "./conections"
import { readTransports } from "./transportsService"

/**
 * "Currently working on" transport selection driven through the MCP client.
 *
 * The sibling `currentTransport` feature lets the user pre-set a default
 * transport that AI/MCP writes are silently assigned to. This variant does not
 * store a default: when an AI/MCP operation needs a transport, the connected
 * MCP client is asked (via elicitation) to pick one from the user's modifiable
 * transports. The choice is remembered per connection for the rest of the
 * session so a single AI turn that touches several objects only prompts once.
 *
 * Nothing is wired to the extension config: the selection lives only in memory
 * and only applies while an MCP session provides an elicitor. Outside of MCP
 * (VS Code Copilot, manual edits) the normal interactive prompt is used.
 */

export interface TransportChoice {
  /** Transport request id (TRKORR). */
  transport: string
  /** Human readable description (AS4TEXT). */
  description: string
}

/**
 * Asks the user to pick a transport through the MCP client.
 * Resolves to the chosen TRKORR, an empty string for "local / no transport",
 * or `undefined` when the user cancelled/declined or the client cannot elicit.
 */
export type TransportElicitor = (
  connId: string,
  choices: TransportChoice[]
) => Promise<string | undefined>

let elicitor: TransportElicitor | undefined

/** Per-connection transport picked during the current session (lowercased connId
 *  -> TRKORR). An empty string is a deliberate "local / no transport" choice; an
 *  absent key means the user has not been asked yet. */
const sessionTransports = new Map<string, string>()

/** Register (or clear) the elicitor the MCP server provides for the duration of
 *  a tool invocation. Passing `undefined` disables MCP-driven selection so the
 *  normal interactive prompt is used. */
export const setTransportElicitor = (fn: TransportElicitor | undefined) => {
  elicitor = fn
}

export const hasTransportElicitor = () => !!elicitor

/** The transport already chosen for a connection this session, if any. */
export const getMcpWorkingTransport = (connId: string): string | undefined =>
  sessionTransports.get(connId.toLowerCase()) || undefined

/** Forget the remembered transport for one connection (or all) so the next
 *  write asks again. */
export const clearMcpWorkingTransport = (connId?: string) => {
  if (connId) sessionTransports.delete(connId.toLowerCase())
  else sessionTransports.clear()
}

// readTransports returns TransportsOfUser; the tree view also reads the
// undeclared "transportofcopies" bucket, so widen the access here too.
export const collectModifiable = (transports: unknown): TransportChoice[] => {
  const groups = transports as Record<string, { modifiable?: Array<Record<string, string>> }[]>
  const out: TransportChoice[] = []
  for (const cat of ["workbench", "customizing", "transportofcopies"]) {
    for (const target of groups?.[cat] || []) {
      for (const r of target.modifiable || [])
        out.push({ transport: r["tm:number"], description: r["tm:desc"] })
    }
  }
  return out
}

/** Read the user's modifiable transports and elicit a choice from the client.
 *  Caches and returns the selection, or `undefined` when nothing usable came
 *  back (no elicitor, no transports, user cancelled). */
const elicitAndRemember = async (connId: string): Promise<string | undefined> => {
  if (!elicitor) return undefined
  const client = getClient(connId)
  const choices = collectModifiable(await readTransports(connId, client.username))
  if (choices.length === 0) return undefined
  const chosen = await elicitor(connId, choices)
  if (chosen === undefined) return undefined
  sessionTransports.set(connId.toLowerCase(), chosen)
  return chosen || undefined
}

/** Transport to use for an AI/MCP write. Reuses the session choice when present,
 *  otherwise asks the client. Returns `undefined` outside an MCP context or when
 *  the user cancelled, so callers fall back to the normal interactive prompt. */
export const resolveMcpTransport = async (connId: string): Promise<string | undefined> => {
  const key = connId.toLowerCase()
  if (sessionTransports.has(key)) return sessionTransports.get(key) || undefined
  return elicitAndRemember(connId)
}

/** Force a fresh selection (ignoring any remembered choice) and remember it.
 *  Used by the explicit "select working transport" MCP tool. */
export const promptMcpTransport = async (connId: string): Promise<string | undefined> => {
  sessionTransports.delete(connId.toLowerCase())
  return elicitAndRemember(connId)
}
