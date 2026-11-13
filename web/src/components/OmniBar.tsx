import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAtom, useAtomValue } from "jotai";

import { api } from "../api/client";
import type { NoteSummary, TagCount } from "../api/types";
import { formatJournalDate } from "../lib/journal";
import { useAppNavigate } from "../lib/appNavigation";
import { bindingLabel } from "../lib/shortcuts";
import { settingsAtom } from "../lib/settings";
import {
  activeNotebookIdAtom,
  notesRevisionAtom,
  omniFocusRequestAtom,
  omniQueryAtom,
} from "../state/atoms";
import { IconCalendar, IconFile, IconSearch, IconTag, IconX } from "./Icons";

export function OmniBar() {
  const [query, setQuery] = useAtom(omniQueryAtom);
  const focusRequest = useAtomValue(omniFocusRequestAtom);
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const revision = useAtomValue(notesRevisionAtom);
  const settings = useAtomValue(settingsAtom);
  const navigate = useAppNavigate();

  const [tags, setTags] = useState<TagCount[]>([]);
  const [results, setResults] = useState<NoteSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const trimmed = query.trim();
  const tagMode = trimmed.startsWith("#");
  const tagQuery = tagMode ? trimmed.slice(1).toLowerCase() : "";
  const terms = useMemo(
    () => searchTerms(tagMode ? tagQuery : trimmed),
    [tagMode, tagQuery, trimmed],
  );

  const tagResults = useMemo(() => {
    if (!tagMode) return [];
    return tags
      .filter((tag) => tag.tag.includes(tagQuery))
      .sort(
        (left, right) =>
          right.count - left.count || left.tag.localeCompare(right.tag),
      );
  }, [tagMode, tagQuery, tags]);

  const searchBinding = bindingLabel(
    "nav.search",
    settings.keybindings,
  ).split(" / ")[0];

  useEffect(() => {
    if (!notebookId) {
      setTags([]);
      return;
    }
    let cancelled = false;
    api
      .listTags(notebookId)
      .then((next) => {
        if (!cancelled) setTags(next);
      })
      .catch(() => {
        if (!cancelled) setTags([]);
      });
    return () => {
      cancelled = true;
    };
  }, [notebookId, revision]);

  useEffect(() => {
    if (!open || !notebookId || !trimmed || tagMode) {
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
  }, [notebookId, open, tagMode, trimmed]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    if (focusRequest === 0) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
    if (query.trim()) setOpen(true);
  }, [focusRequest]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-omni-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, selected]);

  const openNote = useCallback(
    (note: NoteSummary) => {
      setQuery("");
      setOpen(false);
      navigate({ view: "note", noteId: note.id });
    },
    [navigate, setQuery],
  );

  const openTag = useCallback(
    (tag: string) => {
      setQuery(`#${tag}`);
      setOpen(false);
      navigate({ view: "tag", tag });
    },
    [navigate, setQuery],
  );

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const length = tagMode ? tagResults.length : results.length;
      if (length === 0) return;
      event.preventDefault();
      setSelected((current) =>
        event.key === "ArrowDown"
          ? (current + 1) % length
          : (current - 1 + length) % length,
      );
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      if (tagMode) {
        const tag = tagResults[selected];
        if (!tag) return;
        event.preventDefault();
        openTag(tag.tag);
      } else {
        const note = results[selected];
        if (!note) return;
        event.preventDefault();
        openNote(note);
      }
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative w-full min-w-0 max-w-none sm:w-[clamp(18rem,45vw,36rem)]"
    >
      <div className="flex h-8 min-w-0 items-center gap-2 rounded-lg border border-line bg-white/60 px-2.5 transition focus-within:border-accent focus-within:bg-white">
        <IconSearch className="h-3.5 w-3.5 shrink-0 text-faint" />
        <input
          id="omni-bar-input"
          ref={inputRef}
          value={query}
          onChange={(event) => {
            const next = event.target.value;
            setQuery(next);
            setOpen(next.trim().length > 0);
          }}
          onFocus={() => {
            if (query.trim()) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search notes or #tag…"
          spellCheck={false}
          autoComplete="off"
          aria-label="Search notes or tags"
          className="min-w-0 flex-1 bg-transparent font-sans text-[14px] text-ink outline-none placeholder:text-faint"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setOpen(false);
              inputRef.current?.focus();
            }}
            className="shrink-0 rounded p-0.5 text-faint transition hover:text-ink"
            aria-label="Clear omni search"
          >
            <IconX className="h-3 w-3" />
          </button>
        )}
        <kbd className="hidden shrink-0 rounded border border-line bg-panel px-1 py-0.5 font-mono text-[12px] text-faint xl:inline">
          {searchBinding}
        </kbd>
      </div>

      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+0.35rem)] z-50 flex max-h-[min(30rem,70vh)] flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-panel">
          <div
            ref={listRef}
            className="min-h-0 flex-1 overflow-y-auto p-1.5"
          >
            {!notebookId ? (
              <OmniHint>Select a notebook to search its notes and tags.</OmniHint>
            ) : tagMode ? (
              tagResults.length === 0 ? (
                <OmniHint>No tags match #{tagQuery}.</OmniHint>
              ) : (
                <>
                  <div className="flex items-center justify-between px-2 pb-1 pt-1 font-mono text-[14px] uppercase tracking-[0.12em] text-faint">
                    <span>Tags</span>
                    <span>{tagResults.length}</span>
                  </div>
                  {tagResults.map((tag, index) => (
                    <button
                      key={tag.tag}
                      type="button"
                      data-omni-index={index}
                      onMouseEnter={() => setSelected(index)}
                      onClick={() => openTag(tag.tag)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
                        index === selected
                          ? "bg-accent-soft/70"
                          : "hover:bg-panel"
                      }`}
                    >
                      <IconTag
                        className={`h-3.5 w-3.5 shrink-0 ${
                          index === selected ? "text-accent" : "text-faint"
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-[14px] text-ink">
                        #{tag.tag}
                      </span>
                      <span className="shrink-0 font-mono text-[14px] text-faint">
                        {tag.count}
                      </span>
                    </button>
                  ))}
                </>
              )
            ) : loading ? (
              <OmniHint>Searching…</OmniHint>
            ) : error ? (
              <p className="mx-1 rounded-lg bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
                {error}
              </p>
            ) : results.length === 0 ? (
              <OmniHint>No notes match “{trimmed}”.</OmniHint>
            ) : (
              <>
                <div className="flex items-center justify-between px-2 pb-1 pt-1 font-mono text-[14px] uppercase tracking-[0.12em] text-faint">
                  <span>
                    {results.length} {results.length === 1 ? "result" : "results"}
                  </span>
                  <span>Notes</span>
                </div>
                {results.map((note, index) => {
                  const journal = note.id.startsWith("journals/");
                  return (
                    <button
                      key={note.id}
                      type="button"
                      data-omni-index={index}
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
                            text={
                              journal
                                ? formatJournalDate(note.title)
                                : note.title
                            }
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
                esc
              </kbd>
              close
            </span>
          </div>
        </div>
      )}
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

function OmniHint({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 py-6 text-center font-sans text-[14px] leading-relaxed text-faint">
      {children}
    </p>
  );
}
