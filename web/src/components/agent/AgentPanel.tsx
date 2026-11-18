import { ReAgent } from "@liyu1981/reagent";

import {
  AgentUnlockDialog,
  OPALNOTE_HOST_PROVIDERS,
  useOpalNoteAgentProvider,
} from "./AgentProviderCard";

/**
 * In-panel ReAgent chat.
 *
 * The agent loop runs in the browser and conversations stay in IndexedDB under
 * the `opalnote` storage prefix. Models come from the OpalNote provider, which
 * proxies through the Rust server (the upstream key is stored encrypted), or
 * from ReAgent's own browser-side providers when the user prefers those.
 */
export function AgentPanel() {
  useOpalNoteAgentProvider();
  return (
    <div className="agent-surface relative flex h-full min-h-0 flex-col">
      <ReAgent
        surface="solid"
        theme="light"
        storagePrefix="opalnote"
        hostProviders={OPALNOTE_HOST_PROVIDERS}
        className="h-full"
      />
      <AgentUnlockDialog />
    </div>
  );
}
