import type {
  AssetEntry,
  AssetInfo,
  AssetList,
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
    response = await fetch(`/api${path}`, {
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
      // Non-JSON error bodies keep the status text.
    }
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

async function requestBlob(path: string): Promise<Blob> {
  await ensureSession();
  const headers = new Headers();
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
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

  getAssetBlob: (notebookId: string, path: string) =>
    requestBlob(assetPath(notebookId, path)),

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
