import { Suspense, useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { EditorPane } from "./components/EditorPane";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Inspector } from "./components/Inspector";
import { NotebookRail } from "./components/NotebookRail";
import { NotesPanel } from "./components/NotesPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { TopBar } from "./components/TopBar";
import {
  activeNoteIdAtom,
  activeNotebookIdAtom,
  notebooksAtom,
} from "./state/atoms";

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<BootScreen />}>
        <Workspace />
      </Suspense>
    </ErrorBoundary>
  );
}

function Workspace() {
  const notebooks = useAtomValue(notebooksAtom);
  const activeNotebookId = useAtomValue(activeNotebookIdAtom);
  const setActiveNotebook = useSetAtom(activeNotebookIdAtom);
  const setActiveNote = useSetAtom(activeNoteIdAtom);

  useEffect(() => {
    if (notebooks.length === 0) {
      if (activeNotebookId !== null) {
        setActiveNotebook(null);
        setActiveNote(null);
      }
      return;
    }
    if (!activeNotebookId || !notebooks.some((n) => n.id === activeNotebookId)) {
      setActiveNotebook(notebooks[0]?.id ?? null);
      setActiveNote(null);
    }
  }, [
    notebooks,
    activeNotebookId,
    setActiveNotebook,
    setActiveNote,
  ]);

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <NotebookRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <Suspense fallback={<PanelSkeleton />}>
            <NotesPanel />
          </Suspense>
          <EditorPane />
          <Suspense fallback={null}>
            <Inspector />
          </Suspense>
        </div>
      </div>
      <SettingsDialog />
    </div>
  );
}

function PanelSkeleton() {
  return (
    <section className="flex w-[18.5rem] shrink-0 animate-pulse flex-col border-r border-line bg-canvas/50 p-3">
      <div className="h-3 w-20 rounded bg-panel-strong" />
      <div className="mt-3 h-8 rounded-lg bg-panel" />
      <div className="mt-3 space-y-1.5">
        {Array.from({ length: 6 }).map((_, index) => (
          <div
            key={index}
            className="h-16 rounded-xl border border-line/60 bg-white/40"
          />
        ))}
      </div>
    </section>
  );
}

function BootScreen() {
  return (
    <div className="flex h-full items-center justify-center bg-canvas">
      <div className="text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" />
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
          Querying MnesticDB
        </p>
      </div>
    </div>
  );
}
