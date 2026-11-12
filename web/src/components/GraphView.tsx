import { useAtomValue } from "jotai";

import { GraphPanel } from "./GraphPanel";
import { IconGraph } from "./Icons";
import {
  activeNotebookAtom,
  activeNotebookIdAtom,
} from "../state/atoms";

export function GraphView() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const notebook = useAtomValue(activeNotebookAtom);

  if (!notebookId) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-canvas p-8">
        <p className="max-w-sm text-center font-mono text-[11.5px] leading-relaxed text-muted">
          Select or create a notebook to view its graph.
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-canvas">
      <div className="mx-auto w-full max-w-6xl px-6 py-6">
        <header className="border-b border-line pb-4">
          <div className="flex items-center gap-2 font-mono text-[9.5px] font-semibold uppercase tracking-[0.16em] text-faint">
            <IconGraph className="h-3.5 w-3.5" />
            Notebook graph
          </div>
          <h1 className="mt-1 font-mono text-[26px] font-semibold tracking-tight text-ink">
            {notebook?.name ?? "Graph"}
          </h1>
          <p className="mt-2 font-mono text-[10.5px] text-muted">
            Click any node to open its page. Edges are resolved wikilinks.
          </p>
        </header>
        <div className="mt-4 rounded-2xl border border-line bg-white/20 p-4">
          <GraphPanel
            notebookId={notebookId}
            activeNoteId={null}
            width={1040}
            height={640}
            defaultScope="all"
          />
        </div>
      </div>
    </main>
  );
}
