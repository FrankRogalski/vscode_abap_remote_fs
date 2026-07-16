/**
 * Transport selection driven through the MCP client.
 *
 * While an MCP tool invocation runs, the MCP server registers an elicitor
 * here. When a write needs a transport — creating an object, or editing a
 * transportable object that is not yet locked into one — the connected MCP
 * client is asked (via elicitation) to pick one of the transports SAP
 * proposes for that object. Nothing is remembered: every write that needs a
 * transport asks again.
 *
 * When no elicitor is registered (VS Code Copilot, manual edits) the normal
 * interactive VS Code prompt is used, exactly as before. When an elicitor IS
 * registered, a declined or unsupported elicitation fails the write — the
 * VS Code prompt is never shown for MCP writes.
 */

export interface TransportChoice {
  /** Transport request id (TRKORR). */
  transport: string
  /** Human readable description (AS4TEXT). */
  description: string
}

/**
 * Asks the user to pick a transport through the MCP client.
 * Resolves to the chosen TRKORR, or `undefined` when the user declined.
 * Throws when the client cannot elicit at all.
 */
export type TransportElicitor = (
  objDescription: string,
  choices: TransportChoice[]
) => Promise<string | undefined>

let elicitor: TransportElicitor | undefined

/** Register (or clear) the elicitor the MCP server provides for the duration
 *  of a tool invocation. Passing `undefined` restores the normal interactive
 *  prompt. */
export const setTransportElicitor = (fn: TransportElicitor | undefined) => {
  elicitor = fn
}

export const hasTransportElicitor = () => !!elicitor

/** Ask the user, through the MCP client, to pick one of the given transports.
 *  Returns the chosen TRKORR, or `undefined` when the user declined or no
 *  elicitor is registered. */
export const elicitTransport = async (
  objDescription: string,
  choices: TransportChoice[]
): Promise<string | undefined> => {
  if (!elicitor) return undefined
  return elicitor(objDescription, choices)
}
