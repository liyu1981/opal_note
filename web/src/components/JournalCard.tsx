import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api/client";
import type { JournalPage } from "../api/types";
import { relativeTime } from "../lib/format";
import { formatJournalDate } from "../lib/journal";
import type { LinkTarget } from "../lib/livePreview";
import { IconFile, IconLock } from "./Icons";
import { LiveMarkdownEditor } from "./editor/LiveMarkdownEditor";

type SaveStatus = "saved" | "dirty" | "saving" | "error";

export function JournalCard({
  page,
  notebookId,
  linkKeys,
  linkTargets,
  readOnly,
  onOpenPage,
  onWikiLink,
}: {
  page: JournalPage;
  notebookId: string;
  linkKeys: Set<string>;
  linkTargets: LinkTarget[];
  readOnly: boolean;
  onOpenPage: (page: JournalPage) => void;
  onWikiLink: (target: string) => void;
}) {
  const [content, setContent] = useState(page.content);
  const [tags, setTags] = useState(page.tags);
  const [updatedAt, setUpdatedAt] = useState(page.updated_at);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [dirty, setDirty] = useState(false);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const contentRef = useRef(content);
  const dirtyRef = useRef(dirty);
  const versionRef = useRef(0);
  const savingRef = useRef(false);
  contentRef.current = content;
  dirtyRef.current = dirty;

  const save = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    const version = versionRef.current;
    const body = contentRef.current;
    setStatus("saving");
    setError(null);
    try {
      const updated = await api.updateNote(notebookId, page.id, {
        content: body,
      });
      setTags(updated.tags);
      setUpdatedAt(updated.updated_at);
      if (versionRef.current === version) {
        setDirty(false);
        setStatus("saved");
      } else {
        setStatus("dirty");
        setTick((value) => value + 1);
      }
      return true;
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Could not save");
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [notebookId, page.id]);

  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => void save(), 800);
    return () => window.clearTimeout(timer);
  }, [dirty, tick, save]);

  // Locking the workspace should not freeze an in-flight draft.
  useEffect(() => {
    if (readOnly && dirty && !savingRef.current) void save();
  }, [dirty, readOnly, save]);

  // A feed navigation unmounts cards; flush any pending draft.
  useEffect(() => {
    return () => {
      if (dirtyRef.current && !savingRef.current) {
        void api
          .updateNote(notebookId, page.id, { content: contentRef.current })
          .catch(() => {
            // The card is gone; the next open will surface server errors.
          });
      }
    };
  }, [notebookId, page.id]);

  function change(next: string) {
    contentRef.current = next;
    versionRef.current += 1;
    setContent(next);
    setDirty(true);
    setStatus("dirty");
    setTick((value) => value + 1);
  }

  async function flushThen(action: () => void) {
    if (dirty) {
      const saved = await save();
      if (!saved) return;
    }
    action();
  }

  async function handleWikiLink(target: string) {
    await flushThen(() => onWikiLink(target));
  }

  const statusLabel =
    status === "saving"
      ? "Saving…"
      : status === "error"
        ? "Save failed"
        : status === "dirty"
          ? "Unsaved"
          : "Saved";

  return (
    <article className="rounded-xl border border-line/70 bg-white/35 px-3 pb-2 pt-3 transition hover:border-line">
      <header className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => void flushThen(() => onOpenPage(page))}
          className="min-w-0 text-left font-mono text-[24px] font-semibold leading-tight tracking-tight text-ink transition hover:text-accent-strong"
          title="Open this journal page"
        >
          {formatJournalDate(page.title)}
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-2 pt-1">
          <span
            className={`font-mono text-[9px] ${
              status === "error" ? "text-danger" : "text-faint"
            }`}
          >
            {readOnly ? (
              <span className="inline-flex items-center gap-1">
                <IconLock className="h-3 w-3" /> Read only
              </span>
            ) : (
              statusLabel
            )}
          </span>
          <button
            type="button"
            onClick={() => void flushThen(() => onOpenPage(page))}
            className="rounded-md border border-transparent p-1 text-faint transition hover:border-line hover:bg-white/70 hover:text-ink"
            aria-label={`Open ${page.title}`}
            title="Open this journal page"
          >
            <IconFile className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="rounded bg-panel px-1 py-0.5 font-mono text-[8.5px] text-muted"
          >
            #{tag}
          </span>
        ))}
        <span className="ml-auto font-mono text-[9px] text-faint">
          {relativeTime(updatedAt)}
        </span>
      </div>

      <div className="journal-card-editor mt-1.5 border-t border-line/40">
        <LiveMarkdownEditor
          value={content}
          onChange={change}
          onWikiLink={(target) => void handleWikiLink(target)}
          linkKeys={linkKeys}
          linkTargets={linkTargets}
          readOnly={readOnly}
          autoHeight
        />
      </div>

      {error && (
        <p className="mt-1 rounded bg-danger/10 px-2 py-1 font-mono text-[10px] text-danger">
          {error}
        </p>
      )}
    </article>
  );
}
