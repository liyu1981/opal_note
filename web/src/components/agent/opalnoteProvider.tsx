import { useCallback, useState } from "react";
import { atom, getDefaultStore } from "jotai";
import {
  rebuildModels,
  setHostProviderConfig,
  type ReAgentCallContext,
  type ReAgentCallDecision,
  type ReAgentHostProviderConfig,
} from "@liyu1981/reagent";

import { api } from "../../api/client";
import type { AgentInfo } from "../../api/types";
import {
  canDecrypt,
  deriveUnlockKey,
  envelopeFingerprint,
  parseEnvelope,
  type KeyEnvelope,
} from "../../lib/agentCrypto";
import { getCsrfToken } from "../../lib/session";
import {
  agentUnlockAtom,
  customUnlockMinutes,
  expireUnlockIfNeeded,
  lockAgentProvider,
  requestAgentUnlock,
  restoreUnlock,
  saveUnlockPreferences,
  storeUnlock,
  unlockScope,
  type UnlockScope,
} from "../../state/agentUnlock";

/**
 * The OpalNote agent provider.
 *
 * OpalNote relays the model traffic itself: ReAgent calls `/api/agent/v1`, the
 * Rust server attaches the upstream credential and streams the answer back. The
 * credential is stored encrypted — the browser builds the envelope from a
 * password the server never sees — and each request carries the password-derived
 * key, so a copy of `opalnote.db` is useless on its own. See ADR 0001 and
 * `doc/architecture.md#agent-provider`.
 */
export const OPALNOTE_PROVIDER_ID = "opalnote";
export const OPALNOTE_PROVIDER_NAME = "OpalNote";
const STORAGE_PREFIX = "opalnote";

const store = getDefaultStore();

/** Latest `GET /api/agent` answer, shared with the configuration card. */
export const agentInfoAtom = atom<AgentInfo | null>(null);

/** Called by the request hook when the server rejects the derived key. */
let onLocked: (() => void) | null = null;

export function setAgentLockedHandler(handler: (() => void) | null): void {
  onLocked = handler;
}

export function proxyBaseUrl(): string {
  return new URL("/api/agent/v1", window.location.origin).href;
}

/** Envelope of the stored configuration, or null for a keyless endpoint. */
export function storedEnvelope(info: AgentInfo | null): KeyEnvelope | null {
  const raw: string | null = info?.stored?.key_envelope ?? null;
  if (!raw) return null;
  try {
    return parseEnvelope(JSON.parse(raw));
  } catch {
    return null;
  }
}

function lockedResponse(message: string): Response {
  return new Response(JSON.stringify({ error: { code: "agent_locked", message } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/**
 * True when a 401 is *our* lock (`error.code === "agent_locked"`).
 *
 * The proxy relays upstream statuses verbatim, so an upstream 401 — a wrong or
 * expired API key, no credit, a model the account cannot use — looks the same
 * over the wire. Treating that as a lock would throw away a perfectly good
 * derived key and ask for the encryption password again, which the next attempt
 * would then block on: an unbreakable loop. Only our own payload unlocks the
 * prompt; everything else is surfaced to the agent as the provider's error.
 */
async function isAgentLocked(response: Response): Promise<boolean> {
  try {
    const payload = (await response.clone().json()) as {
      error?: { code?: string };
    };
    return payload?.error?.code === "agent_locked";
  } catch {
    return false;
  }
}

/**
 * Request hook for every provider call (chat and `/models`): attach the derived
 * key and fail fast with a typed error while locked, so the UI can ask for the
 * password instead of issuing a doomed request.
 */
function buildFetch(): typeof fetch {
  return async (input, init) => {
    expireUnlockIfNeeded();
    const key = store.get(agentUnlockAtom).key;
    if (!key) {
      onLocked?.();
      return lockedResponse("The OpalNote provider is locked.");
    }
    const headers = new Headers(init?.headers);
    headers.set("x-opalnote-agent-key", key);
    const csrf = getCsrfToken();
    if (csrf) headers.set("x-opalnote-csrf", csrf);
    const response = await fetch(input, {
      ...init,
      headers,
      credentials: "same-origin",
    });
    if (response.status === 401 && (await isAgentLocked(response))) {
      // The stored envelope no longer matches this key (re-saved or removed
      // elsewhere): forget it, re-read the configuration so the prompt asks for
      // the password of the *current* envelope, and let the UI ask again.
      lockAgentProvider();
      onLocked?.();
      void refreshProvider().catch(() => undefined);
    }
    return response;
  };
}

export function providerConfig(models: string[]): ReAgentHostProviderConfig {
  return {
    baseUrl: proxyBaseUrl(),
    // Never sent: `fetch` attaches the derived key, and the proxy owns the
    // upstream credential.
    apiKey: "opalnote-session",
    api: "openai-completions",
    models,
    authHeaders: () => ({}),
    fetch: buildFetch(),
  };
}

/** Connect the provider to ReAgent's model registry. */
export function connectProvider(models: string[]): void {
  setHostProviderConfig(OPALNOTE_PROVIDER_ID, providerConfig(models));
  rebuildModels(STORAGE_PREFIX);
}

/** Remove the provider from the model picker. */
export function disconnectProvider(): void {
  setHostProviderConfig(OPALNOTE_PROVIDER_ID, null);
  rebuildModels(STORAGE_PREFIX);
}

/**
 * Make the registry match the server configuration and the unlock state:
 * configured + keyless → connected; configured + unlocked → connected;
 * configured + locked → disconnected and an unlock prompt.
 */
export async function syncProvider(info: AgentInfo | null): Promise<void> {
  store.set(agentInfoAtom, info);
  if (!info?.stored) {
    disconnectProvider();
    return;
  }
  const envelope = storedEnvelope(info);
  if (!envelope) {
    connectProvider(info.stored.models);
    return;
  }
  const fingerprint = await envelopeFingerprint(envelope);
  const state = store.get(agentUnlockAtom);
  if (!state.key) restoreUnlock(fingerprint);
  // Keep the provider listed even while locked: the models stay visible, and a
  // request that needs the key fails with `agent_locked`, which opens the
  // password prompt. Locking must not silently remove the provider.
  connectProvider(info.stored.models);
}

/** Ask the proxy for the upstream model ids with this browser's derived key. */
async function listProxyModels(key: string | null): Promise<string[]> {
  try {
    return await api.agentModels(key ?? undefined);
  } catch {
    return [];
  }
}

function sameModels(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

/**
 * A stored provider needs the upstream model list for ReAgent's picker, and the
 * browser is the only side that can fetch it: the proxy needs the derived key.
 *
 * Repairs a row saved without models (older saves, or an endpoint that answered
 * before the provider existed), and — with `force` — refreshes the list after
 * the endpoint changes so stale ids cannot be sent upstream.
 */
export async function refreshProviderModels(
  info: AgentInfo,
  force: boolean,
  keyOverride?: string | null,
): Promise<AgentInfo> {
  const stored = info.stored;
  if (!stored) return info;
  if (!force && stored.models.length > 0) return info;
  // Setup passes the key it derived from the password just typed; every other
  // caller uses the tab's current unlock key.
  const key =
    keyOverride === undefined ? store.get(agentUnlockAtom).key : keyOverride;
  // A locked provider cannot be asked: the key is what unlocks the upstream.
  if (storedEnvelope(info) && !key) return info;
  const models = await listProxyModels(key);
  if (models.length === 0 || sameModels(models, stored.models)) return info;
  try {
    return await api.saveAgentConfig({
      base_url: stored.base_url,
      models,
      key_envelope: stored.key_envelope ?? null,
    });
  } catch {
    return info;
  }
}

/** Fetch `GET /api/agent`, repair a missing model list, and sync the provider. */
export async function refreshProvider(): Promise<AgentInfo | null> {
  const info = await api.agentInfo();
  const repaired = await refreshProviderModels(info, false);
  await syncProvider(repaired);
  return repaired;
}

/** Unlock with a password and remember the key for the selected window. */
export function useUnlockProvider(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<UnlockScope>(() => unlockScope());
  const [customMinutes, setCustomMinutes] = useState(() => customUnlockMinutes());

  const unlock = useCallback(
    async (password: string, envelope: KeyEnvelope | null) => {
      if (!envelope) {
        setError("The provider is not configured.");
        return;
      }
      setError(null);
      setBusy(true);
      try {
        const key = await deriveUnlockKey(password, envelope);
        // Cheap local check for immediate feedback; the server stays the
        // authority (it is the only place that decrypts for a request).
        if (!(await canDecrypt(key, envelope))) {
          setError("Incorrect password.");
          return;
        }
        const fingerprint = await envelopeFingerprint(envelope);
        saveUnlockPreferences(scope, customMinutes);
        storeUnlock(key, fingerprint, scope);
        onDone();
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not derive the key from that password",
        );
      } finally {
        setBusy(false);
      }
    },
    [customMinutes, onDone, scope],
  );

  return {
    unlock,
    busy,
    error,
    setError,
    scope,
    setScope,
    customMinutes,
    setCustomMinutes,
  };
}

/** Ask the UI for the password (used when a request finds the provider locked). */
export function requestUnlockPrompt(): void {
  requestAgentUnlock();
}

/** How long a blocked call waits for the password before giving up. */
const UNLOCK_WAIT_MS = 5 * 60_000;

/**
 * Wait for the unlock dialog to answer: `true` once a derived key exists,
 * `false` when the prompt is dismissed (or the wait times out).
 */
function waitForUnlock(timeoutMs = UNLOCK_WAIT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (unlocked: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
      resolve(unlocked);
    };
    const unsubscribe = store.sub(agentUnlockAtom, () => {
      const state = store.get(agentUnlockAtom);
      if (state.key) finish(true);
      else if (!state.prompt) finish(false);
    });
    timer = setTimeout(() => finish(false), timeoutMs);
    if (store.get(agentUnlockAtom).key) finish(true);
  });
}

/**
 * Decide one agent call.
 *
 * Only the OpalNote provider is gated — ReAgent's own providers never need our
 * password. A keyless endpoint and an unlocked provider pass; a stored key with
 * no live derived key opens the password dialog and **awaits it**, so one Send
 * both unlocks and sends. Cancelling (or a five-minute wait) lets ReAgent report
 * that the message was not sent, with the text still in the composer.
 *
 * Pure on purpose: the React hook below is a thin wrapper, and the rule can be
 * exercised without a DOM.
 */
export async function opalnoteCallDecision(
  context: ReAgentCallContext,
): Promise<ReAgentCallDecision> {
  if (context.model?.providerId !== OPALNOTE_PROVIDER_ID) return true;
  expireUnlockIfNeeded();
  const info = store.get(agentInfoAtom);
  if (!storedEnvelope(info)) return true; // keyless local endpoint
  if (store.get(agentUnlockAtom).key) return true;
  // Keep the message in the composer and wait for the password: unlocking and
  // sending is one action for the user, not two.
  requestAgentUnlock();
  if (await waitForUnlock()) return true;
  return {
    ok: false,
    message:
      "The OpalNote provider stays locked — unlock it to send this message.",
  };
}

/** Drop the derived key; the provider stays listed but locked. */
export function lockProvider(): void {
  lockAgentProvider();
}
