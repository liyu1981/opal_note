import { useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useCanGoBack, useRouter } from "@tanstack/react-router";

import {
  IconArrowLeft,
  IconArrowRight,
  IconBook,
  IconHome,
  IconLock,
  IconPanelLeft,
  IconPanelRight,
  IconSettings,
} from "./Icons";
import {
  activeNotebookAtom,
  journalViewAtom,
  leftPanelOpenAtom,
  readOnlyAtom,
  rightPanelOpenAtom,
  settingsOpenAtom,
} from "../state/atoms";
import { useAppNavigate } from "../lib/appNavigation";
import { OmniBar } from "./OmniBar";
import { bindingLabel } from "../lib/shortcuts";
import { settingsAtom } from "../lib/settings";

export function TopBar() {
  const notebook = useAtomValue(activeNotebookAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const settings = useAtomValue(settingsAtom);
  const navigate = useAppNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const [canGoForward, setCanGoForward] = useState(false);
  const maxHistoryIndex = useRef(0);
  const journalView = useAtomValue(journalViewAtom);
  const locked = useAtomValue(readOnlyAtom);
  const setLocked = useSetAtom(readOnlyAtom);
  const leftOpen = useAtomValue(leftPanelOpenAtom);
  const rightOpen = useAtomValue(rightPanelOpenAtom);
  const setLeftOpen = useSetAtom(leftPanelOpenAtom);
  const setRightOpen = useSetAtom(rightPanelOpenAtom);

  useEffect(() => {
    const indexOf = (state: unknown) =>
      (state as { __TSR_index?: number } | undefined)?.__TSR_index ?? 0;
    maxHistoryIndex.current = indexOf(router.history.location.state);
    const unsubscribe = router.history.subscribe(({ action, location }) => {
      const index = indexOf(location.state);
      if (action.type === "PUSH" || action.type === "REPLACE") {
        maxHistoryIndex.current = index;
        setCanGoForward(false);
        return;
      }
      maxHistoryIndex.current = Math.max(maxHistoryIndex.current, index);
      setCanGoForward(index < maxHistoryIndex.current);
    });
    return unsubscribe;
  }, [router]);

  return (
    <header className="relative z-40 flex min-h-13 shrink-0 flex-wrap items-center gap-1.5 gap-y-1.5 border-b border-line bg-canvas/80 px-2 py-1.5 backdrop-blur sm:grid sm:h-13 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center sm:gap-2 sm:px-3 sm:py-0">
      <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
        <button
          type="button"
          onClick={() => setLeftOpen(!leftOpen)}
          aria-pressed={leftOpen}
          className={`shrink-0 rounded-md border p-1.5 transition ${
            leftOpen
              ? "border-accent/30 bg-accent-soft text-accent-strong"
              : "border-transparent text-muted hover:bg-panel"
          }`}
          title={leftOpen ? "Collapse left sidebar" : "Expand left sidebar"}
          aria-label="Toggle left sidebar"
        >
          <IconPanelLeft className="h-4 w-4" />
        </button>

        <div className="hidden min-w-0 items-center gap-2 md:flex">
          <IconBook className="h-3.5 w-3.5 shrink-0 text-faint" />
          <span className="truncate font-sans text-[14px] font-medium text-ink-soft">
            {notebook?.name ?? "No notebook selected"}
          </span>
          {notebook && (
            <>
              <span className="shrink-0 text-faint">·</span>
              <span className="shrink-0 text-[14px] text-muted">
                {notebook.note_count}{" "}
                {notebook.note_count === 1 ? "note" : "notes"}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="order-last flex w-full min-w-0 items-center gap-1.5 sm:order-none sm:w-auto sm:justify-center">
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => router.history.back()}
            disabled={!canGoBack}
            className="rounded-md border border-transparent p-1.5 text-muted transition hover:bg-panel hover:text-ink disabled:cursor-default disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-muted"
            title={`Back (${bindingLabel("nav.back", settings.keybindings)})`}
            aria-label="Go back"
          >
            <IconArrowLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => router.history.forward()}
            disabled={!canGoForward}
            className="rounded-md border border-transparent p-1.5 text-muted transition hover:bg-panel hover:text-ink disabled:cursor-default disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-muted"
            title={`Forward (${bindingLabel("nav.forward", settings.keybindings)})`}
            aria-label="Go forward"
          >
            <IconArrowRight className="h-4 w-4" />
          </button>
        </div>
        <OmniBar />
      </div>

      <div className="ml-auto flex items-center gap-1.5 sm:ml-0 sm:justify-self-end sm:gap-2">
        <button
          type="button"
          onClick={() => navigate({ view: "journal" })}
          aria-pressed={journalView}
          className={`rounded-md border p-1.5 transition ${
            journalView
              ? "border-accent/30 bg-accent-soft text-accent-strong"
              : "border-transparent text-muted hover:bg-panel"
          }`}
          title="Home — journal feed"
          aria-label="Home"
        >
          <IconHome className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setRightOpen(!rightOpen)}
          aria-pressed={rightOpen}
          className={`rounded-md border p-1.5 transition ${
            rightOpen
              ? "border-accent/30 bg-accent-soft text-accent-strong"
              : "border-transparent text-muted hover:bg-panel"
          }`}
          title={rightOpen ? "Collapse right sidebar" : "Expand right sidebar"}
          aria-label="Toggle right sidebar"
        >
          <IconPanelRight className="h-4 w-4" />
        </button>
        {locked && (
          <button
            type="button"
            onClick={() => setLocked(false)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-accent/30 bg-accent-soft text-accent-strong transition hover:bg-accent-soft/70"
            aria-label="Unlock editing"
            title="Read only — click to unlock"
          >
            <IconLock className="h-3.5 w-3.5" />
          </button>
        )}
        <span
          className="mx-1 h-2 w-2 shrink-0 rounded-full bg-mint"
          title="Datalog index online"
          role="status"
          aria-label="Datalog index online"
        />
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="rounded-lg border border-line bg-white/50 p-1.5 text-muted transition hover:border-line-strong hover:bg-white hover:text-ink"
          aria-label="Connection settings"
          title="Connection settings"
        >
          <IconSettings className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
