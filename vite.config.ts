import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// package.json exports the prebuilt GUI bundle; OpenCode supplies its runtime modules.
export default defineConfig({
  plugins: [gui({ outFile: "gui-experimental.cjs" })],
})
