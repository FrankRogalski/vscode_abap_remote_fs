import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { alias: { vscode: resolve(__dirname, "src/vscode/index.ts") } },
  test: { globals: true, include: ["src/**/*.test.ts"] }
})
