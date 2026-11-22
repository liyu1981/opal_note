import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./index.css";
import "katex/dist/katex.min.css";
import { loadLutez } from "./lib/lutez";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root is missing from index.html");
}

// Compile the shared markdown parser before the first render so the editor draws
// blocks and task rows from the same AST the server indexes. A failure is a
// warning, not a blank page: `parseBlocks`/`taskSignature` keep their legacy
// fallbacks (see `lib/lutez/index.ts`). The wait is capped so a stalled fetch can
// never hold the app hostage; the parser installs itself when it does arrive.
async function start(): Promise<void> {
  await Promise.race([
    loadLutez(),
    new Promise((resolve) => window.setTimeout(resolve, 4000)),
  ]);
  createRoot(container!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();

// Installable PWA: the service worker only provides an offline placeholder for
// navigations (notes live on the server), so registration stays optional and
// failures are ignored.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // A plain browser tab is a perfectly good fallback.
    });
  });
}
