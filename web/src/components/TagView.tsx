import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import type { Note, PageOverview } from "../api/types";
import { relativeTime } from "../lib/format";
import { formatJournalDate } from "../lib/journal";
import { useAppNavigate } from "../lib/appNavigation";
import { noteLinkKeys, normalizeLinkTarget } from "../lib/markdown";
import {
  activeNoteIdAtom,
  activeNotebookIdAtom,
  notesAtom,
  notesRevisionAtom,
  omniQueryAtom,
} from "../state/atoms";
import { IconCalendar, IconFile } from "./Icons";
import { LiveMarkdownEditor } from "./editor/LiveMarkdownEditor";

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
  const setActiveNote = useSetAtom(activeNoteIdAtom);
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
    setActiveNote(null);
  }, [setActiveNote]);

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
    <main className="flex min-h-0 flex-1 bg-canvas">
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-5xl space-y-3 px-6 py-5">
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
              cards.map((item, index) => (
                <TagPageCard
                  key={item.page.id}
                  item={item}
                  index={index}
                  focused={focused === index}
                  linkKeys={linkKeys}
                  linkTargets={linkTargets}
                  onOpenPage={(page) =>
                    navigate({ view: "note", noteId: page.id })
                  }
                  onWikiLink={openWiki}
                  onTag={openTag}
                />
              ))
            )}

            {!loading && total > pages.length && (
              <p className="pt-1 text-center font-mono text-[14px] text-faint">
                Showing the {pages.length} most recently updated of {total} pages.
              </p>
            )}
          </div>
        </div>

        <aside className="hidden w-64 shrink-0 overflow-y-auto border-l border-line bg-panel/20 px-3 py-4 lg:block">
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

function TagPageCard({
  item,
  index,
  focused,
  linkKeys,
  linkTargets,
  onOpenPage,
  onWikiLink,
  onTag,
}: {
  item: TagPage;
  index: number;
  focused: boolean;
  linkKeys: Set<string>;
  linkTargets: Array<{ title: string; path: string }>;
  onOpenPage: (page: PageOverview) => void;
  onWikiLink: (target: string) => void;
  onTag: (tag: string) => void;
}) {
  const { page, note } = item;

  return (
    <article
      id={`tag-page-${index}`}
      className={`scroll-mt-4 rounded-xl border bg-white/35 px-4 pb-3 pt-3 transition ${
        focused ? "border-accent/50 bg-accent-soft/15" : "border-line/70"
      }`}
    >
      <header className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => onOpenPage(page)}
          className="min-w-0 text-left font-serif text-[20px] font-semibold leading-tight tracking-tight text-ink transition hover:text-accent-strong"
          title="Open page"
        >
          {pageTitle(page)}
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap pt-1 font-mono text-[14px] text-faint">
          <span>{relativeTime(page.updated_at)}</span>
          <button
            type="button"
            onClick={() => onOpenPage(page)}
            className="rounded-md border border-transparent p-1 text-faint transition hover:border-line hover:bg-white/70 hover:text-ink"
            aria-label={`Open ${pageTitle(page)}`}
            title="Open page"
          >
            <IconFile className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {page.tags.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => onTag(tag)}
            className="rounded bg-panel px-1 py-0.5 font-mono text-[14px] text-muted transition hover:bg-accent-soft hover:text-accent-strong"
            title={`Open #${tag}`}
          >
            #{tag}
          </button>
        ))}
      </div>

      <div className="mt-2 border-t border-line/40 pt-2">
        {note ? (
          <LiveMarkdownEditor
            value={note.content}
            onChange={() => {}}
            onWikiLink={onWikiLink}
            onTag={onTag}
            linkKeys={linkKeys}
            linkTargets={linkTargets}
            readOnly
            autoHeight
          />
        ) : (
          <p className="px-1 py-2 font-sans text-[14px] text-faint">
            Page content is unavailable.
          </p>
        )}
      </div>
    </article>
  );
}
