import { useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import { relativeTime } from "../lib/format";
import { IconPlus, IconSearch, IconX } from "./Icons";
import {
  activeNoteIdAtom,
  activeNotebookIdAtom,
  notesAtom,
  readOnlyAtom,
  refreshAtom,
  searchQueryAtom,
} from "../state/atoms";

export function NotesPanel() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const notes = useAtomValue(notesAtom);
  const activeNoteId = useAtomValue(activeNoteIdAtom);
  const search = useAtomValue(searchQueryAtom);
  const setActiveNote = useSetAtom(activeNoteIdAtom);
  const setSearch = useSetAtom(searchQueryAtom);
  const refresh = useSetAtom(refreshAtom);
  const locked = useAtomValue(readOnlyAtom);

  const [query, setQuery] = useState(search);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce keystrokes into the query atom the server-facing atom reads.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query, setSearch]);

  useEffect(() => {
    setQuery("");
    setSearch("");
  }, [notebookId, setSearch]);

  // Keep a sensible selection: first note of a notebook, but never yank the
  // user away from the note they are reading while a search is active.
  useEffect(() => {
    if (!notebookId) return;
    if (notes.length === 0) {
      if (activeNoteId) setActiveNote(null);
      return;
    }
    if (activeNoteId && notes.some((note) => note.id === activeNoteId)) return;
    if (search.trim() && activeNoteId) return;
    setActiveNote(notes[0]?.id ?? null);
  }, [notes, activeNoteId, notebookId, search, setActiveNote]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function createNote() {
    if (!notebookId || creating || locked) return;
    setCreating(true);
    try {
      const note = await api.createNote(notebookId, {
        title: "Untitled",
        content: "",
      });
      setQuery("");
      setSearch("");
      setActiveNote(note.id);
      refresh();
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : "Could not create note");
    } finally {
      setCreating(false);
    }
  }

  const searching = search.trim().length > 0;

  return (
    <section className="flex w-[18.5rem] shrink-0 flex-col border-r border-line bg-canvas/50">
      <div className="px-3 pb-2.5 pt-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
            Notes
            <span className="ml-1.5 font-mono text-[10px] tracking-normal text-line-strong">
              {notebookId ? notes.length : 0}
            </span>
          </h2>
          <button
            type="button"
            onClick={createNote}
            disabled={!notebookId || creating || locked}
            title={locked ? "Unlock editing to create notes" : "New note"}
            className="flex items-center gap-1 rounded-md border border-line bg-white/70 px-1.5 py-1 text-[10px] font-medium text-ink-soft transition hover:border-line-strong hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <IconPlus className="h-3 w-3" />
            New
          </button>
        </div>

        <div className="relative mt-2">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search notes…"
            className="w-full rounded-lg border border-line bg-white/70 py-1.5 pl-8 pr-12 font-mono text-[12px] outline-none transition placeholder:text-faint focus:border-accent/60 focus:bg-white"
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setSearch("");
              }}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-faint hover:text-ink"
              aria-label="Clear search"
            >
              <IconX className="h-3 w-3" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-line bg-panel px-1 py-0.5 font-mono text-[9px] text-faint">
              ⌘K
            </kbd>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!notebookId && (
          <p className="mx-1 mt-4 rounded-xl border border-dashed border-line-strong px-3 py-5 text-center text-[11.5px] leading-relaxed text-muted">
            Pick a notebook, or create one in the sidebar to start writing.
          </p>
        )}

        {notebookId && notes.length === 0 && (
          <div className="mx-1 mt-4 rounded-xl border border-dashed border-line-strong px-3 py-5 text-center">
            <p className="text-[11.5px] leading-relaxed text-muted">
              {searching
                ? `Nothing matches “${search.trim()}”.`
                : "This notebook is empty."}
            </p>
            {!searching && (
              <button
                type="button"
                onClick={createNote}
                disabled={locked}
                className="mt-2 text-[11.5px] font-medium text-accent-strong underline underline-offset-2 disabled:opacity-40"
              >
                Write the first note
              </button>
            )}
          </div>
        )}

        <div className="space-y-1">
          {notes.map((note) => {
            const active = note.id === activeNoteId;
            return (
              <button
                key={note.id}
                type="button"
                onClick={() => setActiveNote(note.id)}
                className={`w-full rounded-xl border px-2.5 py-2 text-left transition ${
                  active
                    ? "border-accent/25 bg-accent-soft/60 shadow-sm"
                    : "border-transparent hover:border-line hover:bg-white/60"
                }`}
              >
                <div className="flex items-baseline gap-2">
                  <span
                    className={`truncate font-mono text-[12px] font-medium ${
                      active ? "text-accent-strong" : "text-ink-soft"
                    }`}
                  >
                    {note.title}
                  </span>
                  {note.score !== undefined && (
                    <span
                      className="ml-auto shrink-0 rounded bg-white/70 px-1 font-mono text-[9px] text-faint"
                      title="BM25 relevance"
                    >
                      {note.score.toFixed(2)}
                    </span>
                  )}
                </div>
                {note.excerpt && (
                  <p className="mt-0.5 line-clamp-2 font-mono text-[10px] leading-snug text-muted">
                    {note.excerpt}
                  </p>
                )}
                <div className="mt-1 flex items-center gap-1 overflow-hidden">
                  {note.tags.slice(0, 2).map((tag) => (
                    <span
                      key={tag}
                      className="shrink-0 rounded bg-panel px-1 py-0.5 font-mono text-[8.5px] text-muted"
                    >
                      #{tag}
                    </span>
                  ))}
                  {note.tags.length > 2 && (
                    <span className="font-mono text-[8.5px] text-faint">
                      +{note.tags.length - 2}
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-[9px] text-faint">
                    {relativeTime(note.updated_at)}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-t border-line px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
        {searching ? "FTS results" : "Recently updated"}
      </div>
    </section>
  );
}
