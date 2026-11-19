import { Suspense, useEffect, useRef } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";

import { LeftSidebar } from "./LeftSidebar";
import { MainBackground } from "./MainBackground";
import { RightPanel } from "./RightPanel";
import { ShortcutHud } from "./ShortcutHud";
import { SettingsDialog } from "./SettingsDialog";
import { DiagramLightbox } from "./diagram/DiagramLightbox";
import { ImageLightbox } from "./lightbox/ImageLightbox";
import { TopBar } from "./TopBar";
import { useKeyboardShortcuts } from "../lib/useKeyboardShortcuts";
import { useRevalidateOnResume } from "../lib/useRevalidateOnResume";
import {
  applySettings,
  bootstrapSettings,
  settingsAtom,
  settingsErrorAtom,
  settingsStatusAtom,
} from "../lib/settings";
import {
  activeNotebookIdAtom,
  leftPanelOpenAtom,
  notebooksAtom,
  rightPanelOpenAtom,
} from "../state/atoms";

export function Workspace() {
  const notebooks = useAtomValue(notebooksAtom);
  const activeNotebookId = useAtomValue(activeNotebookIdAtom);
  const setActiveNotebook = useSetAtom(activeNotebookIdAtom);
  const leftOpen = useAtomValue(leftPanelOpenAtom);
  const rightOpen = useAtomValue(rightPanelOpenAtom);
  const setLeftOpen = useSetAtom(leftPanelOpenAtom);
  const setRightOpen = useSetAtom(rightPanelOpenAtom);
  const location = useRouterState({ select: (state) => state.location.href });
  const settings = useAtomValue(settingsAtom);
  const setSettings = useSetAtom(settingsAtom);
  const setSettingsStatus = useSetAtom(settingsStatusAtom);
  const setSettingsError = useSetAtom(settingsErrorAtom);
  const activeNotebook = notebooks.find(
    (notebook) => notebook.id === activeNotebookId,
  );

  useKeyboardShortcuts();
  // A resumed PWA keeps its old state; re-read notes changed elsewhere.
  useRevalidateOnResume();

  // On phones and small tablets the panels float over the page, so opening
  // something from them should reveal it instead of leaving the drawer on top.
  const firstLocation = useRef(true);
  useEffect(() => {
    if (firstLocation.current) {
      firstLocation.current = false;
      return;
    }
    if (!window.matchMedia("(max-width: 767px)").matches) return;
    setLeftOpen(false);
    setRightOpen(false);
  }, [location, setLeftOpen, setRightOpen]);

  useEffect(() => {
    document.title = activeNotebook
      ? `OpalNote : ${activeNotebook.name}`
      : "OpalNote";
  }, [activeNotebook?.name]);

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
      if (activeNotebookId !== null) setActiveNotebook(null);
      return;
    }
    if (!activeNotebookId || !notebooks.some((n) => n.id === activeNotebookId)) {
      // The route owns the notebook URL. Only fill in a missing selection;
      // clearing the note/view atoms here would race a deep link's route effect.
      setActiveNotebook(notebooks[0]?.id ?? null);
    }
  }, [notebooks, activeNotebookId, setActiveNotebook]);

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
      {/* Below `md` the panels float over the page instead of shrinking it. */}
      {(leftOpen || rightOpen) && (
        <button
          type="button"
          aria-label="Close panels"
          onClick={() => {
            setLeftOpen(false);
            setRightOpen(false);
          }}
          className="absolute inset-0 z-[45] bg-ink/25 backdrop-blur-[2px] md:hidden"
        />
      )}
      {leftOpen && (
        <div className="absolute inset-y-0 left-0 z-50 md:static md:z-auto">
          <Suspense fallback={<PanelSkeleton />}>
            <LeftSidebar />
          </Suspense>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <div className="relative flex min-h-0 min-w-0 flex-1">
            <Suspense
              fallback={
                <div className="pointer-events-none absolute inset-0 z-0 bg-canvas" />
              }
            >
              <MainBackground />
            </Suspense>
            <div className="relative z-10 flex min-h-0 min-w-0 flex-1">
              <Suspense fallback={<EditorSkeleton />}>
                <Outlet />
              </Suspense>
            </div>
          </div>
          {rightOpen && (
            <div className="absolute inset-y-0 right-0 z-50 md:static md:z-auto">
              <Suspense fallback={null}>
                <RightPanel />
              </Suspense>
            </div>
          )}
        </div>
      </div>
      <SettingsDialog />
      <DiagramLightbox />
      <ImageLightbox />
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
    <main className="flex min-h-0 flex-1 items-center justify-center bg-transparent">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" />
    </main>
  );
}
