import { Suspense, useEffect } from "react";
import { Outlet } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";

import { CommandPalette } from "./CommandPalette";
import { LeftSidebar } from "./LeftSidebar";
import { RightPanel } from "./RightPanel";
import { SearchDialog } from "./SearchDialog";
import { ShortcutHud } from "./ShortcutHud";
import { SettingsDialog } from "./SettingsDialog";
import { TopBar } from "./TopBar";
import { useKeyboardShortcuts } from "../lib/useKeyboardShortcuts";
import {
  applySettings,
  bootstrapSettings,
  settingsAtom,
  settingsErrorAtom,
  settingsStatusAtom,
} from "../lib/settings";
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
} from "../state/atoms";

export function Workspace() {
  const notebooks = useAtomValue(notebooksAtom);
  const activeNotebookId = useAtomValue(activeNotebookIdAtom);
  const selectNotebook = useSetAtom(selectNotebookAtom);
  const setActiveNote = useSetAtom(activeNoteIdAtom);
  const journalView = useAtomValue(journalViewAtom);
  const pagesView = useAtomValue(pagesViewAtom);
  const graphView = useAtomValue(graphViewAtom);
  const leftOpen = useAtomValue(leftPanelOpenAtom);
  const rightOpen = useAtomValue(rightPanelOpenAtom);
  const settings = useAtomValue(settingsAtom);
  const setSettings = useSetAtom(settingsAtom);
  const setSettingsStatus = useSetAtom(settingsStatusAtom);
  const setSettingsError = useSetAtom(settingsErrorAtom);

  useKeyboardShortcuts();

  useEffect(() => {
    let cancelled = false;
    void bootstrapSettings().then(({ settings, warning }) => {
      if (cancelled) return;
      setSettings(settings);
      setSettingsStatus(warning ? "error" : "saved");
      setSettingsError(warning ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [setSettings, setSettingsError, setSettingsStatus]);

  useEffect(() => {
    applySettings(settings);
  }, [settings]);

  useEffect(() => {
    if (notebooks.length === 0) {
      if (activeNotebookId !== null) selectNotebook(null);
      return;
    }
    if (!activeNotebookId || !notebooks.some((n) => n.id === activeNotebookId)) {
      selectNotebook(notebooks[0]?.id ?? null);
    }
  }, [notebooks, activeNotebookId, selectNotebook]);

  // Home, directory and graph are notebook-level views; do not keep a stale
  // note selected while one of them is showing.
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
            <Outlet />
          </Suspense>
          {rightOpen && (
            <Suspense fallback={null}>
              <RightPanel />
            </Suspense>
          )}
        </div>
      </div>
      <SearchDialog />
      <CommandPalette />
      <SettingsDialog />
      <ShortcutHud />
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
