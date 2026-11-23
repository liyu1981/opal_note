import { useCallback, useEffect, useState } from "react";
import { getDefaultStore, useAtomValue } from "jotai";
import type {
  ReAgentCallContext,
  ReAgentCallDecision,
  ReAgentCallGate,
  ReAgentHostProvider,
  ReAgentHostProviderProps,
} from "@liyu1981/reagent";

import { api } from "../../api/client";
import {
  CryptoUnavailableError,
  canDecrypt,
  envelopeFingerprint,
  resealWithDerivedKey,
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
  requestAgentUnlock,
} from "../../state/agentUnlock";
import { EndpointPicker } from "./EndpointPicker";
import {
  OPALNOTE_PROVIDER_ID,
  OPALNOTE_PROVIDER_NAME,
  agentInfoAtom,
  disconnectProvider,
  lockProvider,
  refreshProvider,
  requestUnlockPrompt,
  setAgentLockedHandler,
  storedEnvelope,
  syncProvider,
  useUnlockProvider,
} from "./opalnoteProvider";

const store = getDefaultStore();

const field =
  "h-8 min-w-0 rounded-md border border-border/60 bg-background px-2 font-mono text-xs outline-none focus:border-foreground/40";
const button =
  "h-8 rounded-md border border-border/60 px-2.5 text-xs transition hover:bg-muted disabled:opacity-40";

/**
 * Settings → Agent → Model card.
 *
 * Everything the provider needs is entered here and stored server-side: the base
 * URL in clear, the API key encrypted in the browser with the password the user
 * types. The password itself is never sent anywhere.
 */
function AgentProviderCard({ config }: ReAgentHostProviderProps) {
  const info = useAtomValue(agentInfoAtom);
  const unlock = useAtomValue(agentUnlockAtom);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const unlocking = useUnlockProvider(() => {
    void refreshProvider();
  });

  const stored = info?.stored ?? null;
  const envelope = storedEnvelope(info);
  const unsupported = typeof crypto === "undefined" || !crypto.subtle;

  useEffect(() => {
    if (stored?.base_url) setBaseUrl(stored.base_url);
  }, [stored?.base_url]);

  const save = useCallback(async () => {
    setError(null);
    setMessage(null);
    if (!baseUrl.trim()) {
      setError("Enter the base URL of an OpenAI-compatible endpoint.");
      return;
    }
    const key = apiKey.trim();
    if (key && !password && !unlock.key) {
      setError("Enter an encryption password for the API key.");
      return;
    }
    if (key && password && password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      let nextEnvelope: KeyEnvelope | null = envelope;
      let derivedKey = unlock.key;
      if (key) {
        if (password) {
          const sealed = await sealApiKey(password, key);
          nextEnvelope = sealed.envelope;
          derivedKey = sealed.derivedKey;
        } else if (envelope && derivedKey) {
          // Already unlocked: re-encrypt with the same key, so the existing
          // password keeps working.
          nextEnvelope = await resealWithDerivedKey(key, envelope, derivedKey);
        } else {
          setError("Enter the encryption password for the new API key.");
          return;
        }
      }
      if (nextEnvelope && derivedKey) {
        const ok = await canDecrypt(derivedKey, nextEnvelope);
        if (!ok) {
          setError("The key could not be encrypted; try again.");
          return;
        }
      }

      const models = info?.models.length ? info.models : await api.agentModels().catch(() => []);
      const saved = await api.saveAgentConfig({
        base_url: baseUrl.trim(),
        models,
        key_envelope: nextEnvelope ? JSON.stringify(nextEnvelope) : null,
      });
      if (nextEnvelope && derivedKey) {
        const fingerprint = await envelopeFingerprint(nextEnvelope);
        unlocking.setScope(unlocking.scope);
        const { storeUnlock, saveUnlockPreferences } = await import(
          "../../state/agentUnlock"
        );
        saveUnlockPreferences(unlocking.scope, unlocking.customMinutes);
        storeUnlock(derivedKey, fingerprint, unlocking.scope);
        await syncProvider(saved);
      } else {
        lockProvider();
        await syncProvider(saved);
      }
      setApiKey("");
      setPassword("");
      setConfirm("");
      setMessage("OpalNote provider saved.");
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
  }, [apiKey, baseUrl, confirm, envelope, info, password, unlock.key, unlocking]);

  const remove = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const info = await api.deleteAgentConfig();
      lockProvider();
      await syncProvider(info);
      setMessage("OpalNote provider removed.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not remove the provider",
      );
    } finally {
      setBusy(false);
      setConfirmRemove(false);
    }
  }, []);

  const status = unsupported
    ? "Encryption needs HTTPS or localhost."
    : !stored
      ? "Not configured."
      : stored.key_stored
        ? unlock.key
          ? `Connected to ${stored.base_url}`
          : `Locked · ${stored.base_url}`
        : `Connected to ${stored.base_url} (no key)`;

  return (
    <div className="space-y-2 rounded-xl border border-border/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{status}</span>
        <div className="ml-auto flex gap-1.5">
          {stored && unlock.key && (
            <button
              type="button"
              className={button}
              onClick={() => {
                lockProvider();
              }}
            >
              Lock now
            </button>
          )}
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => {
              void refreshProvider().catch(() => undefined);
            }}
          >
            Recheck
          </button>
        </div>
      </div>

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

        <div className="flex flex-wrap items-center gap-1.5">
          <select
            value={unlocking.scope}
            onChange={(event) =>
              unlocking.setScope(event.target.value as typeof unlocking.scope)
            }
            className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs"
            aria-label="Unlock window"
          >
            {UNLOCK_SCOPES.map((option) => (
              <option key={option.id} value={option.id}>
                Unlock for {option.label.toLowerCase()}
              </option>
            ))}
          </select>
          {unlocking.scope === "custom" && (
            <input
              className={`${field} w-20`}
              type="number"
              min={CUSTOM_MINUTES_MIN}
              max={CUSTOM_MINUTES_MAX}
              value={unlocking.customMinutes}
              onChange={(event) =>
                unlocking.setCustomMinutes(
                  Number(event.target.value) || CUSTOM_MINUTES_MIN,
                )
              }
              aria-label="Custom unlock minutes"
            />
          )}
          {stored?.key_stored && !unlock.key ? (
            <button
              type="button"
              className={button}
              disabled={busy || unlocking.busy || !password}
              onClick={() => void unlocking.unlock(password, envelope)}
            >
              {unlocking.busy ? "Unlocking…" : "Unlock"}
            </button>
          ) : (
            <button
              type="button"
              className={button}
              disabled={busy || unsupported}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : stored ? "Update provider" : "Connect provider"}
            </button>
          )}
          {stored && !confirmRemove && (
            <button
              type="button"
              className={`${button} text-destructive`}
              onClick={() => setConfirmRemove(true)}
            >
              Remove
            </button>
          )}
          {confirmRemove && (
            <button
              type="button"
              className={`${button} border-destructive/40 text-destructive`}
              disabled={busy}
              onClick={() => void remove()}
            >
              Confirm remove
            </button>
          )}
        </div>
        {unlocking.scope !== "15m" && (
          <p className="text-[11px] text-muted-foreground">
            {UNLOCK_SCOPES.find((option) => option.id === unlocking.scope)?.detail}
          </p>
        )}
      </div>

      {message && <p className="text-xs text-muted-foreground">{message}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {unlocking.error && (
        <p className="text-xs text-destructive">{unlocking.error}</p>
      )}
      {config && stored?.key_stored && !unlock.key && (
        <p className="text-[11px] text-muted-foreground">
          The provider stays out of the model picker until it is unlocked.
        </p>
      )}
    </div>
  );
}

/** Modal prompt shown when a request arrives while the provider is locked. */
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

  return (
    <div
      className="absolute inset-0 z-40 flex items-start justify-center bg-ink/25 p-4 pt-16 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Unlock the OpalNote agent provider"
    >
      <div className="w-full max-w-sm rounded-xl border border-border bg-background p-4 shadow-panel">
        <h3 className="text-sm font-semibold">Unlock the OpalNote provider</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Enter the password that encrypts the stored API key. It never leaves
          this browser.
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
  return useCallback(
    (context: ReAgentCallContext): ReAgentCallDecision => {
      if (context.model?.providerId !== OPALNOTE_PROVIDER_ID) return true;
      expireUnlockIfNeeded();
      const info = store.get(agentInfoAtom);
      if (!storedEnvelope(info)) return true; // keyless local endpoint
      if (store.get(agentUnlockAtom).key) return true;
      requestAgentUnlock();
      return {
        ok: false,
        message:
          "The OpalNote provider is locked — enter its password to send this.",
      };
    },
    [],
  );
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
