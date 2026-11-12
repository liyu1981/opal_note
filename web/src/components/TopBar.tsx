import { useAtomValue, useSetAtom } from "jotai";

import { IconBook, IconLock, IconSettings } from "./Icons";
import {
  activeNoteIdAtom,
  activeNotebookAtom,
  activeNotebookIdAtom,
  notebooksAtom,
  readOnlyAtom,
  searchQueryAtom,
  settingsOpenAtom,
} from "../state/atoms";

export function TopBar() {
  const notebooks = useAtomValue(notebooksAtom);
  const notebook = useAtomValue(activeNotebookAtom);
  const activeId = useAtomValue(activeNotebookIdAtom);
  const setActiveId = useSetAtom(activeNotebookIdAtom);
  const setActiveNote = useSetAtom(activeNoteIdAtom);
  const setSearch = useSetAtom(searchQueryAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const locked = useAtomValue(readOnlyAtom);
  const setLocked = useSetAtom(readOnlyAtom);

  return (
    <header className="flex h-13 shrink-0 items-center gap-3 border-b border-line bg-canvas/80 px-4 backdrop-blur">
      <div className="md:hidden">
        <select
          value={activeId ?? ""}
          onChange={(event) => {
            setActiveId(event.target.value || null);
            setActiveNote(null);
            setSearch("");
          }}
          className="max-w-[11rem] rounded-md border border-line bg-white/70 px-2 py-1 text-xs outline-none"
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
        <span className="truncate font-mono text-[12px] font-medium text-ink-soft">
          {notebook?.name ?? "No notebook selected"}
        </span>
        {notebook && (
          <>
            <span className="text-faint">·</span>
            <span className="shrink-0 text-[10.5px] text-muted">
              {notebook.note_count} {notebook.note_count === 1 ? "note" : "notes"}
            </span>
          </>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
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
          className="hidden items-center gap-1.5 rounded-full border border-line bg-white/60 px-2.5 py-1 text-[9.5px] font-medium uppercase tracking-[0.1em] text-muted sm:inline-flex"
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
