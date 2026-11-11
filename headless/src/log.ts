/** Logging always goes to stderr: stdout belongs to command output and the MCP stdio transport */
const levels = { error: 0, warn: 1, info: 2, debug: 3 } as const
export type LogLevel = keyof typeof levels

let current: LogLevel = (process.env.ABAPFS_LOG_LEVEL as LogLevel) || "warn"

export const setLogLevel = (level: LogLevel) => {
  if (!process.env.ABAPFS_LOG_LEVEL) current = level
}

const emit = (level: LogLevel, msg: string) => {
  if (levels[level] <= levels[current]) process.stderr.write(`[abapfs ${level}] ${msg}\n`)
}

export const log = {
  error: (m: string) => emit("error", m),
  warn: (m: string) => emit("warn", m),
  info: (m: string) => emit("info", m),
  debug: (m: string) => emit("debug", m)
}
