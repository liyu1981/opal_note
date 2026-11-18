import { ApiError, api } from "../api/client";
import { mountViewer } from "../plugins/viewerMount";
import { viewerTheme } from "../plugins/viewers";

export type ThumbnailViewer = {
  id: string;
  src: string;
  sandbox: "opaque" | "same-origin";
};

export type DiagramThumbnail = {
  url: string | null;
  blob: Blob | null;
  error: string | null;
};

/** Object URLs keyed by notebook + path + asset mtime. */
const objectUrls = new Map<string, string>();
const pending = new Map<string, Promise<DiagramThumbnail>>();

/**
 * Each render boots a full viewer frame, so only a couple run at once; the
 * rest wait their turn and fill in as they finish.
 */
const MAX_PARALLEL_RENDERS = 2;
let activeRenders = 0;
const waiting: Array<() => void> = [];

const RENDER_TIMEOUT_MS = 25_000;

function acquireSlot(): Promise<void> {
  if (activeRenders < MAX_PARALLEL_RENDERS) {
    activeRenders += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      activeRenders += 1;
      resolve();
    });
  });
}

function releaseSlot(): void {
  activeRenders -= 1;
  waiting.shift()?.();
}

function cacheKey(
  notebookId: string,
  path: string,
  updatedAt: string,
): string {
  return `${notebookId}\u0000${path}\u0000${updatedAt}`;
}

function remember(key: string, blob: Blob): string {
  if (objectUrls.size > 200) {
    for (const url of objectUrls.values()) URL.revokeObjectURL(url);
    objectUrls.clear();
  }
  const url = URL.createObjectURL(blob);
  objectUrls.set(key, url);
  return url;
}

/** Render the diagram in an off-screen viewer frame and return a PNG. */
async function renderThumbnail(
  notebookId: string,
  path: string,
  extension: string,
  viewer: ThumbnailViewer,
): Promise<Blob> {
  await acquireSlot();
  try {
    // Always render the bytes on disk, never a cached copy: the server keys
    // thumbnails by content, so a stale read would poison the cache.
    const content = await (await api.getAssetBlob(notebookId, path, true)).text();
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:fixed;left:-10000px;top:0;width:960px;height:720px;opacity:0;pointer-events:none";
    document.body.appendChild(host);

    let mount: ReturnType<typeof mountViewer> | undefined;
    try {
      const png = await new Promise<ArrayBuffer>((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new Error("The diagram thumbnail timed out.")),
          RENDER_TIMEOUT_MS,
        );
        mount = mountViewer(host, {
          src: viewer.src,
          sandbox: viewer.sandbox,
          mode: "read",
          thumbnail: true,
          content,
          extension,
          theme: viewerTheme(),
          onThumbnail: (buffer) => {
            window.clearTimeout(timer);
            resolve(buffer);
          },
          onError: (message) => {
            window.clearTimeout(timer);
            reject(new Error(message));
          },
        });
      });
      return new Blob([png], { type: "image/png" });
    } finally {
      mount?.destroy();
      host.remove();
    }
  } finally {
    releaseSlot();
  }
}

/**
 * Thumbnail for a diagram asset: the stored PNG from the server, or a fresh
 * render that is uploaded so the next visit is instant. Results are cached per
 * asset version.
 */
export function diagramThumbnail(
  notebookId: string,
  path: string,
  extension: string,
  updatedAt: string,
  viewer: ThumbnailViewer,
): Promise<DiagramThumbnail> {
  const key = cacheKey(notebookId, path, updatedAt);
  const cached = objectUrls.get(key);
  if (cached) return Promise.resolve({ url: cached, blob: null, error: null });
  const inflight = pending.get(key);
  if (inflight) return inflight;

  const task = (async (): Promise<DiagramThumbnail> => {
    const stored = await api.getAssetThumbnail(notebookId, path).catch(() => null);
    if (stored?.blob) {
      return { url: remember(key, stored.blob), blob: stored.blob, error: null };
    }
    // Without a digest the asset is gone or not a diagram; nothing to render.
    if (!stored?.hash) {
      return { url: null, blob: null, error: null };
    }
    try {
      const png = await renderThumbnail(notebookId, path, extension, viewer);
      const url = remember(key, png);
      await api
        .putAssetThumbnail(notebookId, path, stored.hash, png)
        .catch(async (cause: unknown) => {
          // 409 means the asset changed while we rendered: store it under the
          // current digest instead of leaving a mismatched cache entry.
          if (!(cause instanceof ApiError) || cause.status !== 409) return;
          const current = await api
            .getAssetThumbnail(notebookId, path)
            .catch(() => null);
          if (!current?.hash || current.hash === stored.hash) return;
          await api
            .putAssetThumbnail(notebookId, path, current.hash, png)
            .catch(() => undefined);
        });
      return { url, blob: png, error: null };
    } catch (cause) {
      return {
        url: null,
        blob: null,
        error:
          cause instanceof Error
            ? cause.message
            : "Could not render the diagram",
      };
    }
  })();

  pending.set(key, task);
  void task.finally(() => pending.delete(key));
  return task;
}
