import type {
  Health,
  Note,
  NoteSummary,
  Notebook,
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

export const api = {
  health: () => request<Health>("/health"),
  stats: () => request<Stats>("/stats"),

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

  searchNotes: (notebookId: string, query: string, limit = 50) =>
    request<NoteSummary[]>(
      `/notebooks/${encode(notebookId)}/search?q=${encode(query)}&limit=${limit}`,
    ),

  listTags: (notebookId: string) =>
    request<TagCount[]>(`/notebooks/${encode(notebookId)}/tags`),

  createNote: (
    notebookId: string,
    body: { title: string; content?: string; tags?: string[] },
  ) =>
    request<Note>(`/notebooks/${encode(notebookId)}/notes`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getNote: (id: string) => request<Note>(`/notes/${encode(id)}`),

  updateNote: (
    id: string,
    body: { title?: string; content?: string; tags?: string[] },
  ) =>
    request<Note>(`/notes/${encode(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  deleteNote: (id: string) =>
    request<void>(`/notes/${encode(id)}`, { method: "DELETE" }),

  query: (script: string, params: Record<string, unknown> = {}) =>
    request<QueryResult>("/query", {
      method: "POST",
      body: JSON.stringify({ script, params }),
    }),
};
