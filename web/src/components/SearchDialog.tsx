import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import type { NoteSummary } from "../api/types";
import { formatJournalDate } from "../lib/journal";
import { bindingLabel } from "../lib/shortcuts";
import { settingsAtom } from "../lib/settings";
import { useAppNavigate } from "../lib/appNavigation";
import { IconCalendar, IconFile, IconSearch, IconX } from "./Icons";
import {
  activeNotebookAtom,
  activeNotebookIdAtom,
  searchOpenAtom,
} from "../state/atoms";

export function SearchDialog() {
  const open = useAtomValue(searchOpenAtom);
  const setOpen = useSetAtom(searchOpenAtom);
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const notebook = useAtomValue(activeNotebookAtom);
  const settings = useAtomValue(settingsAtom);
  const navigate = useAppNavigate();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteSummary[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const trimmed = query.trim();
  const terms = useMemo(() => searchTerms(trimmed), [trimmed]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults([]);
    setSelected(0);
    setError(null);
    setLoading(false);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!notebookId || !trimmed) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const found = await api.searchNotes(notebookId, trimmed, 30);
        if (cancelled) return;
        setResults(found);
        setSelected(0);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setResults([]);
        setError(
          cause instanceof Error ? cause.message : "Could not search notes",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 160);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, notebookId, trimmed]);

  const openNote = useCallback(
    (note: NoteSummary) => {
      navigate({ view: "note", noteId: note.id });
      setOpen(false);
    },
    [navigate, setOpen],
  );

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((index) =>
          results.length === 0 ? 0 : (index + 1) % results.length,
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((index) =>
          results.length === 0
            ? 0
            : (index - 1 + results.length) % results.length,
        );
        return;
      }
      if (event.key === "Enter" && !event.isComposing) {
        const note = results[selected];
        if (!note) return;
        event.preventDefault();
        openNote(note);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, results, selected, setOpen, openNote]);

  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-result-index="${selected}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [open, selected]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 px-4 pt-[10vh] backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        className="animate-fade-up flex max-h-[min(34rem,80vh)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-canvas shadow-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search notes"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
          <IconSearch className="h-4 w-4 shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              notebook ? `Search ${notebook.name}…` : "Search notes…"
            }
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent font-sans text-[16px] text-ink outline-none placeholder:text-faint"
            aria-label="Search query"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="rounded p-0.5 text-faint transition hover:text-ink"
              aria-label="Clear search"
            >
              <IconX className="h-3.5 w-3.5" />
            </button>
          )}
          <kbd className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[14px] text-faint">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {!notebookId ? (
            <SearchHint>Select a notebook to search its notes.</SearchHint>
          ) : !trimmed ? (
            <div className="px-3 py-8 text-center">
              <IconSearch className="mx-auto h-6 w-6 text-accent/60" />
              <p className="mt-2 font-sans text-[14px] text-ink-soft">
                Search {notebook?.name ?? "this notebook"}
              </p>
              <p className="mx-auto mt-1 max-w-xs font-sans text-[14px] leading-relaxed text-faint">
                Titles, body text, tags and wikilinks. Results open in the
                page editor.
              </p>
            </div>
          ) : loading ? (
            <SearchHint>Searching…</SearchHint>
          ) : error ? (
            <p className="mx-1 rounded-lg bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
              {error}
            </p>
          ) : results.length === 0 ? (
            <SearchHint>No notes match “{trimmed}”.</SearchHint>
          ) : (
            <>
              <div className="flex items-center justify-between px-2 pb-1 pt-1 font-mono text-[14px] uppercase tracking-[0.12em] text-faint">
                <span>
                  {results.length} {results.length === 1 ? "result" : "results"}
                </span>
                <span>{notebook?.name}</span>
              </div>
              {results.map((note, index) => {
                const journal = note.id.startsWith("journals/");
                return (
                  <button
                    key={note.id}
                    type="button"
                    data-result-index={index}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => openNote(note)}
                    className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
                      index === selected
                        ? "bg-accent-soft/70"
                        : "hover:bg-panel"
                    }`}
                  >
                    <span
                      className={`mt-0.5 shrink-0 ${
                        index === selected ? "text-accent" : "text-faint"
                      }`}
                    >
                      {journal ? (
                        <IconCalendar className="h-3.5 w-3.5" />
                      ) : (
                        <IconFile className="h-3.5 w-3.5" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-sans text-[14px] font-medium text-ink">
                        <Highlight
                          text={journal ? formatJournalDate(note.title) : note.title}
                          terms={terms}
                        />
                      </span>
                      <span className="mt-0.5 line-clamp-2 font-sans text-[14px] leading-relaxed text-muted">
                        <Highlight
                          text={note.excerpt || note.id}
                          terms={terms}
                        />
                      </span>
                    </span>
                    <span className="max-w-[35%] shrink-0 truncate pt-0.5 font-mono text-[14px] text-faint">
                      <Highlight text={note.id} terms={terms} />
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3 border-t border-line px-3 py-2 font-mono text-[14px] text-faint">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span className="ml-auto inline-flex items-center gap-1">
            <kbd className="rounded border border-line bg-panel px-1 py-0.5">
              {bindingLabel("nav.search", settings.keybindings)}
            </kbd>
            search
          </span>
        </div>
      </div>
    </div>
  );
}

function searchTerms(query: string): string[] {
  if (!query) return [];
  return [
    ...new Set(
      query
        .split(/[^\p{L}\p{N}_]+/u)
        .filter(Boolean)
        .map((term) => term.toLocaleLowerCase()),
    ),
  ].sort((left, right) => right.length - left.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  const pattern = new RegExp(
    `(${terms.map(escapeRegExp).join("|")})`,
    "giu",
  );
  const needles = new Set(terms);
  return (
    <>
      {text.split(pattern).map((part, index) =>
        needles.has(part.toLocaleLowerCase()) ? (
          <mark
            key={`${part}-${index}`}
            className="rounded-sm bg-mark px-0.5 font-semibold text-ink"
          >
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function SearchHint({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 py-6 text-center font-sans text-[14px] leading-relaxed text-faint">
      {children}
    </p>
  );
}
