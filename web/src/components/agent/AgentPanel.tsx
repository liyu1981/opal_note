import { ReAgent } from "@liyu1981/reagent";

import {
  AgentUnlockDialog,
  OPALNOTE_HOST_PROVIDERS,
  useOpalNoteAgentProvider,
  useOpalNoteCallGate,
} from "./AgentProviderCard";
import { OPALNOTE_PROVIDER_ID } from "./opalnoteProvider";

/**
 * Only the OpalNote provider is registered.
 *
 * Every model call is proxied through the Rust server (which owns the encrypted
 * credential), and the SPA's `connect-src 'self'` blocks browser-direct calls to
 * any other host — ReAgent's built-in cloud and localhost providers would be
 * dead ends whose connection probes only fill the console. A local server is
 * still reachable: put its URL in the OpalNote provider card and the proxy makes
 * the request.
 */
const PROVIDER_FILTER = { enabled: [OPALNOTE_PROVIDER_ID] };

/**
 * ReAgent's stock subtitle describes browser-stored keys sent straight to a
 * provider. OpalNote's key lives encrypted on the server and every call goes
 * through the proxy, so say that instead.
 */
const MESSAGES = {
  "agent.settingsDescription":
    "The API key is stored encrypted on your OpalNote server; every model call goes through it, not straight from this browser.",
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
