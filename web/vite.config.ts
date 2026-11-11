import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The Rust server embeds `dist/`; `pnpm dev` at the repo root builds this
// bundle and starts the server as one process. Vite is not started separately.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2022",
  },
});
