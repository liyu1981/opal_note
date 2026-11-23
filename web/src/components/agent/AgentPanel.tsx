import { OLLAMA_PROVIDER_ID, ReAgent } from "@liyu1981/reagent";

import {
  AgentUnlockDialog,
  OPALNOTE_HOST_PROVIDERS,
  useOpalNoteAgentProvider,
  useOpalNoteCallGate,
} from "./AgentProviderCard";
import { OPALNOTE_PROVIDER_ID } from "./opalnoteProvider";

/**
 * The OpalNote provider plus ReAgent's local model server, nothing else.
 *
 * Every *cloud* model call is proxied through the Rust server (which owns the
 * encrypted credential), and the SPA's `connect-src` allows no third-party host,
 * so a browser-side cloud provider could only ever be a dead end that logs CSP
 * violations. The local server is different: `connect-src` includes the loopback
 * hosts, so `http://localhost:11434` (or any local OpenAI-compatible port) works
 * directly and users can run a model without a server-side key. Anything further
 * away — a LAN box, a tunnel — goes in the OpalNote card, where the proxy makes
 * the request.
 */
const PROVIDER_FILTER = {
  enabled: [OPALNOTE_PROVIDER_ID, OLLAMA_PROVIDER_ID],
};

/**
 * ReAgent's stock subtitle describes browser-stored keys sent straight to a
 * provider. OpalNote's key lives encrypted on the server and every call goes
 * through the proxy, so say that instead.
 */
const MESSAGES = {
  "agent.settingsDescription":
    "The API key is stored encrypted on your OpalNote server; every model call goes through it, not straight from this browser.",
  // ReAgent's cloud providers run in the browser and this app's CSP allows only
  // the loopback hosts, so they are not registered. Say where to go instead of
  // leaving an empty section behind.
  "agent.cloudProvidersDisabled":
    "Cloud providers run in this browser and are not allowed by OpalNote's security policy. Use the OpalNote provider above — it proxies through your server — or the local server section below.",
};

/**
 * In-panel ReAgent chat.
 *
 * The agent loop runs in the browser and conversations stay in IndexedDB under
 * the `opalnote` storage prefix. Models come from the OpalNote provider, which
 * proxies through the Rust server (the upstream key is stored encrypted).
 */
export function AgentPanel() {
  useOpalNoteAgentProvider();
  const beforeAgentCall = useOpalNoteCallGate();
  return (
    <div className="agent-surface relative flex h-full min-h-0 flex-col">
      <ReAgent
        surface="solid"
        theme="light"
        storagePrefix="opalnote"
        hostProviders={OPALNOTE_HOST_PROVIDERS}
        providerFilter={PROVIDER_FILTER}
        messages={MESSAGES}
        beforeAgentCall={beforeAgentCall}
        className="h-full"
      />
      <AgentUnlockDialog />
    </div>
  );
}
