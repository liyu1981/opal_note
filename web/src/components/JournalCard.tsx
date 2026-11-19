import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useSetAtom } from "jotai";

import { api } from "../api/client";
import type { JournalPage, Note } from "../api/types";
import { relativeTime } from "../lib/format";
import { formatJournalDate } from "../lib/journal";
import { refreshJournalPluginsAtom, refreshTasksAtom } from "../state/atoms";
import { taskSignature } from "../lib/tasks";
import type { LinkTarget } from "../lib/livePreview";
import { IconFile, IconLock } from "./Icons";
import {
  LiveMarkdownEditor,
  type LiveMarkdownEditorHandle,
} from "./editor/LiveMarkdownEditor";

type SaveStatus = "saved" | "dirty" | "saving" | "error";

type JournalCardProps = {
  page: JournalPage;
  notebookId: string;
  linkKeys: Set<string>;
  linkTargets: LinkTarget[];
  readOnly: boolean;
  onOpenPage: (page: JournalPage) => void;
  onWikiLink: (target: string) => void;
  onTag: (tag: string) => void;
  onSaved?: () => void;
  saveContent?: (body: string) => Promise<Note>;
  onNavigate?: (direction: "up" | "down") => boolean;
};

export type JournalCardHandle = {
  focus: () => void;
  focusStart: () => void;
  focusEnd: () => void;
};

export const JournalCard = forwardRef<JournalCardHandle, JournalCardProps>(
  function JournalCard(
    {
      page,
      notebookId,
      linkKeys,
      linkTargets,
      readOnly,
      onOpenPage,
      onWikiLink,
      onTag,
      onSaved,
      saveContent,
      onNavigate,
    },
    ref,
  ) {
    const [content, setContent] = useState(page.content);
    const [tags, setTags] = useState(page.tags);
    const [updatedAt, setUpdatedAt] = useState(page.updated_at);
    const [status, setStatus] = useState<SaveStatus>("saved");
    const [dirty, setDirty] = useState(false);
    const [tick, setTick] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const refreshPlugins = useSetAtom(refreshJournalPluginsAtom);
    const refreshTasks = useSetAtom(refreshTasksAtom);
    const editorRef = useRef<LiveMarkdownEditorHandle>(null);
    const contentRef = useRef(content);
    const dirtyRef = useRef(dirty);
    const versionRef = useRef(0);
    const savingRef = useRef(false);
    // Content last seen from the server, so a refresh can tell "changed
    // elsewhere" apart from "this card echoed its own save".
    const serverContentRef = useRef(page.content);
    // Tasks are derived from the body: a save that changes them must refresh
    // the todo list (and the Home plugin card), not just the plugin rail.
    const savedTasksRef = useRef(taskSignature(page.content));
    contentRef.current = content;
    dirtyRef.current = dirty;

    useImperativeHandle(
      ref,
      () => ({
        focus: () => editorRef.current?.focus(),
        focusStart: () => editorRef.current?.focusStart(),
        focusEnd: () => editorRef.current?.focusEnd(),
      }),
      [],
    );

    // A background refresh (resume, remote edit) replaces untouched cards;
    // a card with a local draft keeps it and shows the draft until it saves.
    useEffect(() => {
      if (page.content === serverContentRef.current) return;
      serverContentRef.current = page.content;
      if (dirtyRef.current || savingRef.current) return;
      contentRef.current = page.content;
      versionRef.current += 1;
      setContent(page.content);
      setTags(page.tags);
      setUpdatedAt(page.updated_at);
      setStatus("saved");
    }, [page.content, page.tags, page.updated_at]);

    const save = useCallback(async (): Promise<boolean> => {
      if (savingRef.current) return false;
      savingRef.current = true;
      const version = versionRef.current;
      const body = contentRef.current;
      setStatus("saving");
      setError(null);
      try {
        const updated = saveContent
          ? await saveContent(body)
          : await api.updateNote(notebookId, page.id, {
              content: body,
            });
        setTags(updated.tags);
        setUpdatedAt(updated.updated_at);
        refreshPlugins();
        const tasks = taskSignature(body);
        if (tasks !== savedTasksRef.current) {
          savedTasksRef.current = tasks;
          refreshTasks();
        }
        if (versionRef.current === version) {
          setDirty(false);
          setStatus("saved");
        } else {
          setStatus("dirty");
          setTick((value) => value + 1);
        }
        onSaved?.();
        return true;
      } catch (cause) {
        setStatus("error");
        setError(cause instanceof Error ? cause.message : "Could not save");
        return false;
      } finally {
        savingRef.current = false;
      }
    }, [notebookId, onSaved, page.id, refreshPlugins, saveContent]);

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
          const body = contentRef.current;
          void api
            .updateNote(notebookId, page.id, { content: body })
            .then(() => {
              // The next view may already be mounted (e.g. Todos): tell it.
              if (taskSignature(body) !== savedTasksRef.current) {
                savedTasksRef.current = taskSignature(body);
                refreshTasks();
              }
            })
            .catch(() => {
              // The card is gone; the next open will surface server errors.
            });
        }
      };
    }, [notebookId, page.id, refreshPlugins, refreshTasks]);

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
      <article className="rounded-xl border border-line/70 bg-paper px-3 pb-2 pt-3 transition hover:border-line">
        <header className="flex items-start gap-2">
          <button
            type="button"
            onClick={() => void flushThen(() => onOpenPage(page))}
            className="min-w-0 text-left font-serif text-[16px] font-semibold leading-tight tracking-tight text-ink transition hover:text-accent-strong sm:text-[24px]"
            title="Open this journal page"
          >
            {formatJournalDate(page.title)}
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap pt-1">
            <span
              className={`font-mono text-[14px] ${
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
            <span className="font-mono text-[14px] text-faint">·</span>
            <span className="font-mono text-[14px] text-faint">
              {relativeTime(updatedAt)}
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
            <button
              key={tag}
              type="button"
              onClick={() => void flushThen(() => onTag(tag))}
              className="rounded bg-panel px-1 py-0.5 font-mono text-[14px] text-muted transition hover:bg-accent-soft hover:text-accent-strong"
              title={`Open #${tag}`}
            >
              #{tag}
            </button>
          ))}
        </div>

        <div className="journal-card-editor mt-1.5 border-t border-line/40">
          <LiveMarkdownEditor
            ref={editorRef}
            value={content}
            onChange={change}
            onWikiLink={(target) => void handleWikiLink(target)}
            onTag={(tag) => void flushThen(() => onTag(tag))}
            notebookId={notebookId}
            notePath={page.id}
            linkKeys={linkKeys}
            linkTargets={linkTargets}
            readOnly={readOnly}
            autoHeight
            onNavigate={onNavigate}
          />
        </div>

        {error && (
          <p className="mt-1 rounded bg-danger/10 px-2 py-1 font-mono text-[14px] text-danger">
            {error}
          </p>
        )}
      </article>
    );
  },
);
