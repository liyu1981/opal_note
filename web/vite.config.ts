import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const webRoot = path.dirname(fileURLToPath(import.meta.url));

// The Rust server embeds `dist/`; `pnpm dev` at the repo root builds this
// bundle and starts the server as one process. Vite is not started separately.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@app": path.join(webRoot, "src"),
      react: path.join(webRoot, "node_modules", "react"),
      "react/jsx-runtime": path.join(
        webRoot,
        "node_modules",
        "react",
        "jsx-runtime.js",
      ),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2022",
  },
});
