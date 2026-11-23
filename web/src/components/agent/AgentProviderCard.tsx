import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import type {
  ReAgentCallContext,
  ReAgentCallGate,
  ReAgentHostProvider,
} from "@liyu1981/reagent";

import { api } from "../../api/client";
import {
  CryptoUnavailableError,
  canDecrypt,
  deriveUnlockKey,
  sealApiKey,
  type KeyEnvelope,
} from "../../lib/agentCrypto";
import {
  CUSTOM_MINUTES_MAX,
  CUSTOM_MINUTES_MIN,
  UNLOCK_SCOPES,
  agentUnlockAtom,
  dismissAgentUnlock,
  expireUnlockIfNeeded,
} from "../../state/agentUnlock";
import { EndpointPicker } from "./EndpointPicker";
import {
  OPALNOTE_PROVIDER_ID,
  OPALNOTE_PROVIDER_NAME,
  agentInfoAtom,
  disconnectProvider,
  lockProvider,
  opalnoteCallDecision,
  refreshProvider,
  refreshProviderModels,
  requestUnlockPrompt,
  setAgentLockedHandler,
  storedEnvelope,
  syncProvider,
  useUnlockProvider,
} from "./opalnoteProvider";

const field =
  "h-8 min-w-0 rounded-md border border-border/60 bg-background px-2 font-mono text-xs outline-none focus:border-foreground/40";
const button =
  "h-8 rounded-md border border-border/60 px-2.5 text-xs transition hover:bg-muted disabled:opacity-40";

/**
 * Settings → Agent → Model card: **setup only**.
 *
 * The base URL is stored in clear and the API key encrypted in the browser with
 * the password typed here; the password never leaves the tab. Unlocking is not
 * part of this card — the password is asked when a message is sent
 * (`useOpalNoteCallGate` → `AgentUnlockDialog`), so nothing here needs to know
 * the current unlock window.
 */
function AgentProviderCard() {
  const info = useAtomValue(agentInfoAtom);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** True while the user is overwriting an existing configuration. */
  const [replacing, setReplacing] = useState(false);

  const stored = info?.stored ?? null;
  const envelope = storedEnvelope(info);
  const unsupported = typeof crypto === "undefined" || !crypto.subtle;
  const setupOpen = stored === null || replacing;

  const resetForm = useCallback(() => {
    setApiKey("");
    setPassword("");
    setConfirm("");
    setError(null);
  }, []);

  useEffect(() => {
    if (stored?.base_url) setBaseUrl(stored.base_url);
  }, [stored?.base_url]);

  const save = useCallback(async () => {
    setError(null);
    setMessage(null);
    const endpoint = baseUrl.trim();
    if (!endpoint) {
      setError("Enter the base URL of an OpenAI-compatible endpoint.");
      return;
    }
    const endpointChanged = (stored?.base_url ?? "").trim() !== endpoint;
    const key = apiKey.trim();

    let nextEnvelope: KeyEnvelope | null = envelope;
    let derivedKey: string | null = null;
    if (key) {
      if (!password) {
        setError("Enter an encryption password for the API key.");
        return;
      }
      if (password !== confirm) {
        setError("The two passwords do not match.");
        return;
      }
    } else if (password) {
      if (!envelope) {
        setError("There is no stored key to unlock — leave the password empty.");
        return;
      }
    } else if (endpointChanged && envelope) {
      // Listing the new endpoint's models needs the derived key, and only the
      // password can produce it.
      setError("Enter the encryption password to change the endpoint.");
      return;
    }

    setBusy(true);
    try {
      if (key) {
        const sealed = await sealApiKey(password, key);
        nextEnvelope = sealed.envelope;
        derivedKey = sealed.derivedKey;
      } else if (password && envelope) {
        const candidate = await deriveUnlockKey(password, envelope);
        if (!(await canDecrypt(candidate, envelope))) {
          setError("Incorrect password.");
          return;
        }
        derivedKey = candidate;
      }
      if (nextEnvelope && derivedKey) {
        const ok = await canDecrypt(derivedKey, nextEnvelope);
        if (!ok) {
          setError("The key could not be encrypted; try again.");
          return;
        }
      }

      // Store the connection first: the model listing goes through the proxy,
      // which only exists once a provider is saved.
      const connected = await api.saveAgentConfig({
        base_url: endpoint,
        models: info?.models ?? [],
        key_envelope: nextEnvelope ? JSON.stringify(nextEnvelope) : null,
      });
      if (JSON.stringify(nextEnvelope) !== JSON.stringify(envelope)) {
        // A new envelope invalidates any key this tab still holds; the unlock
        // dialog asks for the new password when the next message is sent.
        lockProvider();
      }
      // The upstream list is the authority for the picker; fetch it now that the
      // provider exists, and refresh it whenever the endpoint changed.
      const saved = await refreshProviderModels(
        connected,
        endpointChanged || connected.models.length === 0,
        derivedKey,
      );
      await syncProvider(saved);

      resetForm();
      setReplacing(false);
      const count = saved.models.length;
      setMessage(
        count > 0
          ? `Configuration saved — ${count} model${count === 1 ? "" : "s"} available. You will be asked for the password when you send a message.`
          : "Configuration saved. The endpoint listed no models, so chat stays disabled until it does.",
      );
    } catch (cause) {
      setError(
        cause instanceof CryptoUnavailableError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : "Could not save the provider",
      );
    } finally {
      setBusy(false);
    }
  }, [
    apiKey,
    baseUrl,
    confirm,
    envelope,
    info,
    password,
    resetForm,
    stored?.base_url,
  ]);

  const remove = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const info = await api.deleteAgentConfig();
      lockProvider();
      await syncProvider(info);
      setMessage("OpalNote provider removed.");
      setReplacing(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not remove the provider",
      );
    } finally {
      setBusy(false);
      setConfirmRemove(false);
    }
  }, []);

  if (!setupOpen) {
    const count = info?.models.length ?? 0;
    return (
      <div className="space-y-2 rounded-xl border border-border/50 p-3">
        <p className="text-xs text-muted-foreground">
          A configuration is in place for{" "}
          <span className="break-all font-mono text-foreground">
            {stored.base_url}
          </span>
          {stored.key_stored
            ? " · API key stored encrypted"
            : " · no API key (keyless endpoint)"}
          {` · ${count} model${count === 1 ? "" : "s"}`}
        </p>
        <p className="text-[11px] text-muted-foreground">
          The encryption password is asked when you send a message, not here.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => {
              setMessage(null);
              setError(null);
              resetForm();
              setReplacing(true);
            }}
          >
            Set up a new configuration
          </button>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => void refreshProvider().catch(() => undefined)}
          >
            Recheck
          </button>
          {confirmRemove ? (
            <button
              type="button"
              className={`${button} border-destructive/40 text-destructive`}
              disabled={busy}
              onClick={() => void remove()}
            >
              Confirm remove
            </button>
          ) : (
            <button
              type="button"
              className={`${button} text-destructive`}
              onClick={() => setConfirmRemove(true)}
            >
              Remove
            </button>
          )}
        </div>
        {message && <p className="text-xs text-muted-foreground">{message}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-xl border border-border/50 p-3">
      <p className="text-xs text-muted-foreground">
        {stored
          ? "Replacing the configuration overwrites the stored endpoint and key."
          : "Not configured."}
      </p>

      <div className="grid gap-1.5">
        {/* The picker fills the well-known OpenAI-compatible base URLs; the
            field stays free-form for self-hosted servers. */}
        <div className="flex gap-1.5">
          <input
            className={`${field} flex-1`}
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setError(null);
            }}
            placeholder="https://openrouter.ai/api/v1"
            spellCheck={false}
            aria-label="Agent base URL"
          />
          <EndpointPicker
            value={baseUrl}
            onPick={(url) => {
              setBaseUrl(url);
              setError(null);
              setMessage(null);
            }}
          />
        </div>
        <input
          className={field}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          type="password"
          placeholder={
            stored?.key_stored
              ? "New API key (leave empty to keep the stored one)"
              : "API key (leave empty for a keyless local server)"
          }
          aria-label="Agent API key"
        />
        <div className="flex gap-1.5">
          <input
            className={`${field} flex-1`}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            placeholder="Encryption password"
            aria-label="Encryption password"
          />
          <input
            className={`${field} flex-1`}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            type="password"
            placeholder="Confirm password"
            aria-label="Confirm encryption password"
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          The password encrypts the key in this browser and is never sent to the
          server. It is asked again when you send a message.
        </p>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={button}
            disabled={busy || unsupported}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save configuration"}
          </button>
          {stored && (
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => {
                setReplacing(false);
                setMessage(null);
                resetForm();
                setBaseUrl(stored.base_url);
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {unsupported && (
        <p className="text-xs text-destructive">
          Encryption needs HTTPS or localhost.
        </p>
      )}
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * Modal prompt shown when a request arrives while the provider is locked.
 *
 * This is where a locked provider is unlocked: the agent's call gate stops the
 * message before it is appended, and the same prompt answers a `401
 * agent_locked` from a request that raced the lock.
 */
export function AgentUnlockDialog() {
  const prompt = useAtomValue(agentUnlockAtom).prompt;
  const info = useAtomValue(agentInfoAtom);
  const envelope = storedEnvelope(info);
  const [password, setPassword] = useState("");
  const unlock = useUnlockProvider(() => {
    setPassword("");
    void refreshProvider();
    dismissAgentUnlock();
  });

  useEffect(() => {
    setPassword("");
  }, [prompt]);

  useEffect(() => {
    if (!prompt) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissAgentUnlock();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prompt]);

  if (!prompt || !envelope) return null;

  // The host alone keeps the sentence readable; the full URL is in the card.
  const host = (() => {
    const raw = info?.stored?.base_url ?? "";
    try {
      return new URL(raw).host;
    } catch {
      return raw;
    }
  })();

  return (
    <div
      className="absolute inset-0 z-40 flex items-start justify-center bg-ink/25 p-4 pt-16 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Unlock the OpalNote agent provider"
    >
      <div className="w-full max-w-sm rounded-xl border border-border bg-background p-4 shadow-panel">
        <h3 className="text-sm font-semibold">Unlock to send this message</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Enter the password for the API key stored for{" "}
          <span className="font-mono text-foreground">{host}</span>. It never
          leaves this browser.
        </p>
        <input
          className={`${field} mt-3 w-full`}
          type="password"
          value={password}
          autoFocus
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && password) {
              void unlock.unlock(password, envelope);
            }
          }}
          placeholder="Password"
          aria-label="Provider password"
        />
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          Keep it
          <select
            value={unlock.scope}
            onChange={(event) =>
              unlock.setScope(event.target.value as typeof unlock.scope)
            }
            className="h-7 rounded-md border border-border/60 bg-background px-1.5 text-xs"
            aria-label="How long to keep the key"
          >
            {UNLOCK_SCOPES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          {unlock.scope === "custom" && (
            <input
              className={`${field} w-16`}
              type="number"
              min={CUSTOM_MINUTES_MIN}
              max={CUSTOM_MINUTES_MAX}
              value={unlock.customMinutes}
              onChange={(event) =>
                unlock.setCustomMinutes(
                  Number(event.target.value) || CUSTOM_MINUTES_MIN,
                )
              }
              aria-label="Custom unlock minutes"
            />
          )}
        </div>
        {unlock.scope !== "15m" && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {UNLOCK_SCOPES.find((option) => option.id === unlock.scope)?.detail}
          </p>
        )}
        <div className="mt-3 flex items-center justify-end gap-1.5">
          <button
            type="button"
            className={button}
            onClick={() => dismissAgentUnlock()}
          >
            Cancel
          </button>
          <button
            type="button"
            className={button}
            disabled={!password || unlock.busy}
            onClick={() => void unlock.unlock(password, envelope)}
          >
            {unlock.busy ? "Unlocking…" : "Unlock"}
          </button>
        </div>
        {unlock.error && (
          <p className="mt-2 text-xs text-destructive">{unlock.error}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Pre-call gate: ReAgent asks before appending a message to the transcript, so a
 * locked provider stops the call with the typed prompt still in the composer
 * instead of producing a failed turn. Only the OpalNote provider is gated —
 * ReAgent's own providers never need our password.
 */
export function useOpalNoteCallGate(): ReAgentCallGate {
  return useCallback((context: ReAgentCallContext) => opalnoteCallDecision(context), []);
}

/** ReAgent host-provider descriptor: the card above is the setup flow. */
export const OPALNOTE_HOST_PROVIDERS: ReAgentHostProvider[] = [
  {
    id: OPALNOTE_PROVIDER_ID,
    name: OPALNOTE_PROVIDER_NAME,
    component: AgentProviderCard,
    // The connection is rebuilt from `GET /api/agent` on mount.
    getConfig: () => null,
  },
];

/**
 * Keep the provider in sync with the server: initial load, an expiry timer for
 * the unlock window, and a recheck when the tab becomes visible again.
 */
export function useOpalNoteAgentProvider(): void {
  useEffect(() => {
    setAgentLockedHandler(() => requestUnlockPrompt());
    let cancelled = false;
    void refreshProvider().catch(() => {
      if (!cancelled) disconnectProvider();
    });
    const tick = () => {
      // The window only drops the key; the provider stays listed so the next
      // request can ask for the password instead of disappearing.
      expireUnlockIfNeeded();
    };
    const timer = window.setInterval(tick, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      setAgentLockedHandler(null);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}

/** Re-exported for tests and the panel. */
export { disconnectProvider };
