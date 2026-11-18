import { ReAgent } from "@liyu1981/reagent";

import {
  OPALNOTE_HOST_PROVIDERS,
  useOpalNoteAgentProvider,
} from "./opalnoteProvider";

/**
 * In-panel ReAgent chat.
 *
 * The agent loop runs entirely in the browser (pi-agent-core / pi-ai) and
 * conversations stay in IndexedDB under the `opalnote` storage prefix. Models
 * come from two places: ReAgent's own OpenRouter/local-endpoint configuration,
 * and the OpalNote provider, which proxies through the Rust server so the
 * upstream credential never reaches the browser.
 */
export function AgentPanel() {
  useOpalNoteAgentProvider();
  return (
    <div className="agent-surface flex h-full min-h-0 flex-col">
      <ReAgent
        surface="solid"
        theme="light"
        storagePrefix="opalnote"
        hostProviders={OPALNOTE_HOST_PROVIDERS}
        className="h-full"
      />
    </div>
  );
}
