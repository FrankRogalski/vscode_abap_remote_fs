import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: [
      { find: /^vscode$/, replacement: resolve(__dirname, "src/vscode/index.ts") },
      // a dependency exactly as upstream's client resolves it (same module instance)
      { find: /^upstream-dep:(.*)$/, replacement: resolve(__dirname, "../client/node_modules/$1") }
    ]
  },
  test: { globals: true, include: ["src/**/*.test.ts"] }
})
