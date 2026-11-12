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
  IconSearch,
  IconSettings,
} from "./Icons";
import {
  activeNotebookAtom,
  activeNotebookIdAtom,
  journalViewAtom,
  leftPanelOpenAtom,
  notebooksAtom,
  readOnlyAtom,
  rightPanelOpenAtom,
  searchOpenAtom,
  selectNotebookAtom,
  settingsOpenAtom,
} from "../state/atoms";
import { useAppNavigate } from "../lib/appNavigation";

export function TopBar() {
  const notebooks = useAtomValue(notebooksAtom);
  const notebook = useAtomValue(activeNotebookAtom);
  const activeId = useAtomValue(activeNotebookIdAtom);
  const selectNotebook = useSetAtom(selectNotebookAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const setSearchOpen = useSetAtom(searchOpenAtom);
  const searchOpen = useAtomValue(searchOpenAtom);
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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const back =
        (event.altKey && event.key === "ArrowLeft") ||
        ((event.metaKey || event.ctrlKey) && event.key === "[");
      const forward =
        (event.altKey && event.key === "ArrowRight") ||
        ((event.metaKey || event.ctrlKey) && event.key === "]");
      if (back) {
        event.preventDefault();
        router.history.back();
      } else if (forward) {
        event.preventDefault();
        router.history.forward();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return (
    <header className="flex h-13 shrink-0 items-center gap-1.5 border-b border-line bg-canvas/80 px-2 backdrop-blur sm:gap-2 sm:px-3">
      <button
        type="button"
        onClick={() => setLeftOpen(!leftOpen)}
        aria-pressed={leftOpen}
        className={`rounded-md border p-1.5 transition ${
          leftOpen
            ? "border-accent/30 bg-accent-soft text-accent-strong"
            : "border-transparent text-muted hover:bg-panel"
        }`}
        title={leftOpen ? "Collapse left sidebar" : "Expand left sidebar"}
        aria-label="Toggle left sidebar"
      >
        <IconPanelLeft className="h-4 w-4" />
      </button>

      <button
        type="button"
        onClick={() => setSearchOpen(true)}
        aria-pressed={searchOpen}
        className={`rounded-md border p-1.5 transition ${
          searchOpen
            ? "border-accent/30 bg-accent-soft text-accent-strong"
            : "border-transparent text-muted hover:bg-panel hover:text-ink"
        }`}
        title="Search notes (⌘K)"
        aria-label="Search notes"
        aria-haspopup="dialog"
      >
        <IconSearch className="h-4 w-4" />
      </button>

      <div className="ml-0.5 flex items-center gap-0.5 border-l border-line pl-1 sm:ml-1 sm:pl-1.5">
        <button
          type="button"
          onClick={() => router.history.back()}
          disabled={!canGoBack}
          className="rounded-md border border-transparent p-1.5 text-muted transition hover:bg-panel hover:text-ink disabled:cursor-default disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-muted"
          title="Back (⌘[ or Alt+←)"
          aria-label="Go back"
        >
          <IconArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => router.history.forward()}
          disabled={!canGoForward}
          className="rounded-md border border-transparent p-1.5 text-muted transition hover:bg-panel hover:text-ink disabled:cursor-default disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-muted"
          title="Forward (⌘] or Alt+→)"
          aria-label="Go forward"
        >
          <IconArrowRight className="h-4 w-4" />
        </button>
      </div>

      <div className="md:hidden">
        <select
          value={activeId ?? ""}
          onChange={(event) => {
            selectNotebook(event.target.value || null);
            navigate({ view: "journal" });
          }}
          className="max-w-[8.5rem] rounded-md border border-line bg-white/70 px-2 py-1 text-[14px] outline-none sm:max-w-[11rem]"
          aria-label="Notebook"
        >
          <option value="">No notebook</option>
          {notebooks.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>

      <div className="hidden min-w-0 items-center gap-2 md:flex">
        <IconBook className="h-3.5 w-3.5 shrink-0 text-faint" />
        <span className="truncate font-sans text-[14px] font-medium text-ink-soft">
          {notebook?.name ?? "No notebook selected"}
        </span>
        {notebook && (
          <>
            <span className="text-faint">·</span>
            <span className="shrink-0 text-[14px] text-muted">
              {notebook.note_count} {notebook.note_count === 1 ? "note" : "notes"}
            </span>
          </>
        )}
      </div>

      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
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
          className="hidden items-center gap-1.5 rounded-full border border-line bg-white/60 px-2.5 py-1 text-[14px] font-medium uppercase tracking-[0.1em] text-muted sm:inline-flex"
          title="Reads and writes go through the server's MnesticDB index"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-mint" />
          Datalog index
        </span>
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
