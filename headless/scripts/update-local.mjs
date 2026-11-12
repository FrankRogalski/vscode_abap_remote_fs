#!/usr/bin/env node
// Update a local checkout of this fork and rebuild the MCP server when the fork has moved.
// Used hourly by the service supervisor (`abapfs-mcp service run`) and fine to run by hand.
//
//   node headless/scripts/update-local.mjs [--force]
// Exit codes: 0 up to date, 10 updated and rebuilt, 1 failed (checkout left as it was if the
// pull failed; a failed build leaves the previous dist in git's state, rerun with --force).
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const force = process.argv.includes("--force")
const win = process.platform === "win32"

function sh(cmd, args, capture = false) {
  // pnpm is a .cmd shim on Windows, which needs a shell
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: win && cmd === "pnpm",
    windowsHide: true
  })
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`)
  return (r.stdout ?? "").trim()
}

try {
  console.log(`[${new Date().toISOString()}] checking for updates`)
  sh("git", ["fetch", "--quiet", "origin"])
  const head = sh("git", ["rev-parse", "HEAD"], true)
  const upstream = sh("git", ["rev-parse", "@{u}"], true)
  const built = existsSync(join(root, "headless", "dist", "cli.js"))
  if (head === upstream && built && !force) {
    console.log(`up to date at ${head.slice(0, 8)}`)
    process.exit(0)
  }
  sh("git", ["pull", "--ff-only", "--quiet"])
  sh("pnpm", ["install", "--ignore-scripts", "--frozen-lockfile", "--reporter=silent"])
  sh("pnpm", ["--filter", "abapfs-headless", "build"])
  console.log(`rebuilt at ${sh("git", ["rev-parse", "--short", "HEAD"], true)}`)
  process.exit(10)
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
