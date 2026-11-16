import { ReAgent } from "@liyu1981/reagent";

/**
 * In-panel ReAgent chat.
 *
 * The agent loop runs entirely in the browser (pi-agent-core / pi-ai): API keys
 * and conversations stay in `localStorage`/IndexedDB under the `opalnote`
 * storage prefix. Model setup lives inside the agent's own Settings view.
 */
export function AgentPanel() {
  return (
    <div className="agent-surface flex h-full min-h-0 flex-col">
      <ReAgent
        surface="solid"
        theme="light"
        storagePrefix="opalnote"
        className="h-full"
      />
    </div>
  );
}
