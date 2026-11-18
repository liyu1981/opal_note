import { atom, getDefaultStore } from "jotai";

/**
 * Unlock state for the OpalNote agent provider.
 *
 * The derived key lives in memory (or in `sessionStorage`/`localStorage` for the
 * longer windows) and is sent with each proxied request. The window is a
 * client-side courtesy — how long this tab keeps the key around — not a server
 * session: the server holds no unlock state and decrypts per request.
 */

export type UnlockScope = "15m" | "custom" | "24h" | "until-change";

export const UNLOCK_SCOPES: Array<{
  id: UnlockScope;
  label: string;
  detail: string;
}> = [
  {
    id: "15m",
    label: "15 minutes",
    detail: "Ask for the password again after 15 minutes or a reload.",
  },
  {
    id: "custom",
    label: "Custom",
    detail: "Choose how long this tab keeps the key.",
  },
  {
    id: "24h",
    label: "24 hours",
    detail: "Survives reloads in this browser session, expires after a day.",
  },
  {
    id: "until-change",
    label: "Until the key changes",
    detail: "Kept on this device until the provider is re-saved or removed.",
  },
];

const MINUTE = 60_000;
export const CUSTOM_MINUTES_MIN = 1;
export const CUSTOM_MINUTES_MAX = 24 * 60;

const STORAGE_KEY = "opalnote.agent.unlock";
const SCOPE_KEY = "opalnote.agent.unlock-scope";
const CUSTOM_KEY = "opalnote.agent.unlock-minutes";

type StoredUnlock = {
  key: string;
  fingerprint: string;
  expiresAt: number | null;
};

export type UnlockState = {
  /** Derived key for the current envelope, or null when locked. */
  key: string | null;
  /** Envelope fingerprint the key belongs to. */
  fingerprint: string | null;
  /** Epoch ms when the key expires; null means "until the envelope changes". */
  expiresAt: number | null;
  /** True while an unlock dialog should be visible. */
  prompt: boolean;
};

const initial: UnlockState = {
  key: null,
  fingerprint: null,
  expiresAt: null,
  prompt: false,
};

export const agentUnlockAtom = atom<UnlockState>(initial);

/** Bumped when the key must be dropped (any tab, any path). */
export const lockAgentProvider = (): void => {
  clearStored();
  getDefaultStore().set(agentUnlockAtom, initial);
};

/** Ask the UI to collect a password. */
export const requestAgentUnlock = (): void => {
  getDefaultStore().set(agentUnlockAtom, (state) => ({
    ...state,
    prompt: true,
  }));
};

export const dismissAgentUnlock = (): void => {
  getDefaultStore().set(agentUnlockAtom, (state) => ({
    ...state,
    prompt: false,
  }));
};

export function unlockScope(): UnlockScope {
  const stored = localStorage.getItem(SCOPE_KEY);
  if (stored === "24h" || stored === "custom" || stored === "until-change") {
    return stored;
  }
  return "15m";
}

export function customUnlockMinutes(): number {
  const raw = Number(localStorage.getItem(CUSTOM_KEY) ?? "");
  const fallback = 60;
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(
    CUSTOM_MINUTES_MAX,
    Math.max(CUSTOM_MINUTES_MIN, Math.round(raw)),
  );
}

export function saveUnlockPreferences(
  scope: UnlockScope,
  customMinutes: number,
): void {
  localStorage.setItem(SCOPE_KEY, scope);
  if (scope === "custom") {
    localStorage.setItem(
      CUSTOM_KEY,
      String(
        Math.min(
          CUSTOM_MINUTES_MAX,
          Math.max(CUSTOM_MINUTES_MIN, Math.round(customMinutes)),
        ),
      ),
    );
  }
}

/** TTL in ms for a scope; null means "no expiry, until the key changes". */
function scopeTtl(scope: UnlockScope): number | null {
  switch (scope) {
    case "15m":
      return 15 * MINUTE;
    case "custom":
      return customUnlockMinutes() * MINUTE;
    case "24h":
      return 24 * 60 * MINUTE;
    case "until-change":
      return null;
  }
}

/** Where a scope persists the key across reloads. */
function scopeStorage(scope: UnlockScope): Storage | null {
  if (scope === "24h") return sessionStorage;
  if (scope === "until-change") return localStorage;
  return null;
}

function clearStored(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode); memory-only is fine.
  }
}

/** Persist the derived key for the selected window. */
export function storeUnlock(
  key: string,
  fingerprint: string,
  scope: UnlockScope,
): UnlockState {
  const ttl = scopeTtl(scope);
  const expiresAt = ttl === null ? null : Date.now() + ttl;
  const state: UnlockState = { key, fingerprint, expiresAt, prompt: false };
  getDefaultStore().set(agentUnlockAtom, state);

  clearStored();
  const storage = scopeStorage(scope);
  if (storage) {
    try {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({ key, fingerprint, expiresAt } satisfies StoredUnlock),
      );
    } catch {
      // Quota or private mode: the key simply does not survive a reload.
    }
  }
  return state;
}

/**
 * Restore a persisted key for the envelope currently on the server. A different
 * fingerprint (the provider was re-saved elsewhere) leaves the tab locked.
 */
export function restoreUnlock(fingerprint: string): UnlockState {
  const now = Date.now();
  for (const storage of [sessionStorage, localStorage]) {
    let stored: StoredUnlock | null = null;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) continue;
      stored = JSON.parse(raw) as StoredUnlock;
    } catch {
      continue;
    }
    if (!stored || stored.fingerprint !== fingerprint) continue;
    if (stored.expiresAt !== null && stored.expiresAt <= now) {
      storage.removeItem(STORAGE_KEY);
      continue;
    }
    const state: UnlockState = {
      key: stored.key,
      fingerprint: stored.fingerprint,
      expiresAt: stored.expiresAt,
      prompt: false,
    };
    getDefaultStore().set(agentUnlockAtom, state);
    return state;
  }
  return initial;
}

/** Drop the key once its window has elapsed. */
export function expireUnlockIfNeeded(): boolean {
  const state = getDefaultStore().get(agentUnlockAtom);
  if (!state.key || state.expiresAt === null) return false;
  if (state.expiresAt > Date.now()) return false;
  lockAgentProvider();
  return true;
}
