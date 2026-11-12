import { Suspense, useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { EditorPane } from "./components/EditorPane";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { GraphView } from "./components/GraphView";
import { JournalFeed } from "./components/JournalFeed";
import { LeftSidebar } from "./components/LeftSidebar";
import { PagesView } from "./components/PagesView";
import { RightPanel } from "./components/RightPanel";
import { SearchDialog } from "./components/SearchDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { TopBar } from "./components/TopBar";
import {
  activeNoteIdAtom,
  activeNotebookIdAtom,
  graphViewAtom,
  journalViewAtom,
  leftPanelOpenAtom,
  notebooksAtom,
  pagesViewAtom,
  rightPanelOpenAtom,
  selectNotebookAtom,
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
  const selectNotebook = useSetAtom(selectNotebookAtom);
  const setActiveNote = useSetAtom(activeNoteIdAtom);
  const journalView = useAtomValue(journalViewAtom);
  const pagesView = useAtomValue(pagesViewAtom);
  const graphView = useAtomValue(graphViewAtom);
  const leftOpen = useAtomValue(leftPanelOpenAtom);
  const rightOpen = useAtomValue(rightPanelOpenAtom);

  useEffect(() => {
    if (notebooks.length === 0) {
      if (activeNotebookId !== null) selectNotebook(null);
      return;
    }
    if (!activeNotebookId || !notebooks.some((n) => n.id === activeNotebookId)) {
      selectNotebook(notebooks[0]?.id ?? null);
    }
  }, [notebooks, activeNotebookId, selectNotebook]);

  // Home, the page directory and graph are notebook-level views; do not keep a
  // stale note open in the right panel when one of them is showing.
  useEffect(() => {
    if (journalView || pagesView || graphView) setActiveNote(null);
  }, [journalView, pagesView, graphView, setActiveNote]);

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {leftOpen && (
        <Suspense fallback={<PanelSkeleton />}>
          <LeftSidebar />
        </Suspense>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <Suspense fallback={<EditorSkeleton />}>
            {journalView ? (
              <JournalFeed />
            ) : pagesView ? (
              <PagesView />
            ) : graphView ? (
              <GraphView />
            ) : (
              <EditorPane />
            )}
          </Suspense>
          {rightOpen && (
            <Suspense fallback={null}>
              <RightPanel />
            </Suspense>
          )}
        </div>
      </div>
      <SearchDialog />
      <SettingsDialog />
    </div>
  );
}

function PanelSkeleton() {
  return (
    <section className="flex w-[15.5rem] shrink-0 animate-pulse flex-col border-r border-line bg-panel/35 p-3">
      <div className="h-4 w-24 rounded bg-panel-strong" />
      <div className="mt-3 h-7 rounded-md bg-panel" />
      <div className="mt-3 h-7 rounded-md bg-panel" />
      <div className="mt-4 space-y-1.5">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="h-7 rounded-md bg-white/40" />
        ))}
      </div>
    </section>
  );
}

function EditorSkeleton() {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center bg-canvas">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" />
    </main>
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
