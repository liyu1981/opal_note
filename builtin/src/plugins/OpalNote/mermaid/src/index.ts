// Mermaid viewer plugin: renders Markdown-embedded `.mermaid` assets with Pele
// inside a sandboxed iframe. The host owns the source editor and exchanges
// content over postMessage; nothing here touches the OpalNote API.
import { mount, type Mounted } from "pele";

type ViewerInit = {
  type: "opalnote-viewer/init";
  token?: string;
  mode?: "read" | "edit";
  content?: string;
  theme?: Record<string, string>;
};

const root = document.getElementById("root");
if (!root) throw new Error("viewer root is missing");

let mounted: Mounted | null = null;
let token = "";
let mode: "read" | "edit" = "read";

function post(message: Record<string, unknown>) {
  window.parent.postMessage({ ...message, token }, "*");
}

function applyTheme(theme?: Record<string, string>) {
  if (!theme) return;
  for (const [name, value] of Object.entries(theme)) {
    if (!name.startsWith("--") || typeof value !== "string") continue;
    document.documentElement.style.setProperty(name, value);
  }
}

function reportSize(naturalWidth = 0) {
  const height = Math.ceil(root.getBoundingClientRect().height);
  if (height <= 0) return;
  const width = Math.ceil(naturalWidth);
  post({
    type: "opalnote-viewer/resize",
    height,
    ...(width > 0 ? { width } : {}),
  });
}

function reportError(error: unknown) {
  post({
    type: "opalnote-viewer/error",
    message: error instanceof Error ? error.message : String(error),
  });
}

function render(content: string) {
  const fontFamily =
    getComputedStyle(document.documentElement).getPropertyValue("--pele-font") ||
    getComputedStyle(root).fontFamily ||
    undefined;
  const options = {
    zoom: mode === "edit",
    // Diagrams must not navigate or fetch from inside the sandbox.
    links: false,
    images: false,
    fontFamily,
    onRender: (result: { width?: number }) => {
      window.requestAnimationFrame(() => reportSize(result.width ?? 0));
    },
    onError: reportError,
  };
  if (!mounted) {
    mounted = mount(root, content, options);
  } else {
    mounted.update(content, options);
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const data = event.data as ViewerInit | { type?: string; token?: string; content?: string };
  if (!data || typeof data !== "object") return;

  if (data.type === "opalnote-viewer/init") {
    token = typeof data.token === "string" ? data.token : "";
    mode = data.mode === "edit" ? "edit" : "read";
    applyTheme(data.theme);
    render(typeof data.content === "string" ? data.content : "");
    return;
  }
  if (data.type === "opalnote-viewer/render") {
    if (token && data.token !== undefined && data.token !== token) return;
    render(typeof data.content === "string" ? data.content : "");
  }
});

// A click in read mode asks the host for the lightbox.
root.addEventListener("click", () => {
  if (mode === "read") post({ type: "opalnote-viewer/open" });
});

window.addEventListener("resize", () => {
  // `refresh()` re-renders and reports the new size through onRender.
  mounted?.refresh();
});

post({ type: "opalnote-viewer/ready" });
