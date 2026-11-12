import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import type { JournalPage } from "../api/types";
import { ensureJournal } from "../lib/journal";
import {
  noteLinkKeys,
  normalizeLinkTarget,
} from "../lib/markdown";
import { IconCalendar } from "./Icons";
import { JournalCard } from "./JournalCard";
import {
  activeNotebookIdAtom,
  navigateAtom,
  notesAtom,
  readOnlyAtom,
  refreshAtom,
} from "../state/atoms";

const PAGE_SIZE = 7;

export function JournalFeed() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const notes = useAtomValue(notesAtom);
  const locked = useAtomValue(readOnlyAtom);
  const navigate = useSetAtom(navigateAtom);
  const refresh = useSetAtom(refreshAtom);

  const [pages, setPages] = useState<JournalPage[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const generationRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);

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
    generationRef.current += 1;
    loadingRef.current = false;
    setPages([]);
    setHasMore(true);
    setError(null);
    if (notebookId) void load(undefined, true);
  }, [notebookId, load]);

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

  function openWiki(target: string) {
    const needle = normalizeLinkTarget(target);
    const hit = notes.find((note) =>
      noteLinkKeys(note.title, note.id).includes(needle),
    );
    if (hit) {
      navigate({ view: "note", noteId: hit.id });
    }
  }

  async function openToday() {
    if (!notebookId || locked) return;
    try {
      const note = await ensureJournal(notebookId);
      navigate({ view: "note", noteId: note.id });
      refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not open today's journal",
      );
    }
  }

  if (!notebookId) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-canvas p-8">
        <p className="max-w-sm text-center font-mono text-[11.5px] leading-relaxed text-muted">
          Create or select a notebook to open its journal.
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-canvas">
      <div className="mx-auto w-full max-w-4xl px-6 py-6">
        <header className="flex items-end justify-between gap-4 border-b border-line pb-4">
          <div>
            <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.16em] text-faint">
              Journal
            </div>
            <h1 className="mt-1 font-mono text-[26px] font-semibold tracking-tight text-ink">
              Daily pages
            </h1>
          </div>
          <button
            type="button"
            onClick={openToday}
            disabled={locked}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white/70 px-2.5 py-1.5 font-mono text-[10px] text-ink-soft transition hover:border-line-strong hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            title={locked ? "Read only" : "Open today's journal"}
          >
            <IconCalendar className="h-3.5 w-3.5" />
            Today
          </button>
        </header>

        {pages.length === 0 && !loading && !error && (
          <div className="mt-16 text-center">
            <p className="font-mono text-[12px] text-muted">
              No journal pages yet.
            </p>
            <button
              type="button"
              onClick={openToday}
              disabled={locked}
              className="mt-3 rounded-lg bg-ink px-3 py-1.5 font-mono text-[10.5px] text-canvas disabled:opacity-40"
            >
              Start today's journal
            </button>
          </div>
        )}

        <div className="mt-4 space-y-3">
          {pages.map((page) => (
            <JournalCard
              key={page.id}
              page={page}
              notebookId={notebookId}
              linkKeys={linkKeys}
              linkTargets={linkTargets}
              readOnly={locked}
              onOpenPage={openPage}
              onWikiLink={openWiki}
            />
          ))}
        </div>

        {error && (
          <p className="mt-4 rounded-lg bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger">
            {error}
          </p>
        )}

        <div
          ref={sentinelRef}
          className="py-8 text-center font-mono text-[9.5px] uppercase tracking-[0.12em] text-faint"
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
    </main>
  );
}
