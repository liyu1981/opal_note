import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import type { JournalPage, Note, PageOverview } from "../api/types";
import { formatJournalDate } from "../lib/journal";
import { useAppNavigate } from "../lib/appNavigation";
import { noteLinkKeys, normalizeLinkTarget } from "../lib/markdown";
import {
  activeNoteIdAtom,
  activeNotebookIdAtom,
  homeViewAtom,
  notesAtom,
  notesRevisionAtom,
  omniQueryAtom,
  readOnlyAtom,
} from "../state/atoms";
import { IconCalendar, IconFile } from "./Icons";
import { JournalCard } from "./JournalCard";

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
  const setOmniQuery = useSetAtom(omniQueryAtom);
  const navigate = useAppNavigate();

  const [pages, setPages] = useState<PageOverview[]>([]);
  const [cards, setCards] = useState<TagPage[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<number | null>(null);

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
    setActiveNote(null);
  }, [setActiveNote, setHomeView]);

  useEffect(() => {
    setOmniQuery(tag ? `#${tag}` : "");
    return () => setOmniQuery("");
  }, [setOmniQuery, tag]);

  useEffect(() => {
    if (!notebookId || !tag) {
      setPages([]);
      setCards([]);
      setTotal(0);
      setLoading(false);
      return;
    }

    let cancelled = false;
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
    <main className="min-h-0 flex-1 overflow-y-auto bg-canvas">
      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-6 px-6 py-5 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="min-w-0 space-y-3">
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
          ) : (
            cards.map((item, index) =>
              item.note ? (
                <div
                  key={item.page.id}
                  id={`tag-page-${index}`}
                  className={`scroll-mt-4 rounded-xl transition ${
                    focused === index ? "ring-1 ring-accent/40" : ""
                  }`}
                >
                  <JournalCard
                    page={toJournalPage(item)}
                    notebookId={notebookId ?? ""}
                    linkKeys={linkKeys}
                    linkTargets={linkTargets}
                    readOnly={locked}
                    onOpenPage={(page) =>
                      navigate({ view: "note", noteId: page.id })
                    }
                    onWikiLink={openWiki}
                    onTag={openTag}
                  />
                </div>
              ) : (
                <article
                  key={item.page.id}
                  id={`tag-page-${index}`}
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
                    Page content is unavailable.
                  </p>
                </article>
              ),
            )
          )}

          {!loading && total > pages.length && (
            <p className="pt-1 text-center font-mono text-[14px] text-faint">
              Showing the {pages.length} most recently updated of {total} pages.
            </p>
          )}
        </div>

        <aside className="sticky top-5 hidden max-h-[calc(100vh-5rem)] self-start overflow-y-auto rounded-xl border border-line bg-panel/85 px-3 py-4 shadow-panel backdrop-blur lg:block">
          <div className="flex items-center justify-between px-1.5">
            <p className="font-mono text-[14px] font-semibold uppercase tracking-[0.12em] text-faint">
              Pages
            </p>
            <span className="font-mono text-[14px] text-faint">{total}</span>
          </div>
          <div className="mt-2 space-y-0.5">
            {pages.map((page, index) => (
              <button
                key={page.id}
                type="button"
                onClick={() => jumpTo(index)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left font-sans text-[14px] text-ink-soft transition hover:bg-white/70 hover:text-ink"
                title={pageTitle(page)}
              >
                {page.id.startsWith("journals/") ? (
                  <IconCalendar className="h-3 w-3 shrink-0 text-faint" />
                ) : (
                  <IconFile className="h-3 w-3 shrink-0 text-faint" />
                )}
                <span className="truncate">{pageTitle(page)}</span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}


function toJournalPage(item: TagPage): JournalPage {
  const note = item.note;
  return {
    id: item.page.id,
    notebook_id: item.page.notebook_id,
    title: item.page.title,
    content: note?.content ?? "",
    created_at: item.page.created_at,
    updated_at: note?.updated_at ?? item.page.updated_at,
    tags: note?.tags ?? item.page.tags,
  };
}
