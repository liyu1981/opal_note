const LEGACY_TOKEN_KEY = "opalnote.token";
const SESSION_ENDPOINT = "/api/session";

type SessionResponse = {
  authenticated?: boolean;
  csrf_token?: string;
};

let csrfToken: string | null = null;
let bootstrap: Promise<boolean> | null = null;

function readLegacyToken(): string {
  try {
    return window.localStorage.getItem(LEGACY_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function clearLegacyToken(): void {
  try {
    window.localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    // Storage failures are harmless; the session still lives in the cookie.
  }
}

async function postSession(token?: string): Promise<boolean> {
  try {
    const response = await fetch(SESSION_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(token?.trim() ? { token: token.trim() } : {}),
    });
    if (!response.ok) {
      csrfToken = null;
      return false;
    }
    const data = (await response.json()) as SessionResponse;
    if (!data.csrf_token) {
      csrfToken = null;
      return false;
    }
    csrfToken = data.csrf_token;
    clearLegacyToken();
    return true;
  } catch {
    csrfToken = null;
    return false;
  }
}

/** Create a session once per page load, migrating a legacy localStorage token. */
export function ensureSession(): Promise<boolean> {
  if (csrfToken) return Promise.resolve(true);
  if (!bootstrap) {
    bootstrap = postSession(readLegacyToken());
  }
  return bootstrap;
}

/** Exchange a server token for a new HttpOnly session cookie. */
export async function startSession(token?: string): Promise<boolean> {
  resetSession();
  const ok = await postSession(token);
  bootstrap = Promise.resolve(ok);
  return ok;
}

export async function endSession(): Promise<void> {
  try {
    await fetch(SESSION_ENDPOINT, {
      method: "DELETE",
      credentials: "same-origin",
    });
  } catch {
    // Clearing local state below is still useful offline.
  }
  resetSession();
  clearLegacyToken();
}

export function resetSession(): void {
  csrfToken = null;
  bootstrap = null;
}

export function hasSession(): boolean {
  return csrfToken !== null;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}
