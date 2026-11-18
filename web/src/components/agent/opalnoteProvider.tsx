import { useCallback, useEffect, useState } from "react";
import {
  rebuildModels,
  setHostProviderConfig,
  type ReAgentHostProvider,
  type ReAgentHostProviderConfig,
  type ReAgentHostProviderProps,
} from "@liyu1981/reagent";

import { api } from "../../api/client";
import { getCsrfToken } from "../../lib/session";

/**
 * The OpalNote agent provider.
 *
 * OpalNote runs the model traffic itself: ReAgent talks to `/api/agent/v1`, the
 * Rust server adds the upstream credential and relays the stream. Nothing
 * secret reaches the browser, CORS never applies, and any OpenAI-compatible
 * upstream (OpenRouter, Ollama, LM Studio, vLLM, …) works the same way.
 *
 * Host-provider config is memory-only by design, so the connection is rebuilt
 * from `GET /api/agent` whenever the panel mounts; the server session is the
 * real gate.
 */
export const OPALNOTE_PROVIDER_ID = "opalnote";
export const OPALNOTE_PROVIDER_NAME = "OpalNote";
const STORAGE_PREFIX = "opalnote";
/** User opt-out, so an auto-connected provider can be switched off. */
const CONNECTED_KEY = "opalnote.agent.connected";

export type OpalNoteProviderState = {
  configured: boolean;
  models: string[];
  loading: boolean;
  error: string | null;
  /** Re-read `GET /api/agent` (and the upstream model list). */
  refresh: () => void;
};

type ServerAgentInfo = { configured: boolean; models: string[] };

function connectedByPreference(): boolean {
  return localStorage.getItem(CONNECTED_KEY) !== "0";
}

/** Absolute proxy URL: the agent client builds URLs from it. */
function proxyBaseUrl(): string {
  return new URL("/api/agent/v1", window.location.origin).href;
}

function providerConfig(models: string[]): ReAgentHostProviderConfig {
  return {
    // Same-origin proxy prefix; the server owns the upstream URL and key.
    baseUrl: proxyBaseUrl(),
    // No client credential: the cookie session authenticates the request and
    // the proxy replaces any Authorization header with the server's key.
    apiKey: "opalnote-session",
    api: "openai-completions",
    models,
    authHeaders: (): Record<string, string> => {
      const csrf = getCsrfToken();
      return csrf ? { "x-opalnote-csrf": csrf } : {};
    },
  };
}

async function loadServerState(): Promise<ServerAgentInfo> {
  const info = await api.agentInfo();
  if (!info.configured) return info;
  if (info.models.length > 0) return info;
  // The server knows the endpoint but not the model list: ask the upstream.
  return { configured: true, models: await api.agentModels().catch(() => []) };
}

function connect(models: string[]): void {
  setHostProviderConfig(OPALNOTE_PROVIDER_ID, providerConfig(models));
  rebuildModels(STORAGE_PREFIX);
}

function disconnect(): void {
  setHostProviderConfig(OPALNOTE_PROVIDER_ID, null);
  rebuildModels(STORAGE_PREFIX);
}

/**
 * Keep the OpalNote provider in sync with the server. Call once from the panel
 * that renders `<ReAgent>`.
 */
export function useOpalNoteAgentProvider(): OpalNoteProviderState {
  const [state, setState] = useState<
    Omit<OpalNoteProviderState, "refresh">
  >({
    configured: false,
    models: [],
    loading: true,
    error: null,
  });

  const apply = useCallback((info: ServerAgentInfo) => {
    setState({
      configured: info.configured,
      models: info.models,
      loading: false,
      error: null,
    });
    if (info.configured && connectedByPreference() && info.models.length > 0) {
      connect(info.models);
    } else {
      disconnect();
    }
  }, []);

  const refresh = useCallback(() => {
    setState((current) => ({ ...current, loading: true, error: null }));
    void loadServerState().then(apply, (cause: unknown) => {
      setState({
        configured: false,
        models: [],
        loading: false,
        error:
          cause instanceof Error ? cause.message : "Could not reach the server",
      });
    });
  }, [apply]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...state, refresh };
}

/** Setup card rendered inside ReAgent's Settings → Model panel. */
function OpalNoteProviderSetup({
  config,
  setConfig,
}: ReAgentHostProviderProps) {
  const [info, setInfo] = useState<ServerAgentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    loadServerState().then(
      (next) => {
        setInfo(next);
        setError(null);
        setBusy(false);
      },
      (cause: unknown) => {
        setError(
          cause instanceof Error ? cause.message : "Could not reach the server",
        );
        setBusy(false);
      },
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const connectNow = useCallback(() => {
    if (!info?.configured) return;
    localStorage.setItem(CONNECTED_KEY, "1");
    setConfig(providerConfig(info.models));
  }, [info, setConfig]);

  const disconnectNow = useCallback(() => {
    localStorage.setItem(CONNECTED_KEY, "0");
    setConfig(null);
  }, [setConfig]);

  return (
    <div className="space-y-1.5 rounded-xl border border-border/50 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">
          {config
            ? `Using the OpalNote server (${info?.models.length ?? 0} ${
                info?.models.length === 1 ? "model" : "models"
              })`
            : info?.configured
              ? "The server has a model endpoint configured."
              : "No model endpoint configured on the server."}
        </span>
        <div className="ml-auto flex gap-1.5">
          {config ? (
            <button
              type="button"
              onClick={disconnectNow}
              className="rounded-md border border-border/60 px-2 py-1 text-xs transition hover:bg-muted"
            >
              Disconnect
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={load}
                disabled={busy}
                className="rounded-md border border-border/60 px-2 py-1 text-xs transition hover:bg-muted disabled:opacity-40"
              >
                {busy ? "Checking…" : "Recheck"}
              </button>
              <button
                type="button"
                onClick={connectNow}
                disabled={!info?.configured || busy}
                className="rounded-md border border-border/60 px-2 py-1 text-xs transition hover:bg-muted disabled:opacity-40"
              >
                Connect
              </button>
            </>
          )}
        </div>
      </div>
      {config && info && info.models.length > 0 && (
        <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
          {info.models.slice(0, 6).join(", ")}
          {info.models.length > 6 ? ` +${info.models.length - 6}` : ""}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {info && !info.configured && (
        <p className="text-xs text-muted-foreground">
          Set <code>agent_base_url</code> (and <code>agent_api_key</code>) in
          the server config, or <code>OPALNOTE_AGENT_BASE_URL</code> /{" "}
          <code>OPALNOTE_AGENT_API_KEY</code>, then restart.
        </p>
      )}
    </div>
  );
}

export const OPALNOTE_HOST_PROVIDERS: ReAgentHostProvider[] = [
  {
    id: OPALNOTE_PROVIDER_ID,
    name: OPALNOTE_PROVIDER_NAME,
    component: OpalNoteProviderSetup,
    // Filled in by `setHostProviderConfig` once the server answers, so the
    // provider never appears before it can actually serve requests.
    getConfig: () => null,
  },
];
