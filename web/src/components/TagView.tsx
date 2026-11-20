import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import type { JournalPage, Note, PageOverview } from "../api/types";
import { formatJournalDate } from "../lib/journal";
import { useAppNavigate } from "../lib/appNavigation";
import { filterTerms, matchesFilter } from "../lib/filter";
import { useViewAutoFocus } from "../lib/useViewFocus";
import {
  fencedLines,
  noteLinkKeys,
  normalizeLinkTarget,
} from "../lib/markdown";
import {
  activeNoteIdAtom,
  activeNotebookIdAtom,
  assetsViewAtom,
  homeViewAtom,
  notesAtom,
  notesRevisionAtom,
  omniQueryAtom,
  readOnlyAtom,
  trashViewAtom,
} from "../state/atoms";
import { IconCalendar, IconFile } from "./Icons";
import { JournalCard, type JournalCardHandle } from "./JournalCard";
import { ListFilter } from "./ListFilter";

type TagPage = {
  page: PageOverview;
  note: Note | null;
};

function pageTitle(page: PageOverview): string {
  return page.id.startsWith("journals/")
    ? formatJournalDate(page.title)
    : page.title;
}

export function TagView({ tag: rawTag }: { tag: string }) {
  const tag = rawTag.trim().replace(/^#/u, "").toLowerCase();
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const notes = useAtomValue(notesAtom);
  const revision = useAtomValue(notesRevisionAtom);
  const locked = useAtomValue(readOnlyAtom);
  const setActiveNote = useSetAtom(activeNoteIdAtom);
  const setHomeView = useSetAtom(homeViewAtom);
  const setAssetsView = useSetAtom(assetsViewAtom);
  const setTrashView = useSetAtom(trashViewAtom);
  const setOmniQuery = useSetAtom(omniQueryAtom);
  const navigate = useAppNavigate();

  const [pages, setPages] = useState<PageOverview[]>([]);
  const [cards, setCards] = useState<TagPage[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const firstCardRef = useRef<JournalCardHandle>(null);
  const firstFallbackRef = useRef<HTMLButtonElement>(null);
  const cardRefs = useRef<Array<JournalCardHandle | null>>([]);
  const fallbackRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Only entries already loaded for this tag are filtered; the server query
  // stays untouched.
  const terms = useMemo(() => filterTerms(filter), [filter]);
  const visible = useMemo(
    () =>
      cards
        .map((item) => {
          const block = item.note ? findTaggedBlock(item.note.content, tag) : null;
          return { item, block };
        })
        .filter(({ item, block }) =>
          matchesFilter(
            `${pageTitle(item.page)}\n${block?.text ?? item.note?.content ?? ""}`,
            terms,
          ),
        ),
    [cards, tag, terms],
  );

  useViewAutoFocus(
    "tag",
    () => {
      if (firstCardRef.current) firstCardRef.current.focus();
      else firstFallbackRef.current?.focus();
    },
    visible.length > 0,
    tag,
  );

  const linkTargets = useMemo(
    () => notes.map((note) => ({ title: note.title, path: note.id })),
    [notes],
  );
  const linkKeys = useMemo(
    () => new Set(notes.flatMap((note) => noteLinkKeys(note.title, note.id))),
    [notes],
  );

  useLayoutEffect(() => {
    setHomeView(false);
    setAssetsView(false);
    setTrashView(false);
    setActiveNote(null);
  }, [setActiveNote, setAssetsView, setHomeView, setTrashView]);

  useEffect(() => {
    setOmniQuery(tag ? `#${tag}` : "");
    return () => setOmniQuery("");
  }, [setOmniQuery, tag]);

  // A filter typed for one tag should not hide another tag's entries.
  useEffect(() => {
    setFilter("");
  }, [tag]);

  useEffect(() => {
    if (!notebookId || !tag) {
      setPages([]);
      setCards([]);
      setTotal(0);
      setLoading(false);
      return;
    }

    let cancelled = false;
    // Drop the previous tag's rows before loading the new tag. Otherwise an
    // outgoing tag can satisfy the focus handoff with stale cards.
    setPages([]);
    setCards([]);
    setTotal(0);
    cardRefs.current = [];
    fallbackRefs.current = [];
    firstCardRef.current = null;
    firstFallbackRef.current = null;
    setLoading(true);
    setFocused(null);
    api
      .listPages(notebookId, {
        tag,
        limit: 200,
        sort: "updated_at",
        dir: "desc",
      })
      .then(async (result) => {
        const loaded = await Promise.all(
          result.pages.map(async (page) => {
            try {
              return { page, note: await api.getNote(notebookId, page.id) };
            } catch {
              return { page, note: null };
            }
          }),
        );
        if (cancelled) return;
        setPages(result.pages);
        setCards(loaded);
        setTotal(result.total);
        setError(null);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(
          cause instanceof Error ? cause.message : "Could not load tag pages",
        );
        setPages([]);
        setCards([]);
        setTotal(0);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [notebookId, revision, tag]);

  function focusPage(index: number, edge: "start" | "end"): boolean {
    const card = cardRefs.current[index];
    if (card) {
      if (edge === "start") card.focusStart();
      else card.focusEnd();
      return true;
    }
    const fallback = fallbackRefs.current[index];
    if (!fallback) return false;
    fallback.focus();
    return true;
  }

  function focusSibling(index: number, direction: "up" | "down"): boolean {
    const next = direction === "down" ? index + 1 : index - 1;
    if (next < 0 || next >= visible.length) return false;
    return focusPage(next, direction === "down" ? "start" : "end");
  }

  function openWiki(target: string) {
    const needle = normalizeLinkTarget(target);
    const hit = notes.find((note) =>
      noteLinkKeys(note.title, note.id).includes(needle),
    );
    if (hit) navigate({ view: "note", noteId: hit.id });
  }

  function openTag(next: string) {
    navigate({ view: "tag", tag: next });
  }

  function jumpTo(index: number) {
    setFocused(index);
    document
      .getElementById(`tag-page-${index}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-transparent">
      <div className="relative mx-auto grid w-full max-w-7xl grid-cols-1 gap-6 px-6 py-5 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="min-w-0">
          <div className="relative">
            <ListFilter
              value={filter}
              onChange={setFilter}
              matched={visible.length}
              total={cards.length}
              className="mb-3"
            />

            <div className="space-y-3">
              {error && (
                <p className="rounded-lg bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
                  {error}
                </p>
              )}

              {loading ? (
                <div className="space-y-3">
                  {[0, 1, 2].map((index) => (
                    <div
                      key={index}
                      className="h-32 animate-pulse rounded-xl border border-line bg-panel/30"
                    />
                  ))}
                </div>
              ) : cards.length === 0 ? (
                <div className="rounded-xl border border-line bg-white/30 px-4 py-12 text-center">
                  <p className="font-sans text-[14px] text-muted">
                    No pages tagged #{tag}.
                  </p>
                </div>
              ) : visible.length === 0 ? (
                <div className="rounded-xl border border-line bg-white/30 px-4 py-12 text-center">
                  <p className="font-sans text-[14px] text-muted">
                    No loaded entries match “{filter.trim()}”.
                  </p>
                  <p className="mt-1 font-mono text-[14px] text-faint">
                    Showing the {cards.length} most recently updated pages only.
                  </p>
                </div>
              ) : (
                visible.map(({ item, block }, index) => {
                  const note = item.note;
                  if (!note || !block) {
                    return (
                      <article
                        key={item.page.id}
                        id={`tag-page-${index}`}
                        ref={(node) => {
                          fallbackRefs.current[index] =
                            node?.querySelector<HTMLButtonElement>("button") ?? null;
                          if (index === 0) {
                            firstFallbackRef.current = fallbackRefs.current[index];
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
                            return;
                          }
                          const direction =
                            event.key === "ArrowDown" ? "down" : "up";
                          if (focusSibling(index, direction)) {
                            event.preventDefault();
                          }
                        }}
                        className="scroll-mt-4 rounded-xl border border-line bg-paper p-4"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            navigate({ view: "note", noteId: item.page.id })
                          }
                          className="font-serif text-[20px] font-semibold text-ink hover:text-accent-strong"
                        >
                          {pageTitle(item.page)}
                        </button>
                        <p className="mt-2 font-sans text-[14px] text-faint">
                          {note
                            ? "No tagged block found in the page body."
                            : "Page content is unavailable."}
                        </p>
                      </article>
                    );
                  }

                  return (
                    <div
                      key={item.page.id}
                      id={`tag-page-${index}`}
                      className={`scroll-mt-4 rounded-xl transition ${
                        focused === index ? "ring-1 ring-accent/40" : ""
                      }`}
                    >
                      <JournalCard
                        ref={(node) => {
                          cardRefs.current[index] = node;
                          if (index === 0) firstCardRef.current = node;
                        }}
                        page={toJournalPage(item, block.text)}
                        notebookId={notebookId ?? ""}
                        linkKeys={linkKeys}
                        linkTargets={linkTargets}
                        readOnly={locked}
                        onOpenPage={(page) =>
                          navigate({ view: "note", noteId: page.id })
                        }
                        onWikiLink={openWiki}
                        onTag={openTag}
                        onNavigate={(direction) => focusSibling(index, direction)}
                        saveContent={(body) =>
                          api.updateNote(notebookId ?? "", item.page.id, {
                            content: replaceTaggedBlock(note.content, block, body),
                          })
                        }
                      />
                    </div>
                  );
                })
              )}

              {!loading && total > pages.length && (
                <p className="pt-1 text-center font-mono text-[14px] text-faint">
                  Showing the {pages.length} most recently updated of {total} pages.
                </p>
              )}
            </div>
          </div>
        </div>

        <aside className="sticky top-5 hidden max-h-[calc(100vh-5rem)] self-start overflow-y-auto rounded-xl border border-line bg-panel/85 px-3 py-4 shadow-panel backdrop-blur lg:block">
          <div className="flex items-center justify-between px-1.5">
            <p className="font-mono text-[14px] font-semibold uppercase tracking-[0.12em] text-faint">
              Pages
            </p>
            <span className="font-mono text-[14px] text-faint">{total}</span>
          </div>
          <div className="mt-2 space-y-0.5">
            {visible.map(({ item }, index) => (
              <button
                key={item.page.id}
                type="button"
                onClick={() => jumpTo(index)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left font-sans text-[14px] text-ink-soft transition hover:bg-white/70 hover:text-ink"
                title={pageTitle(item.page)}
              >
                {item.page.id.startsWith("journals/") ? (
                  <IconCalendar className="h-3 w-3 shrink-0 text-faint" />
                ) : (
                  <IconFile className="h-3 w-3 shrink-0 text-faint" />
                )}
                <span className="truncate">{pageTitle(item.page)}</span>
              </button>
            ))}
            {filter.trim() && cards.length > 0 && (
              <p className="px-1.5 pt-1 font-mono text-[14px] text-faint">
                {visible.length} of {cards.length} loaded
              </p>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}


type TagBlock = {
  start: number;
  end: number;
  text: string;
};

function toJournalPage(item: TagPage, content: string): JournalPage {
  const note = item.note;
  return {
    id: item.page.id,
    notebook_id: item.page.notebook_id,
    title: item.page.title,
    content,
    created_at: item.page.created_at,
    updated_at: note?.updated_at ?? item.page.updated_at,
    tags: note?.tags ?? item.page.tags,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findTaggedBlock(content: string, tag: string): TagBlock | null {
  const lines = content.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }

  const matcher = new RegExp(
    `(^|[\\s([{,])#${escapeRegExp(tag)}(?![\\p{L}\\p{N}_./-])`,
    "iu",
  );
  const indentOf = (line: string) => line.match(/^\s*/u)?.[0].length ?? 0;
  const inCode = fencedLines(lines);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (inCode[index] || !matcher.test(line)) continue;

    const indent = indentOf(line);
    const isList = /^\s*(?:[-*+]|\d+[.)])\s+/u.test(line);
    let end = index;

    for (let next = index + 1; next < lines.length; next += 1) {
      const nextLine = lines[next] ?? "";
      if (!nextLine.trim()) break;
      const nextIndent = indentOf(nextLine);
      if (nextIndent <= indent) break;
      end = next;
    }

    if (!isList) {
      for (let next = index + 1; next < lines.length; next += 1) {
        const nextLine = lines[next] ?? "";
        if (!nextLine.trim()) break;
        if (/^\s*(?:[-*+]|\d+[.)])\s+/u.test(nextLine)) break;
        if (/^\s*#{1,6}\s+/u.test(nextLine)) break;
        if (indentOf(nextLine) < indent) break;
        end = next;
      }
    }

    const start = starts[index] ?? 0;
    const blockEnd = (starts[end] ?? start) + (lines[end]?.length ?? 0);
    return { start, end: blockEnd, text: content.slice(start, blockEnd) };
  }
  return null;
}

function replaceTaggedBlock(
  content: string,
  block: TagBlock,
  body: string,
): string {
  return content.slice(0, block.start) + body + content.slice(block.end);
}
