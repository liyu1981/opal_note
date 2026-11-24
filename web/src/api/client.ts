import type {
  AgentInfo,
  AssetEntry,
  AssetInfo,
  AssetList,
  BlockHit,
  BlockOverview,
  BlockTarget,
  BackgroundList,
  GraphData,
  Health,
  JournalPage,
  JournalPluginResult,
  Meta,
  Note,
  NoteSummary,
  Notebook,
  PageList,
  PageOverview,
  PluginList,
  QueryResult,
  Stats,
  TagCount,
  TaskList,
  TrashDetail,
  TrashList,
  TrashRestoreResult,
} from "./types";

import {
  ensureSession,
  getCsrfToken,
  markSessionExpired,
} from "../lib/session";

export type AssetThumbnail = {
  /** Digest of the asset content the thumbnail belongs to. */
  hash: string;
  /** Stored PNG, or null when the cache is cold. */
  blob: Blob | null;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Retry delays for a read whose `fetch` rejected before a response arrived.
 *
 * A laptop that wakes from sleep often still holds an idle HTTP/3 socket, so
 * the first requests die with a QUIC idle timeout even though the server is
 * reachable. A couple of cheap retries let the browser open a fresh connection
 * (or fall back to TCP) instead of suspending the workspace with "Failed to
 * fetch" until the user reloads the page.
 */
const NETWORK_RETRY_DELAYS_MS = [200, 600];

/** Reads only: a create/save retried blindly could duplicate its side effect. */
async function fetchRead(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      // An abort is deliberate: the caller no longer wants the result.
      const aborted =
        error instanceof DOMException && error.name === "AbortError";
      if (aborted || attempt >= NETWORK_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) =>
        window.setTimeout(resolve, NETWORK_RETRY_DELAYS_MS[attempt]),
      );
    }
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  await ensureSession();
  const headers = new Headers(init.headers);
  if (
    init.body !== undefined &&
    !(init.body instanceof FormData) &&
    !headers.has("content-type")
  ) {
    headers.set("content-type", "application/json");
  }
  const method = (init.method ?? "GET").toUpperCase();
  const csrf = getCsrfToken();
  if (csrf && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    headers.set("x-opalnote-csrf", csrf);
  }

  let response: Response;
  try {
    const read = method === "GET" || method === "HEAD";
    response = read
      ? await fetchRead(`/api${path}`, {
          ...init,
          headers,
          credentials: "same-origin",
        })
      : await fetch(`/api${path}`, {
          ...init,
          headers,
          credentials: "same-origin",
        });
  } catch (error) {
    throw new ApiError(
      0,
      "network_error",
      error instanceof Error ? error.message : "Network request failed",
    );
  }

  if (!response.ok) {
    let code = "http_error";
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      if (payload.error?.code) code = payload.error.code;
      if (payload.error?.message) message = payload.error.message;
    } catch {
      // Non-JSON error bodies keep the status text.
    }
    // `agent_locked` is a 401 about the *agent provider*, not this browser's
    // session: sending the user to the "session expired" screen would be wrong.
    if (response.status === 401 && code !== "agent_locked") markSessionExpired();
    throw new ApiError(response.status, code, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  // An authenticated reverse proxy (Cloudflare Access, an SSO gateway) answers
  // an expired session with its sign-in *page* and a 200, which would otherwise
  // surface as "Unexpected token '<'". Treat it like an expired session so the
  // UI asks for a reload, which sends the browser through the proxy's login.
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    markSessionExpired();
    throw new ApiError(
      401,
      "unauthorized",
      "The server returned a sign-in page instead of data.",
    );
  }
  return (await response.json()) as T;
}

/**
 * Stored diagram thumbnail, or the digest to render one from. Both answers
 * carry the digest header, so a 404 still tells the caller what to render.
 */
async function requestThumbnail(
  notebookId: string,
  path: string,
): Promise<AssetThumbnail> {
  await ensureSession();
  let response: Response;
  try {
    response = await fetchRead(
      `/api/notebooks/${encode(notebookId)}/thumbnail?path=${encode(path)}`,
      { credentials: "same-origin" },
    );
  } catch (error) {
    throw new ApiError(
      0,
      "network_error",
      error instanceof Error ? error.message : "Network request failed",
    );
  }
  const hash = response.headers.get("x-opalnote-asset-hash") ?? "";
  if (response.status === 401) markSessionExpired();
  if (response.ok) {
    return { hash, blob: await response.blob() };
  }
  if (response.status === 404 && hash) {
    return { hash, blob: null };
  }
  throw new ApiError(
    response.status,
    "thumbnail_error",
    `${response.status} ${response.statusText}`,
  );
}

async function putThumbnail(
  notebookId: string,
  path: string,
  hash: string,
  png: Blob,
): Promise<void> {
  await ensureSession();
  const headers = new Headers({ "content-type": "image/png" });
  const csrf = getCsrfToken();
  if (csrf) headers.set("x-opalnote-csrf", csrf);
  const response = await fetch(
    `/api/notebooks/${encode(notebookId)}/thumbnail?path=${encode(path)}&hash=${encode(hash)}`,
    { method: "PUT", body: png, headers, credentials: "same-origin" },
  );
  if (response.status === 401) markSessionExpired();
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = (await response.json()) as {
        error?: { message?: string };
      };
      if (payload.error?.message) message = payload.error.message;
    } catch {
      // Non-JSON error bodies keep the status text.
    }
    throw new ApiError(response.status, "thumbnail_error", message);
  }
}

async function requestBlob(
  path: string,
  options: { fresh?: boolean } = {},
): Promise<Blob> {
  await ensureSession();
  const headers = new Headers();
  let response: Response;
  try {
    response = await fetchRead(`/api${path}`, {
      headers,
      credentials: "same-origin",
      cache: options.fresh ? "no-store" : "default",
    });
  } catch (error) {
    throw new ApiError(
      0,
      "network_error",
      error instanceof Error ? error.message : "Network request failed",
    );
  }
  if (!response.ok) {
    if (response.status === 401) markSessionExpired();
    let code = "http_error";
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      if (payload.error?.code) code = payload.error.code;
      if (payload.error?.message) message = payload.error.message;
    } catch {
      // Keep the status text for non-JSON errors.
    }
    throw new ApiError(response.status, code, message);
  }
  // An authenticated reverse proxy (Cloudflare Access, an SSO gateway) answers
  // an expired session with its sign-in page and a 200; treat that like the
  // JSON path does instead of handing back a bogus blob.
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    markSessionExpired();
    throw new ApiError(401, "unauthorized", "The server returned a sign-in page instead of data.");
  }
  return response.blob();
}

const encode = encodeURIComponent;

function assetPath(notebookId: string, path: string): string {
  const encodedPath = path.split("/").map(encode).join("/");
  return `/notebooks/${encode(notebookId)}/assets/${encodedPath}`;
}

function notePath(notebookId: string, path: string): string {
  const encodedPath = path.split("/").map(encode).join("/");
  return `/notebooks/${encode(notebookId)}/notes/${encodedPath}`;
}

export const api = {
  health: () => request<Health>("/health"),
  meta: () => request<Meta>("/meta"),
  stats: () => request<Stats>("/stats"),

  reindex: () => request<Stats>("/reindex", { method: "POST" }),

  listNotebooks: () => request<Notebook[]>("/notebooks"),

  createNotebook: (body: { name: string; description?: string }) =>
    request<Notebook>("/notebooks", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  importNotebook: (file: File, name?: string) => {
    const body = new FormData();
    body.append("file", file, file.name);
    if (name?.trim()) body.append("name", name.trim());
    return request<Notebook>("/notebooks/import", {
      method: "POST",
      body,
    });
  },

  updateNotebook: (
    id: string,
    body: { name?: string; description?: string },
  ) =>
    request<Notebook>(`/notebooks/${encode(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  deleteNotebook: (id: string) =>
    request<void>(`/notebooks/${encode(id)}`, { method: "DELETE" }),

  listNotes: (notebookId: string, limit = 100, offset = 0) =>
    request<NoteSummary[]>(
      `/notebooks/${encode(notebookId)}/notes?limit=${limit}&offset=${offset}`,
    ),

  listPages: (
    notebookId: string,
    params: {
      limit?: number;
      offset?: number;
      q?: string;
      tag?: string;
      sort?: string;
      dir?: string;
    } = {},
  ) => {
    const search = new URLSearchParams();
    search.set("limit", String(params.limit ?? 20));
    search.set("offset", String(params.offset ?? 0));
    if (params.q) search.set("q", params.q);
    if (params.tag) search.set("tag", params.tag);
    if (params.sort) search.set("sort", params.sort);
    if (params.dir) search.set("dir", params.dir);
    return request<PageList>(
      `/notebooks/${encode(notebookId)}/pages?${search.toString()}`,
    );
  },

  listOrphans: (notebookId: string) =>
    request<PageOverview[]>(`/notebooks/${encode(notebookId)}/orphans`),

  listTasks: (
    notebookId: string,
    params: {
      limit?: number;
      offset?: number;
      status?: string;
      q?: string;
      sort?: string;
      dir?: string;
    } = {},
  ) => {
    const search = new URLSearchParams();
    search.set("limit", String(params.limit ?? 20));
    search.set("offset", String(params.offset ?? 0));
    if (params.status) search.set("status", params.status);
    if (params.q) search.set("q", params.q);
    if (params.sort) search.set("sort", params.sort);
    if (params.dir) search.set("dir", params.dir);
    return request<TaskList>(
      `/notebooks/${encode(notebookId)}/tasks?${search.toString()}`,
    );
  },

  graph: (notebookId: string, includeTags = false) =>
    request<GraphData>(
      `/notebooks/${encode(notebookId)}/graph?include_tags=${includeTags ? "true" : "false"}`,
    ),

  listAssets: (
    notebookId: string,
    params: {
      limit?: number;
      offset?: number;
      q?: string;
      kind?: string;
      sort?: string;
      dir?: string;
    } = {},
  ) => {
    const search = new URLSearchParams();
    search.set("limit", String(params.limit ?? 24));
    search.set("offset", String(params.offset ?? 0));
    if (params.q) search.set("q", params.q);
    if (params.kind) search.set("kind", params.kind);
    if (params.sort) search.set("sort", params.sort);
    if (params.dir) search.set("dir", params.dir);
    return request<AssetList>(
      `/notebooks/${encode(notebookId)}/assets?${search.toString()}`,
    );
  },

  assetInfo: (notebookId: string, path: string) =>
    request<AssetInfo>(
      `/notebooks/${encode(notebookId)}/asset?path=${encode(path)}`,
    ),

  getAssetBlob: (notebookId: string, path: string, fresh = false) =>
    requestBlob(assetPath(notebookId, path), { fresh }),

  /** Whether the server-side agent provider is configured, and its models. */
  agentInfo: () => request<AgentInfo>("/agent"),

  /** Derived blocks of one note, in document order. */
  noteBlocks: (notebookId: string, path: string) =>
    request<BlockOverview[]>(
      `/notebooks/${encode(notebookId)}/blocks?path=${encode(path)}`,
    ),

  /** Resolve a block deep link (hash, plus the position it was copied from). */
  resolveBlock: (notebookId: string, path: string, hash: string, seq: number) =>
    request<BlockTarget>(
      `/notebooks/${encode(notebookId)}/block?path=${encode(path)}&hash=${encode(hash)}&seq=${seq}`,
    ),

  /** Blocks across the notebook whose text contains `query`. */
  searchBlocks: (notebookId: string, query: string, limit = 20) =>
    request<BlockHit[]>(
      `/notebooks/${encode(notebookId)}/block-search?q=${encode(query)}&limit=${limit}`,
    ),

  /** Store the provider connection (envelope encrypted in the browser). */
  saveAgentConfig: (body: {
    base_url: string;
    models: string[];
    key_envelope: string | null;
  }) =>
    request<AgentInfo>("/agent/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  /** Forget the stored provider connection. */
  deleteAgentConfig: () =>
    request<AgentInfo>("/agent/config", { method: "DELETE" }),

  /**
   * Model ids the configured upstream advertises (`/models` on the proxy).
   *
   * The proxy needs the password-derived key for an encrypted provider, so
   * callers pass it; a keyless local endpoint works without one.
   */
  agentModels: async (agentKey?: string): Promise<string[]> => {
    const payload = await request<{ data?: Array<{ id?: string }> }>(
      "/agent/v1/models",
      agentKey ? { headers: { "x-opalnote-agent-key": agentKey } } : {},
    );
    return (payload.data ?? [])
      .map((entry) => entry.id?.trim() ?? "")
      .filter((id) => id.length > 0);
  },

  /** Rendered diagram thumbnail: stored PNG, or the digest to render from. */
  getAssetThumbnail: (notebookId: string, path: string) =>
    requestThumbnail(notebookId, path),

  putAssetThumbnail: (
    notebookId: string,
    path: string,
    hash: string,
    png: Blob,
  ) => putThumbnail(notebookId, path, hash, png),

  /** Create a text asset (Mermaid source, Excalidraw scene). */
  createAssetContent: (
    notebookId: string,
    body: {
      name: string;
      extension: string;
      content: string;
      folder?: string;
    },
  ) =>
    request<AssetEntry>(`/notebooks/${encode(notebookId)}/assets/content`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Overwrite an existing text asset, optionally guarded by `updated_at`. */
  updateAssetContent: (
    notebookId: string,
    path: string,
    body: { content: string; base_updated_at?: string },
  ) =>
    request<AssetEntry>(assetPath(notebookId, path), {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  /** Upload one file into the notebook's `assets/` folder. */
  uploadAsset: (notebookId: string, file: File) => {
    const body = new FormData();
    body.append("file", file, file.name);
    return request<AssetEntry>(`/notebooks/${encode(notebookId)}/assets`, {
      method: "POST",
      body,
    });
  },

  renameAsset: (notebookId: string, path: string, name: string) =>
    request<AssetEntry>(`/notebooks/${encode(notebookId)}/asset`, {
      method: "PATCH",
      body: JSON.stringify({ path, name }),
    }),

  journalPlugins: (notebookId: string) =>
    request<JournalPluginResult[]>(
      `/notebooks/${encode(notebookId)}/plugins`,
    ),

  listPlugins: () => request<PluginList>("/plugins"),

  reloadPlugins: () =>
    request<PluginList>("/plugins/reload", { method: "POST" }),

  listBackgrounds: () => request<BackgroundList>("/backgrounds"),

  reloadBackgrounds: () =>
    request<BackgroundList>("/backgrounds/reload", { method: "POST" }),

  getBackgroundBlob: (id: string, path: string) =>
    requestBlob(
      `/backgrounds/asset?id=${encode(id)}&path=${encode(path)}`,
    ),

  searchNotes: (notebookId: string, query: string, limit = 50) =>
    request<NoteSummary[]>(
      `/notebooks/${encode(notebookId)}/search?q=${encode(query)}&limit=${limit}`,
    ),

  listTags: (notebookId: string) =>
    request<TagCount[]>(`/notebooks/${encode(notebookId)}/tags`),

  listJournals: (notebookId: string, before?: string, limit = 7) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set("before", before);
    return request<JournalPage[]>(
      `/notebooks/${encode(notebookId)}/journals?${params.toString()}`,
    );
  },

  createNote: (
    notebookId: string,
    body: {
      title: string;
      content?: string;
      tags?: string[];
      section?: "pages" | "journals";
    },
  ) =>
    request<Note>(`/notebooks/${encode(notebookId)}/notes`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getNote: (notebookId: string, path: string) =>
    request<Note>(notePath(notebookId, path)),

  updateNote: (
    notebookId: string,
    path: string,
    body: { title?: string; content?: string; tags?: string[] },
  ) =>
    request<Note>(notePath(notebookId, path), {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  deleteNote: (notebookId: string, path: string) =>
    request<void>(notePath(notebookId, path), { method: "DELETE" }),

  deleteAsset: (notebookId: string, path: string) =>
    request<void>(assetPath(notebookId, path), { method: "DELETE" }),

  listTrash: (
    params: {
      limit?: number;
      offset?: number;
      q?: string;
      kind?: string;
      sort?: string;
      dir?: string;
    } = {},
  ) => {
    const search = new URLSearchParams();
    search.set("limit", String(params.limit ?? 20));
    search.set("offset", String(params.offset ?? 0));
    if (params.q) search.set("q", params.q);
    if (params.kind) search.set("kind", params.kind);
    if (params.sort) search.set("sort", params.sort);
    if (params.dir) search.set("dir", params.dir);
    return request<TrashList>(`/trash?${search.toString()}`);
  },

  getTrash: (id: string) =>
    request<TrashDetail>(`/trash/${encode(id)}`),

  getTrashBlob: (id: string) =>
    requestBlob(`/trash/${encode(id)}/content`),

  restoreTrash: (id: string) =>
    request<TrashRestoreResult>(`/trash/${encode(id)}/restore`, {
      method: "POST",
    }),

  deleteTrash: (id: string) =>
    request<void>(`/trash/${encode(id)}`, { method: "DELETE" }),

  getSettings: () => request<Record<string, unknown>>("/settings"),

  saveSettings: (settings: Record<string, unknown>) =>
    request<Record<string, unknown>>("/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),

  query: (script: string, params: Record<string, unknown> = {}) =>
    request<QueryResult>("/query", {
      method: "POST",
      body: JSON.stringify({ script, params }),
    }),
};
