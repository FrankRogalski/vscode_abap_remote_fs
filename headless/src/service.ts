/**
 * Run the HTTP MCP server as a per-user service that starts at logon, on macOS, Windows and Linux.
 *
 * Every platform runs the same supervisor, `abapfs-mcp service run`, which
 *   - starts `abapfs-mcp serve --http` and restarts it when it exits,
 *   - checks the git checkout for updates every hour (scripts/update-local.mjs) and, after a
 *     rebuild, exits so the platform starts the new version.
 * The platform part only starts the supervisor at logon and again whenever it exits:
 *   macOS    launchd agent ~/Library/LaunchAgents/com.abapfs.mcp.plist (KeepAlive)
 *   Windows  Task Scheduler task \abapfs\abapfs-mcp, a hidden PowerShell loop at logon
 *   Linux    systemd user unit ~/.config/systemd/user/abapfs-mcp.service (Restart=always)
 * Services run inside the user's session, so the OS credential store is available.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { findConfigFile, loadConfig, stateHome } from "./config"

export const LABEL = "com.abapfs.mcp"
const OLD_LABELS = ["com.abapfs.mcp-update"] // separate updater agent of earlier versions
const WIN_TASK = "abapfs-mcp"
const WIN_FOLDER = "\\abapfs\\"
const UNIT = "abapfs-mcp.service"
const UPDATE_EVERY_MS = 60 * 60 * 1000
const FIRST_UPDATE_MS = 2 * 60 * 1000
const EXIT_UPDATED = 10 // update-local.mjs: rebuilt
const MAX_LOG = 5 * 1024 * 1024

const cliPath = () => fileURLToPath(import.meta.url) // dist/cli.js (bundled)
const repoRoot = () => resolve(dirname(cliPath()), "..", "..")
const updateScript = () => join(repoRoot(), "headless", "scripts", "update-local.mjs")
const canUpdate = () => existsSync(join(repoRoot(), ".git")) && existsSync(updateScript())

export const serviceDir = () => join(stateHome(), "abapfs-mcp")
export const logFile = () =>
  process.platform === "darwin"
    ? join(homedir(), "Library", "Logs", "abapfs-mcp.log")
    : join(serviceDir(), "logs", "abapfs-mcp.log")
const pidFile = () => join(serviceDir(), "service.pid")

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------- supervisor (service run)

function logLine(msg: string) {
  const f = logFile()
  mkdirSync(dirname(f), { recursive: true })
  try {
    if (statSync(f).size > MAX_LOG) renameSync(f, `${f}.1`)
  } catch {
    // no log yet
  }
  appendFileSync(f, `[${new Date().toISOString()}] ${msg}\n`)
}

function pipeToLog(child: ChildProcess) {
  const write = (d: Buffer) => {
    for (const line of d.toString().split(/\r?\n/)) if (line) logLine(line)
  }
  child.stdout?.on("data", write)
  child.stderr?.on("data", write)
}

export async function runSupervisor(configPath: string, autoUpdate: boolean) {
  mkdirSync(serviceDir(), { recursive: true })
  writeFileSync(pidFile(), String(process.pid))
  logLine(
    `supervisor ${process.pid} started (config ${configPath}, updates ${autoUpdate ? "on" : "off"})`
  )

  let child: ChildProcess | undefined
  let stopping = false
  let backoff = 5000
  const startServer = () => {
    const c = spawn(process.execPath, [cliPath(), "serve", "--http", "--config", configPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ABAPFS_SUPERVISOR_PID: String(process.pid) },
      windowsHide: true
    })
    const startedAt = Date.now()
    pipeToLog(c)
    c.on("exit", (code, signal) => {
      if (stopping || child !== c) return
      logLine(`server exited (${signal ?? code}), restarting in ${backoff / 1000}s`)
      if (Date.now() - startedAt > 60_000) backoff = 5000
      setTimeout(() => !stopping && (child = startServer()), backoff)
      backoff = Math.min(backoff * 2, 60_000)
    })
    return c
  }
  const stop = (code: number) => {
    stopping = true
    child?.kill()
    try {
      if (readFileSync(pidFile(), "utf8") === String(process.pid)) rmSync(pidFile())
    } catch {
      // already gone
    }
    setTimeout(() => process.exit(code), 500)
  }
  process.on("SIGTERM", () => stop(0))
  process.on("SIGINT", () => stop(0))

  child = startServer()
  if (!autoUpdate || !canUpdate()) return
  await sleep(FIRST_UPDATE_MS)
  for (;;) {
    const r = spawnSync(process.execPath, [updateScript()], {
      encoding: "utf8",
      windowsHide: true,
      cwd: repoRoot()
    })
    for (const line of `${r.stdout ?? ""}${r.stderr ?? ""}`.split(/\r?\n/))
      if (line) logLine(`update: ${line}`)
    if (r.status === EXIT_UPDATED) {
      logLine("updated, restarting with the new build")
      return stop(75) // the platform starts the new supervisor
    }
    await sleep(UPDATE_EVERY_MS)
  }
}

/** Called by `serve`: exit when the supervisor that started us is gone (Windows has no process groups) */
export function watchSupervisor() {
  const pid = Number(process.env.ABAPFS_SUPERVISOR_PID)
  if (!pid) return
  setInterval(() => {
    try {
      process.kill(pid, 0)
    } catch {
      process.exit(0)
    }
  }, 5000).unref()
}

// ---------------------------------------------------------------- helpers

const run = (cmd: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}) =>
  spawnSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    input: opts.input,
    env: { ...process.env, ...opts.env }
  })

const must = (r: ReturnType<typeof run>, what: string) => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim()}`)
  return r.stdout
}

const which = (cmd: string) => {
  const r = run(process.platform === "win32" ? "where" : "which", [cmd])
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0]!.trim() : undefined
}

/** PATH for the service: where node, git and pnpm live now, plus the system dirs */
const servicePath = () => {
  const sep = process.platform === "win32" ? ";" : ":"
  const dirs = [dirname(process.execPath)]
  for (const t of ["git", "pnpm"]) {
    const p = which(t)
    if (p) dirs.push(dirname(p))
  }
  const system =
    process.platform === "win32"
      ? (process.env.PATH ?? "").split(sep)
      : ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
  return [...new Set([...dirs, ...system])].join(sep)
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`
const encodedPs = (script: string) => Buffer.from(script, "utf16le").toString("base64")
const powershell = (script: string) =>
  run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedPs(script)
  ])

// ---------------------------------------------------------------- macOS (launchd)

const launchd = {
  plist: (label: string) => join(homedir(), "Library", "LaunchAgents", `${label}.plist`),
  domain: () => `gui/${process.getuid!()}`,
  install(args: string[]) {
    const p = launchd.plist(LABEL)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(
      p,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(a => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(servicePath())}</string></dict>
  <key>WorkingDirectory</key><string>${xml(repoRoot())}</string>
  <key>StandardOutPath</key><string>${xml(logFile())}</string>
  <key>StandardErrorPath</key><string>${xml(logFile())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
`
    )
    must(run("plutil", ["-lint", "-s", p]), "plutil")
    for (const l of [LABEL, ...OLD_LABELS]) launchd.bootout(l)
    for (const l of OLD_LABELS) rmSync(launchd.plist(l), { force: true })
    // bootstrap right after bootout can fail with "5: Input/output error" while the old job winds down
    let r = run("launchctl", ["bootstrap", launchd.domain(), p])
    for (let i = 0; i < 10 && r.status !== 0; i++) {
      spawnSync("sleep", ["1"])
      r = run("launchctl", ["bootstrap", launchd.domain(), p])
    }
    must(r, "launchctl bootstrap")
  },
  /** bootout and wait until the job is really gone */
  bootout(label: string) {
    const target = `${launchd.domain()}/${label}`
    if (run("launchctl", ["bootout", target]).status !== 0) return
    for (let i = 0; i < 20 && run("launchctl", ["print", target]).status === 0; i++)
      spawnSync("sleep", ["0.5"])
  },
  uninstall() {
    for (const l of [LABEL, ...OLD_LABELS]) {
      launchd.bootout(l)
      rmSync(launchd.plist(l), { force: true })
    }
  },
  restart: () =>
    must(run("launchctl", ["kickstart", "-k", `${launchd.domain()}/${LABEL}`]), "launchctl"),
  status() {
    const r = run("launchctl", ["print", `${launchd.domain()}/${LABEL}`])
    if (r.status !== 0) return "not installed"
    const state = r.stdout.match(/^\tstate = (.*)$/m)?.[1] ?? "?"
    const exit = r.stdout.match(/last exit code = (.*)$/m)?.[1]
    return `launchd agent ${LABEL}: ${state}${exit ? ` (last exit ${exit})` : ""}`
  }
}

// ---------------------------------------------------------------- Windows (Task Scheduler)

const taskScheduler = {
  install(args: string[]) {
    // hidden PowerShell loop: restarts the supervisor whenever it exits (updates, crashes)
    const command = `while ($true) { & ${args.map(psQuote).join(" ")}; Start-Sleep -Seconds 5 }`
    const argument = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${encodedPs(command)}`
    const script = `
$ErrorActionPreference = 'Stop'
$user = "$env:USERDOMAIN\\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $env:ABAPFS_TASK_ARG -WorkingDirectory $env:ABAPFS_TASK_CWD
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName ${psQuote(WIN_TASK)} -TaskPath ${psQuote(WIN_FOLDER)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
`
    taskScheduler.stop()
    must(
      run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          encodedPs(script)
        ],
        { env: { ABAPFS_TASK_ARG: argument, ABAPFS_TASK_CWD: repoRoot(), PATH: servicePath() } }
      ),
      "Register-ScheduledTask"
    )
    must(
      powershell(
        `Start-ScheduledTask -TaskName ${psQuote(WIN_TASK)} -TaskPath ${psQuote(WIN_FOLDER)}`
      ),
      "Start-ScheduledTask"
    )
  },
  stop() {
    powershell(
      `Stop-ScheduledTask -TaskName ${psQuote(WIN_TASK)} -TaskPath ${psQuote(WIN_FOLDER)} -ErrorAction SilentlyContinue`
    )
    killSupervisor() // the task stops the PowerShell loop, not the node processes under it
  },
  uninstall() {
    taskScheduler.stop()
    powershell(
      `Unregister-ScheduledTask -TaskName ${psQuote(WIN_TASK)} -TaskPath ${psQuote(WIN_FOLDER)} -Confirm:$false -ErrorAction SilentlyContinue`
    )
  },
  restart: () => killSupervisor(), // the PowerShell loop starts a fresh one
  status() {
    const r = powershell(
      `$t = Get-ScheduledTask -TaskName ${psQuote(WIN_TASK)} -TaskPath ${psQuote(WIN_FOLDER)} -ErrorAction SilentlyContinue; if ($t) { $t.State } else { 'missing' }`
    )
    const state = r.stdout.trim()
    return state === "missing" || !state
      ? "not installed"
      : `scheduled task ${WIN_FOLDER}${WIN_TASK}: ${state}`
  }
}

// ---------------------------------------------------------------- Linux (systemd --user)

const systemd = {
  unit: () =>
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", UNIT),
  install(args: string[]) {
    const q = (a: string) => `"${a.replace(/(["\\])/g, "\\$1")}"`
    const p = systemd.unit()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(
      p,
      `[Unit]
Description=ABAP FS MCP server (headless)
After=network-online.target

[Service]
ExecStart=${args.map(q).join(" ")}
WorkingDirectory=${repoRoot()}
Environment=${q(`PATH=${servicePath()}`)}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
    )
    must(run("systemctl", ["--user", "daemon-reload"]), "systemctl daemon-reload")
    must(run("systemctl", ["--user", "enable", "--now", UNIT]), "systemctl enable")
    run("systemctl", ["--user", "restart", UNIT])
  },
  uninstall() {
    run("systemctl", ["--user", "disable", "--now", UNIT])
    rmSync(systemd.unit(), { force: true })
    run("systemctl", ["--user", "daemon-reload"])
  },
  restart: () => must(run("systemctl", ["--user", "restart", UNIT]), "systemctl restart"),
  status() {
    const r = run("systemctl", ["--user", "is-active", UNIT])
    return existsSync(systemd.unit())
      ? `systemd user unit ${UNIT}: ${r.stdout.trim()}`
      : "not installed"
  }
}

// ---------------------------------------------------------------- commands

const platformImpl = () => {
  if (process.platform === "darwin") return launchd
  if (process.platform === "win32") return taskScheduler
  if (process.platform === "linux") return systemd
  throw new Error(`Services are not supported on ${process.platform}`)
}

function killSupervisor() {
  try {
    const pid = Number(readFileSync(pidFile(), "utf8"))
    if (pid) process.kill(pid)
  } catch {
    // not running
  }
}

async function health(port: number, host: string) {
  try {
    const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host
    const r = await fetch(`http://${h}:${port}/health`, { signal: AbortSignal.timeout(3000) })
    return r.ok ? "ok" : `HTTP ${r.status}`
  } catch {
    return "not responding"
  }
}

export async function serviceCommand(
  sub: string | undefined,
  opts: { config?: string; noUpdate?: boolean }
) {
  const impl = platformImpl()
  const out = (s: string) => process.stdout.write(`${s}\n`)
  switch (sub) {
    case "install": {
      const configPath = findConfigFile(opts.config)
      const cfg = loadConfig(configPath)
      if (!cfg.mcp.apiKey)
        out("warning: mcp.apiKey is not set; any local process can use the server")
      const args = [process.execPath, cliPath(), "service", "run", "--config", configPath]
      if (opts.noUpdate) args.push("--no-update")
      impl.install(args)
      out(`Installed: ${impl.status()}`)
      out(`Endpoint:  http://${cfg.mcp.host}:${cfg.mcp.port}/mcp`)
      out(`Log:       ${logFile()}`)
      out(
        `Updates:   ${opts.noUpdate ? "off" : canUpdate() ? "hourly from git" : "off (not a git checkout)"}`
      )
      for (let i = 0; i < 20; i++) {
        if ((await health(cfg.mcp.port, cfg.mcp.host)) === "ok") return out("Health:    ok")
        await sleep(1000)
      }
      return out(`Health:    not responding yet, see ${logFile()}`)
    }
    case "uninstall":
      impl.uninstall()
      return out("Service removed")
    case "restart":
      impl.restart()
      return out("Restarting")
    case "status":
    case undefined: {
      out(impl.status())
      let pid = ""
      try {
        pid = readFileSync(pidFile(), "utf8")
      } catch {
        // no supervisor
      }
      out(`supervisor: ${pid ? `pid ${pid}` : "not running"}`)
      try {
        const cfg = loadConfig(opts.config)
        out(`health (${cfg.mcp.host}:${cfg.mcp.port}): ${await health(cfg.mcp.port, cfg.mcp.host)}`)
      } catch (e) {
        out(`health: ${e instanceof Error ? e.message : e}`)
      }
      return out(`log: ${logFile()}`)
    }
    default:
      throw new Error(`Unknown service command '${sub}': use install, uninstall, restart, status`)
  }
}
