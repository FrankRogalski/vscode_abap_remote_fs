/**
 * MCP transports around upstream's own createMcpServer(), so the tool list, descriptions,
 * schemas and get_abap_diagnostics stay exactly as in the VS Code extension.
 */
import { randomUUID } from "node:crypto"
import http from "node:http"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import type { McpConfig } from "./config"
import { log } from "./log"

type McpServerLike = { connect(t: unknown): Promise<void>; close(): Promise<void> }

async function upstream() {
  const m: any = await import("upstream:services/mcpServer")
  return {
    createMcpServer: m.__headlessCreateMcpServer as () => McpServerLike,
    validateApiKey: m.validateApiKey as (req: http.IncomingMessage) => boolean
  }
}

export async function serveStdio(): Promise<() => Promise<void>> {
  const { createMcpServer } = await upstream()
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log.info("MCP server ready on stdio")
  return () => server.close()
}

const readBody = (req: http.IncomingMessage) =>
  new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", c => chunks.push(c))
    req.on("end", () => {
      try {
        const s = Buffer.concat(chunks).toString("utf8")
        resolve(s ? JSON.parse(s) : undefined)
      } catch (e) {
        reject(e)
      }
    })
    req.on("error", reject)
  })

const jsonError = (res: http.ServerResponse, status: number, code: number, message: string) => {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }))
}

export async function serveHttp(cfg: McpConfig): Promise<() => Promise<void>> {
  const { createMcpServer, validateApiKey } = await upstream()
  const sessions = new Map<string, StreamableHTTPServerTransport>()

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host ?? "localhost"}`)
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok", server: "abap-fs-mcp", headless: true }))
      return
    }
    if (url.pathname !== "/mcp") return jsonError(res, 404, -32601, "Not found: use /mcp")
    if (!validateApiKey(req)) return jsonError(res, 401, -32001, "Unauthorized: invalid or missing API key")

    const sessionId = req.headers["mcp-session-id"] as string | undefined
    try {
      if (req.method === "POST") {
        const body = await readBody(req)
        let transport = sessionId ? sessions.get(sessionId) : undefined
        if (!transport) {
          if (sessionId || !isInitializeRequest(body))
            return jsonError(res, 400, -32000, "Bad Request: no valid session ID provided")
          const t = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: id => void sessions.set(id, t)
          })
          t.onclose = () => {
            if (t.sessionId) sessions.delete(t.sessionId)
          }
          await createMcpServer().connect(t)
          transport = t
        }
        await transport.handleRequest(req, res, body)
        return
      }
      if (req.method === "GET" || req.method === "DELETE") {
        const transport = sessionId && sessions.get(sessionId)
        if (!transport) return jsonError(res, 400, -32000, "Invalid or missing session ID")
        await transport.handleRequest(req, res)
        return
      }
      jsonError(res, 405, -32000, "Method not allowed")
    } catch (e) {
      log.error(`MCP request failed: ${e}`)
      if (!res.headersSent) jsonError(res, 500, -32603, "Internal server error")
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(cfg.port, cfg.host, resolve)
  })
  if (!cfg.apiKey && !["127.0.0.1", "localhost", "::1"].includes(cfg.host))
    log.warn(`MCP server listens on ${cfg.host} without an apiKey`)
  process.stderr.write(`ABAP FS MCP server listening on http://${cfg.host}:${cfg.port}/mcp\n`)

  return async () => {
    for (const t of sessions.values()) await t.close().catch(() => undefined)
    await new Promise(r => server.close(r))
  }
}
