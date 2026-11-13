import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import type { JournalPage } from "../api/types";
import { ensureJournalPage } from "../lib/journal";
import { useAppNavigate } from "../lib/appNavigation";
import {
  noteLinkKeys,
  normalizeLinkTarget,
} from "../lib/markdown";
import { JournalCard } from "./JournalCard";
import { JournalPluginsPanel } from "./JournalPluginsPanel";
import {
  activeNotebookIdAtom,
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

  if (!notebookId) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-canvas p-8">
        <p className="max-w-sm text-center font-mono text-[14px] leading-relaxed text-muted">
          Create or select a notebook to open its journal.
        </p>
      </main>
    );
  }

  return (
    <main className="flex min-h-0 flex-1 bg-canvas">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-6">
        {pages.length === 0 && !loading && !error && (
          <div className="mt-16 text-center">
            <p className="font-sans text-[14px] text-muted">
              No journal pages yet.
            </p>
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
              onTag={(tag) => navigate({ view: "tag", tag })}
            />
          ))}
        </div>

        {error && (
          <p className="mt-4 rounded-lg bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
            {error}
          </p>
        )}

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
      <JournalPluginsPanel />
    </main>
  );
}
