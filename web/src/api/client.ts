import type {
  GraphData,
  Health,
  JournalPage,
  JournalPluginResult,
  Note,
  NoteSummary,
  Notebook,
  PageList,
  PageOverview,
  QueryResult,
  Stats,
  TagCount,
} from "./types";

const TOKEN_KEY = "opalnote.token";

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

export function getStoredToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeToken(token: string): void {
  try {
    if (token) {
      window.localStorage.setItem(TOKEN_KEY, token);
    } else {
      window.localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // Private-mode storage failures are non-fatal; the in-memory atom still works.
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const token = getStoredToken();
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...init, headers });
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
    throw new ApiError(response.status, code, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

const encode = encodeURIComponent;

function notePath(notebookId: string, path: string): string {
  const encodedPath = path.split("/").map(encode).join("/");
  return `/notebooks/${encode(notebookId)}/notes/${encodedPath}`;
}

export const api = {
  health: () => request<Health>("/health"),
  stats: () => request<Stats>("/stats"),

  reindex: () => request<Stats>("/reindex", { method: "POST" }),

  listNotebooks: () => request<Notebook[]>("/notebooks"),

  createNotebook: (body: { name: string; description?: string }) =>
    request<Notebook>("/notebooks", {
      method: "POST",
      body: JSON.stringify(body),
    }),

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

  graph: (notebookId: string) =>
    request<GraphData>(`/notebooks/${encode(notebookId)}/graph`),

  journalPlugins: (notebookId: string) =>
    request<JournalPluginResult[]>(
      `/notebooks/${encode(notebookId)}/plugins`,
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

  query: (script: string, params: Record<string, unknown> = {}) =>
    request<QueryResult>("/query", {
      method: "POST",
      body: JSON.stringify({ script, params }),
    }),
};
