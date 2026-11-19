import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import type { JournalPage } from "../api/types";
import { filterTerms, matchesFilter } from "../lib/filter";
import { ensureJournalPage } from "../lib/journal";
import { useViewAutoFocus } from "../lib/useViewFocus";
import { useAppNavigate } from "../lib/appNavigation";
import {
  noteLinkKeys,
  normalizeLinkTarget,
} from "../lib/markdown";
import { JournalCard, type JournalCardHandle } from "./JournalCard";
import { ListFilter } from "./ListFilter";
import {
  activeNotebookIdAtom,
  notesRevisionAtom,
  notesAtom,
  readOnlyAtom,
  refreshNotesAtom,
} from "../state/atoms";

const PAGE_SIZE = 7;

export function JournalFeed() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const notes = useAtomValue(notesAtom);
  const locked = useAtomValue(readOnlyAtom);
  const navigate = useAppNavigate();
  const refreshNotes = useSetAtom(refreshNotesAtom);

  const [pages, setPages] = useState<JournalPage[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const revision = useAtomValue(notesRevisionAtom);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const generationRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const firstCardRef = useRef<JournalCardHandle>(null);
  const cardRefs = useRef<Array<JournalCardHandle | null>>([]);
  const pendingNextPageRef = useRef<number | null>(null);

  // The filter only narrows entries already loaded; older pages still arrive
  // from the feed and are matched as they come in.
  const terms = useMemo(() => filterTerms(filter), [filter]);
  const visiblePages = useMemo(
    () =>
      terms.length === 0
        ? pages
        : pages.filter((page) =>
            matchesFilter(`${page.title}\n${page.content}`, terms),
          ),
    [pages, terms],
  );

  useViewAutoFocus(
    "journal",
    () => firstCardRef.current?.focus(),
    visiblePages.length > 0,
  );

  const linkTargets = notes.map((note) => ({
    title: note.title,
    path: note.id,
  }));
  const linkKeys = new Set(
    notes.flatMap((note) => noteLinkKeys(note.title, note.id)),
  );

  const load = useCallback(
    async (before: string | undefined, replace: boolean) => {
      if (!notebookId || loadingRef.current) return;
      const generation = generationRef.current;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const batch = await api.listJournals(notebookId, before, PAGE_SIZE);
        if (generation !== generationRef.current) return;
        setPages((current) => {
          if (replace) return batch;
          const ids = new Set(current.map((page) => page.id));
          return [...current, ...batch.filter((page) => !ids.has(page.id))];
        });
        setHasMore(batch.length === PAGE_SIZE);
      } catch (cause) {
        if (generation !== generationRef.current) return;
        setError(
          cause instanceof Error ? cause.message : "Could not load the journal",
        );
        setHasMore(false);
      } finally {
        if (generation === generationRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [notebookId],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    loadingRef.current = false;
    setPages([]);
    setHasMore(true);
    setError(null);
    setLoading(true);

    if (!notebookId) {
      setLoading(false);
      return;
    }

    void (async () => {
      if (!locked) {
        try {
          const { created } = await ensureJournalPage(notebookId);
          if (created) refreshNotes();
        } catch (cause) {
          if (generation === generationRef.current) {
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not create today's journal",
            );
          }
        }
      }
      if (generation === generationRef.current) {
        await load(undefined, true);
      }
    })();
  }, [load, locked, notebookId, refreshNotes]);

  // Re-read the pages already on screen when notes change elsewhere (resume,
  // another device). Cards without a draft adopt the new text; a card being
  // edited keeps its draft.
  const appliedRevisionRef = useRef(revision);
  useEffect(() => {
    if (revision === appliedRevisionRef.current) return;
    appliedRevisionRef.current = revision;
    if (!notebookId || pages.length === 0) return;
    void (async () => {
      const generation = generationRef.current;
      try {
        const batch = await api.listJournals(notebookId, undefined, PAGE_SIZE);
        if (generation !== generationRef.current) return;
        setPages((current) => {
          const fresh = new Map(batch.map((page) => [page.id, page]));
          return current.map((page) => fresh.get(page.id) ?? page);
        });
      } catch {
        // Keep what is on screen; the next resume retries.
      }
    })();
  }, [notebookId, pages.length, revision]);

  useEffect(() => {
    const target = pendingNextPageRef.current;
    if (target === null) return;
    const handle = cardRefs.current[target];
    if (handle) {
      pendingNextPageRef.current = null;
      handle.focusStart();
    } else if (!loading && !hasMore) {
      pendingNextPageRef.current = null;
    }
  }, [hasMore, loading, visiblePages]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || loading || pages.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        const last = pages[pages.length - 1];
        if (last) void load(last.id, false);
      },
      { rootMargin: "500px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, pages, load]);

  function openPage(page: JournalPage) {
    navigate({ view: "note", noteId: page.id });
  }

  function focusSibling(index: number, direction: "up" | "down"): boolean {
    const next = direction === "down" ? index + 1 : index - 1;
    if (next < 0) return false;
    if (next >= visiblePages.length) {
      if (direction === "up" || !hasMore || pages.length === 0) return false;
      // The feed loads older pages on demand. Queue focus for the first card
      // in the next batch instead of trapping the caret on the last page.
      pendingNextPageRef.current = next;
      if (!loadingRef.current) {
        void load(pages[pages.length - 1]?.id, false);
      }
      return true;
    }
    const handle = cardRefs.current[next];
    if (!handle) return false;
    if (direction === "down") handle.focusStart();
    else handle.focusEnd();
    return true;
  }

  function openWiki(target: string) {
    const needle = normalizeLinkTarget(target);
    const hit = notes.find((note) =>
      noteLinkKeys(note.title, note.id).includes(needle),
    );
    if (hit) {
      navigate({ view: "note", noteId: hit.id });
    }
  }

  if (!notebookId) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-transparent p-8">
        <p className="max-w-sm text-center font-mono text-[14px] leading-relaxed text-muted">
          Create or select a notebook to open its journal.
        </p>
      </main>
    );
  }

  return (
    <main className="flex min-h-0 flex-1 bg-transparent">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-5">
          <div className="relative">
            <ListFilter
              value={filter}
              onChange={setFilter}
              matched={visiblePages.length}
              total={pages.length}
              className="mb-3"
            />

            <div className="space-y-3">
              {pages.length === 0 && !loading && !error && (
                <div className="mt-16 text-center">
                  <p className="font-sans text-[14px] text-muted">
                    No journal pages yet.
                  </p>
                </div>
              )}

              {pages.length > 0 && visiblePages.length === 0 && (
                <div className="mt-16 text-center">
                  <p className="font-sans text-[14px] text-muted">
                    No loaded entries match “{filter.trim()}”.
                  </p>
                  <p className="mt-1 font-mono text-[14px] text-faint">
                    Older entries are still loaded as you scroll.
                  </p>
                </div>
              )}

              {visiblePages.map((page, index) => (
                <JournalCard
                  key={page.id}
                  ref={(node) => {
                    cardRefs.current[index] = node;
                    if (index === 0) firstCardRef.current = node;
                  }}
                  page={page}
                  notebookId={notebookId}
                  linkKeys={linkKeys}
                  linkTargets={linkTargets}
                  readOnly={locked}
                  onOpenPage={openPage}
                  onWikiLink={openWiki}
                  onTag={(tag) => navigate({ view: "tag", tag })}
                  onNavigate={(direction) => focusSibling(index, direction)}
                />
              ))}

              {error && (
                <p className="rounded-lg bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
                  {error}
                </p>
              )}
            </div>
          </div>

          <div
            ref={sentinelRef}
            className="py-8 text-center font-mono text-[14px] uppercase tracking-[0.12em] text-faint"
          >
            {loading
              ? "Loading older entries…"
              : hasMore
                ? "Scroll for older journal pages"
                : pages.length > 0
                  ? "Start of journal"
                  : ""}
          </div>
        </div>
      </div>
    </main>
  );
}
