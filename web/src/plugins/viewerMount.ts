/**
 * Mount a sandboxed viewer iframe and speak the `opalnote-viewer/*` protocol.
 *
 * The frame runs with `sandbox="allow-scripts"` (opaque origin), so it has no
 * cookies, storage or API access; all content and actions travel through
 * postMessage. Messages are accepted only from this frame and only when they
 * echo the per-mount token.
 */

export type ViewerMode = "read" | "edit";

export type ViewerMountOptions = {
  /** Absolute or root-relative URL of the viewer entry HTML. */
  src: string;
  mode: ViewerMode;
  content: string;
  extension: string;
  theme?: Record<string, string>;
  /** Seconds to wait for the viewer's `ready` before failing. */
  readyTimeoutSecs?: number;
  onResize?: (height: number) => void;
  onOpen?: () => void;
  onSave?: (content: string) => void;
  onError?: (message: string, reason: "timeout" | "viewer") => void;
};

export type ViewerMount = {
  iframe: HTMLIFrameElement;
  /** Send new content to a `renderer` viewer without reloading the frame. */
  render: (content: string) => void;
  destroy: () => void;
};

const MAX_CONTENT_CHARS = 8 * 1024 * 1024;

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function mountViewer(
  host: HTMLElement,
  options: ViewerMountOptions,
): ViewerMount {
  const token = randomToken();
  const iframe = document.createElement("iframe");
  iframe.className = "opalnote-viewer-frame";
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.title = `Viewer: ${options.extension}`;
  iframe.src = options.src;
  host.appendChild(iframe);

  let ready = false;
  let destroyed = false;
  let content = options.content;

  const send = (message: Record<string, unknown>) => {
    if (destroyed) return;
    iframe.contentWindow?.postMessage(message, "*");
  };

  const timer = window.setTimeout(() => {
    if (!ready && !destroyed) {
      options.onError?.("The viewer did not start in time.", "timeout");
    }
  }, Math.max(1, options.readyTimeoutSecs ?? 8) * 1000);

  const init = () => {
    send({
      type: "opalnote-viewer/init",
      v: 1,
      token,
      role: "renderer",
      mode: options.mode,
      extension: options.extension,
      content,
      theme: options.theme ?? {},
    });
  };

  const onMessage = (event: MessageEvent) => {
    if (destroyed || event.source !== iframe.contentWindow) return;
    const data = event.data as
      | { type?: string; token?: string; content?: string; height?: number; message?: string }
      | null;
    if (!data || typeof data !== "object" || typeof data.type !== "string") return;
    if (data.type === "opalnote-viewer/ready") {
      ready = true;
      window.clearTimeout(timer);
      init();
      return;
    }
    if (data.token !== undefined && data.token !== token) return;
    switch (data.type) {
      case "opalnote-viewer/resize": {
        const height = Number(data.height);
        if (Number.isFinite(height) && height > 0) {
          options.onResize?.(Math.min(Math.max(Math.round(height), 24), 8000));
        }
        break;
      }
      case "opalnote-viewer/save":
        if (typeof data.content === "string" && data.content.length <= MAX_CONTENT_CHARS) {
          content = data.content;
          options.onSave?.(data.content);
        }
        break;
      case "opalnote-viewer/open":
        options.onOpen?.();
        break;
      case "opalnote-viewer/error":
        options.onError?.(
          typeof data.message === "string" ? data.message : "Viewer error",
          "viewer",
        );
        break;
      default:
        break;
    }
  };

  window.addEventListener("message", onMessage);

  return {
    iframe,
    render(next: string) {
      content = next;
      send({ type: "opalnote-viewer/render", token, content: next });
    },
    destroy() {
      destroyed = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      iframe.remove();
    },
  };
}
