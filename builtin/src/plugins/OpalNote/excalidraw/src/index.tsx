// Excalidraw viewer plugin. In `read` mode it renders a static SVG via
// `exportToSvg`; in `edit` mode it mounts the full Excalidraw editor. The host
// only exchanges scene JSON over postMessage — this frame has no API access.
import { createRoot, type Root } from "react-dom/client";

// The package's export map gates CSS behind the `production`/`development`
// conditions, so the viewer build resolves this with conditions:
// ["production", "browser"].
import "@excalidraw/excalidraw/index.css";

// Viewer frames are sandboxed with an opaque origin: give Excalidraw a memory
// storage fallback and point its lazy font loader at our own bundle.
try {
  window.localStorage.getItem("__probe__");
} catch {
  const memory = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (key: string) => (memory.has(key) ? memory.get(key) : null),
      setItem: (key: string, value: string) => memory.set(key, String(value)),
      removeItem: (key: string) => memory.delete(key),
      clear: () => memory.clear(),
      key: (index: number) => [...memory.keys()][index] ?? null,
      get length() {
        return memory.size;
      },
    },
  });
}
// Excalidraw resolves `./fonts/<family>/<file>.woff2` against this base and
// fetches fonts with `fetch()`. The frame has an opaque origin, so the base must
// be an absolute URL: derive it from this module's own URL (the bundle sits at
// the viewer root). The build also rewrites Excalidraw's esm.sh font fallback to
// this same base, so nothing reaches a CDN.
(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
  viewerAssetBase();

function viewerAssetBase(): string {
  try {
    const url = new URL(import.meta.url);
    url.pathname = url.pathname.replace(/[^/]*$/u, "");
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "/";
  }
}

type ViewerInit = {
  type: "opalnote-viewer/init";
  token?: string;
  mode?: "read" | "edit";
  content?: string;
};

type Scene = {
  elements?: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
};

const root = document.getElementById("root");
if (!root) throw new Error("viewer root is missing");

let token = "";
let mode: "read" | "edit" = "read";
let reactRoot: Root | null = null;

function post(message: Record<string, unknown>) {
  window.parent.postMessage({ ...message, token }, "*");
}

function parseScene(content: string): Scene {
  try {
    const value = JSON.parse(content) as Scene;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function sceneSnapshot(scene: Scene): string {
  return JSON.stringify({
    elements: scene.elements ?? [],
    appState: {
      viewBackgroundColor: (scene.appState ?? {}).viewBackgroundColor ?? null,
      gridSize: (scene.appState ?? {}).gridSize ?? null,
    },
    files: scene.files ?? {},
  });
}

function reportError(error: unknown) {
  post({
    type: "opalnote-viewer/error",
    message: error instanceof Error ? error.message : String(error),
  });
}

async function renderRead(content: string) {
  const scene = parseScene(content);
  const elements = Array.isArray(scene.elements) ? scene.elements : [];
  if (elements.length === 0) {
    root.innerHTML = "";
    const empty = document.createElement("p");
    empty.className = "picker";
    empty.textContent = "Empty drawing — click to open the editor.";
    root.appendChild(empty);
    post({ type: "opalnote-viewer/resize", height: 120 });
    return;
  }
  const { exportToSvg } = await import("@excalidraw/excalidraw");
  const svg = await exportToSvg({
    elements: elements as never,
    appState: { ...(scene.appState ?? {}), exportWithDarkMode: false } as never,
    files: (scene.files ?? {}) as never,
  });
  root.innerHTML = "";
  root.appendChild(svg);
  const height = Math.ceil(svg.getBoundingClientRect().height || svg.height.baseVal?.value || 0);
  window.requestAnimationFrame(() =>
    post({ type: "opalnote-viewer/resize", height: Math.max(height, 64) }),
  );
}

async function renderEdit(content: string) {
  const scene = parseScene(content);
  const { Excalidraw } = await import("@excalidraw/excalidraw");
  // The mount emits a change for its initial state; only real edits are drafts.
  let lastSnapshot = sceneSnapshot(scene);
  let saveTimer: number | null = null;
  let interacted = false;
  const markInteracted = () => {
    interacted = true;
  };
  root.addEventListener("pointerdown", markInteracted, { capture: true, once: true });
  root.addEventListener("keydown", markInteracted, { capture: true, once: true });
  if (!reactRoot) {
    root.innerHTML = "";
    reactRoot = createRoot(root);
  }
  reactRoot.render(
    <Excalidraw
      initialData={{
        elements: (scene.elements ?? []) as never,
        appState: (scene.appState ?? {}) as never,
        files: (scene.files ?? {}) as never,
        scrollToContent: true,
      }}
      theme="light"
      UIOptions={{
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          export: false,
          saveAsImage: false,
          toggleTheme: false,
          changeViewBackgroundColor: true,
          clearCanvas: true,
        },
      }}
      onChange={(elements, appState, files) => {
        if (!interacted) return;
        const next = sceneSnapshot({ elements, appState, files });
        if (next === lastSnapshot) return;
        lastSnapshot = next;
        if (saveTimer !== null) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
          saveTimer = null;
          post({
            type: "opalnote-viewer/save",
            content: JSON.stringify({
              type: "excalidraw",
              version: 2,
              source: "opalnote",
              elements,
              appState: {
                viewBackgroundColor: appState.viewBackgroundColor,
                gridSize: appState.gridSize,
              },
              files,
            }),
          });
        }, 500);
      }}
    />,
  );
  window.requestAnimationFrame(() => {
    const height = Math.round(root.clientHeight);
    if (height > 0) post({ type: "opalnote-viewer/resize", height });
  });
}

function render(content: string) {
  const task = mode === "edit" ? renderEdit(content) : renderRead(content);
  void task.catch(reportError);
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const data = event.data as ViewerInit | { type?: string; token?: string; content?: string };
  if (!data || typeof data !== "object") return;
  if (data.type === "opalnote-viewer/init") {
    token = typeof data.token === "string" ? data.token : "";
    mode = data.mode === "edit" ? "edit" : "read";
    render(typeof data.content === "string" ? data.content : "");
    return;
  }
  if (data.type === "opalnote-viewer/render") {
    if (token && data.token !== undefined && data.token !== token) return;
    if (mode === "read") render(typeof data.content === "string" ? data.content : "");
  }
});

if (mode === "read") {
  root.addEventListener("click", () => post({ type: "opalnote-viewer/open" }));
}

// Read mode sizes itself from the exported SVG; edit mode fills the lightbox.
// Re-posting the frame's own height on resize would feed the host's clamp back
// into the frame and collapse the embed, so nothing is sent here.

post({ type: "opalnote-viewer/ready" });
