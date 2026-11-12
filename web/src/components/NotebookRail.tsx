import { useEffect, useState, type FormEvent } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import { IconBook, IconPlus, IconSettings, IconTrash } from "./Icons";
import {
  activeNoteIdAtom,
  activeNotebookIdAtom,
  notebooksAtom,
  readOnlyAtom,
  refreshAtom,
  searchQueryAtom,
  settingsOpenAtom,
} from "../state/atoms";

export function NotebookRail() {
  const notebooks = useAtomValue(notebooksAtom);
  const activeId = useAtomValue(activeNotebookIdAtom);
  const setActiveId = useSetAtom(activeNotebookIdAtom);
  const setActiveNote = useSetAtom(activeNoteIdAtom);
  const setSearch = useSetAtom(searchQueryAtom);
  const refresh = useSetAtom(refreshAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const locked = useAtomValue(readOnlyAtom);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!adding) {
      setName("");
      setError(null);
    }
  }, [adding]);

  async function createNotebook(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setError(null);
    try {
      const notebook = await api.createNotebook({ name: trimmed });
      setAdding(false);
      setActiveId(notebook.id);
      setActiveNote(null);
      setSearch("");
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create notebook");
    } finally {
      setBusy(false);
    }
  }

  function selectNotebook(id: string) {
    if (id === activeId) return;
    setActiveId(id);
    setActiveNote(null);
    setSearch("");
  }

  async function removeNotebook(id: string, label: string) {
    if (
      !window.confirm(
        `Delete “${label}” and every note inside it? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      await api.deleteNotebook(id);
      if (id === activeId) {
        setActiveId(null);
        setActiveNote(null);
      }
      refresh();
    } catch (cause) {
      window.alert(
        cause instanceof Error ? cause.message : "Could not delete notebook",
      );
    }
  }

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-panel/60 md:flex">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink text-canvas shadow-sm">
          <IconBook className="h-4.5 w-4.5" width={18} height={18} />
        </span>
        <div className="min-w-0">
          <div className="font-serif text-[17px] leading-tight text-ink">
            Opal Note
          </div>
          <div className="text-[9px] font-medium uppercase tracking-[0.2em] text-faint">
            Datalog notebook
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between px-4 pb-1.5 pt-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
          Notebooks
        </span>
        <button
          type="button"
          onClick={() => setAdding((open) => !open)}
          disabled={locked}
          className="rounded-md p-1 text-muted transition hover:bg-panel-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="New notebook"
          title={locked ? "Unlock editing to create notebooks" : "New notebook"}
        >
          <IconPlus className="h-4 w-4" />
        </button>
      </div>

      {adding && !locked && (
        <form
          onSubmit={createNotebook}
          className="animate-fade-up mx-2 mb-2 rounded-xl border border-line bg-white/80 p-2 shadow-sm"
        >
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Notebook name"
            maxLength={120}
            className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
          {error && <p className="mt-1 px-0.5 text-[11px] text-danger">{error}</p>}
          <div className="mt-2 flex items-center gap-1.5">
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="rounded-md bg-ink px-2.5 py-1 text-[11px] font-medium text-canvas transition hover:bg-ink-soft disabled:opacity-40"
            >
              {busy ? "Adding…" : "Add"}
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="rounded-md px-2 py-1 text-[11px] text-muted transition hover:bg-panel-strong"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {notebooks.length === 0 && !adding && (
          <div className="mx-1 mt-2 rounded-xl border border-dashed border-line-strong px-3 py-6 text-center">
            <p className="text-xs text-muted">No notebooks yet.</p>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="mt-2 text-xs font-medium text-accent-strong underline underline-offset-2"
            >
              Create the first one
            </button>
          </div>
        )}

        {notebooks.map((notebook) => {
          const active = notebook.id === activeId;
          return (
            <div key={notebook.id} className="group relative">
              <button
                type="button"
                onClick={() => selectNotebook(notebook.id)}
                className={`w-full rounded-lg px-2.5 py-2 pr-8 text-left transition ${
                  active
                    ? "border border-line bg-white shadow-sm"
                    : "border border-transparent hover:bg-panel-strong/70"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      active ? "bg-accent" : "bg-line-strong"
                    }`}
                  />
                  <span className="truncate font-mono text-[12.5px] font-medium text-ink-soft">
                    {notebook.name}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
                    {notebook.note_count}
                  </span>
                </div>
                {notebook.description && (
                  <p className="mt-0.5 truncate pl-3.5 font-mono text-[10px] text-muted">
                    {notebook.description}
                  </p>
                )}
              </button>
              <button
                type="button"
                onClick={() => removeNotebook(notebook.id, notebook.name)}
                disabled={locked}
                className="absolute right-1.5 top-2.5 hidden rounded-md p-1 text-faint transition hover:bg-danger/10 hover:text-danger group-hover:block disabled:cursor-not-allowed disabled:opacity-30"
                aria-label={`Delete ${notebook.name}`}
                title="Delete notebook"
              >
                <IconTrash className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-line px-2 py-2.5">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[11.5px] text-muted transition hover:bg-panel-strong hover:text-ink"
        >
          <IconSettings className="h-3.5 w-3.5" />
          Connection settings
        </button>
        <p className="mt-1 px-2 font-mono text-[9.5px] tracking-wide text-faint">
          mnesticdb · rocksdb
        </p>
      </div>
    </aside>
  );
}
