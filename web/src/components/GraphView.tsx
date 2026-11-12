import { useAtomValue } from "jotai";

import { GraphPanel } from "./GraphPanel";
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
    <main className="flex min-h-0 flex-1 flex-col bg-canvas">
      <GraphPanel
        notebookId={notebookId}
        activeNoteId={null}
        width={1200}
        height={760}
        defaultScope="all"
        fill
        title={notebook?.name ?? "Graph"}
      />
    </main>
  );
}
