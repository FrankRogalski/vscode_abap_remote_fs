import { ADTClient } from "abap-adt-api"
import { getClient } from "./conections"

const getTransportConfig = async (client: ADTClient) => {
  const configs = await client.transportConfigurations()

  if (configs[0]) return configs[0]
  await client.createTransportsConfig()
  const newconfigs = await client.transportConfigurations()
  if (!newconfigs[0]) throw new Error("Transport configuration not found")
  return newconfigs[0]
}

/** Read the transports of a user, honouring a system's transport configuration
 *  when present. Kept free of view/UI imports so it can be reused from
 *  lightweight modules (MCP server, transport selection) without dragging in
 *  the SCM/revision chain. */
export const readTransports = async (connId: string, user: string) => {
  const client = getClient(connId)
  if (await client.hasTransportConfig()) {
    const User = user.toUpperCase()
    const { etag, link } = await getTransportConfig(client)
    const config = await client.getTransportConfiguration(link)
    if (config.User !== User) await client.setTransportsConfig(link, etag, { ...config, User })
    return client.transportsByConfig(link)
  } else return client.userTransports(user)
}
