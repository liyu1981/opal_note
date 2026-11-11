import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useAtomValue, useSetAtom } from "jotai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { api } from "../api/client";
import type { Note } from "../api/types";
import { parseTags, relativeTime, tagList, wordCount } from "../lib/format";
import { wikiTarget, withWikilinks } from "../lib/markdown";
import { IconCheck, IconFile, IconTag, IconTrash } from "./Icons";
import {
  activeNoteAtom,
  activeNoteIdAtom,
  activeNotebookIdAtom,
  refreshAtom,
} from "../state/atoms";

type EditorMode = "edit" | "split" | "preview";
type SaveStatus = "saved" | "dirty" | "saving" | "error";

export function EditorPane() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const noteId = useAtomValue(activeNoteIdAtom);

  if (!notebookId) {
    return (
      <EmptyState
        title="A notebook for every thread"
        body="Pick a notebook on the left, or create one. Notes, tags and backlinks are indexed by MnesticDB on the server."
      />
    );
  }
  if (!noteId) {
    return (
      <EmptyState
        title="No note selected"
        body="Choose a note from the list, or start a new one. Everything is saved to the server automatically."
      />
    );
  }

  return (
    <Suspense fallback={<EditorSkeleton />}>
      <ActiveNote />
    </Suspense>
  );
}

function ActiveNote() {
  const note = useAtomValue(activeNoteAtom);
  if (!note) {
    return (
      <EmptyState
        title="This note is gone"
        body="It may have been deleted. Pick another note from the list."
      />
    );
  }
  return <NoteEditor key={`${note.notebook_id}/${note.id}`} note={note} />;
}

function NoteEditor({ note }: { note: Note }) {
  const refresh = useSetAtom(refreshAtom);
  const setActiveNote = useSetAtom(activeNoteIdAtom);

  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [tagsInput, setTagsInput] = useState(tagList(note.explicit_tags));
  const [mode, setMode] = useState<EditorMode>("split");
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editTick, setEditTick] = useState(0);
  const [deleting, setDeleting] = useState(false);

  const draftRef = useRef({ title, content, tagsInput });
  const changeVersion = useRef(0);
  const savingRef = useRef(false);
  draftRef.current = { title, content, tagsInput };

  const touch = useCallback(() => {
    changeVersion.current += 1;
    setDirty(true);
    setStatus("dirty");
    setEditTick((tick) => tick + 1);
  }, []);

  const save = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    const version = changeVersion.current;
    const draft = draftRef.current;
    setStatus("saving");
    setMessage(null);

    try {
      const updated = await api.updateNote(note.notebook_id, note.id, {
        title: draft.title,
        content: draft.content,
        tags: parseTags(draft.tagsInput),
      });
      if (updated.id !== note.id) {
        setActiveNote(updated.id);
      }
      refresh();
      if (changeVersion.current === version) {
        setDirty(false);
        setStatus("saved");
      } else {
        setStatus("dirty");
        setEditTick((tick) => tick + 1);
      }
    } catch (cause) {
      setStatus("error");
      setMessage(cause instanceof Error ? cause.message : "Could not save");
    } finally {
      savingRef.current = false;
    }
  }, [note.id, note.notebook_id, refresh, setActiveNote]);

  // Debounced autosave. The tick dependency restarts the timer on every
  // keystroke and after a save that raced with further edits.
  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => void save(), 900);
    return () => window.clearTimeout(timer);
  }, [dirty, editTick, save]);

  // After a clean save, adopt the server's canonical title (renames may
  // sanitize a character) and frontmatter tags (inline #tags stay derived).
  useEffect(() => {
    if (!dirty && status === "saved") {
      setTitle(note.title);
      setTagsInput(tagList(note.explicit_tags));
    }
  }, [note.title, note.explicit_tags, dirty, status]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [save]);

  const navigateWiki = useCallback(
    async (target: string) => {
      const needle = target.trim().toLowerCase();
      if (!needle) return;
      try {
        const linked = note.links.find(
          (link) => link.note_id && link.target === needle,
        );
        if (linked?.note_id) {
          setActiveNote(linked.note_id);
          return;
        }
        const notes = await api.listNotes(note.notebook_id, 200);
        const hit = notes.find(
          (candidate) => candidate.title.trim().toLowerCase() === needle,
        );
        if (hit) {
          setActiveNote(hit.id);
          return;
        }
        const results = await api.searchNotes(note.notebook_id, target, 5);
        const first = results[0];
        if (first) setActiveNote(first.id);
      } catch {
        // Navigation is best-effort; a stale index should never block editing.
      }
    },
    [note.links, note.notebook_id, setActiveNote],
  );

  async function remove() {
    if (deleting) return;
    if (
      !window.confirm(
        `Delete “${draftRef.current.title || "Untitled"}”? The file moves to the server trash.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      await api.deleteNote(note.notebook_id, note.id);
      setActiveNote(null);
      refresh();
    } catch (cause) {
      setDeleting(false);
      setMessage(
        cause instanceof Error ? cause.message : "Could not delete the note",
      );
    }
  }

  const statusLabel =
    status === "saving"
      ? "Saving…"
      : status === "error"
        ? "Save failed"
        : status === "dirty"
          ? "Unsaved changes"
          : "Saved";

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-canvas px-6 py-4">
      <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <input
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                touch();
              }}
              placeholder="Untitled note"
              maxLength={300}
              autoFocus={note.title === "Untitled" && note.content === ""}
              className="w-full bg-transparent font-serif text-[28px] leading-tight text-ink outline-none placeholder:text-faint"
              aria-label="Note title"
            />
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-faint">
              <span
                className={`inline-flex items-center gap-1 ${
                  status === "error" ? "text-danger" : ""
                }`}
              >
                {status === "saved" ? (
                  <IconCheck className="h-3 w-3 text-mint" />
                ) : (
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      status === "saving"
                        ? "animate-pulse bg-accent"
                        : status === "error"
                          ? "bg-danger"
                          : "bg-faint"
                    }`}
                  />
                )}
                {statusLabel}
              </span>
              <span>{wordCount(content)} words</span>
              <span>Updated {relativeTime(note.updated_at)}</span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <div className="flex rounded-lg border border-line bg-white/60 p-0.5">
              {(
                [
                  ["edit", "Edit"],
                  ["split", "Split"],
                  ["preview", "Read"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={`rounded-md px-2 py-1 text-[10.5px] font-medium transition ${
                    mode === value
                      ? "bg-ink text-canvas shadow-sm"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void save()}
              disabled={status === "saving"}
              className="rounded-lg border border-line bg-white/70 px-2.5 py-1.5 text-[10.5px] font-medium text-ink-soft transition hover:border-line-strong hover:bg-white disabled:opacity-50"
              title="Save (⌘S)"
            >
              Save
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={deleting}
              className="rounded-lg border border-transparent p-1.5 text-faint transition hover:border-danger/20 hover:bg-danger/10 hover:text-danger disabled:opacity-50"
              aria-label="Delete note"
              title="Delete note"
            >
              <IconTrash className="h-4 w-4" />
            </button>
          </div>
        </div>

        <label className="mt-3 flex items-center gap-2 border-b border-line pb-2">
          <IconTag className="h-3.5 w-3.5 shrink-0 text-faint" />
          <input
            value={tagsInput}
            onChange={(event) => {
              setTagsInput(event.target.value);
              touch();
            }}
            placeholder="Tags, comma separated — inline #tags are indexed too"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-ink-soft outline-none placeholder:text-faint"
            aria-label="Tags"
          />
          {tagsInput.trim() && (
            <span className="shrink-0 font-mono text-[9px] text-faint">
              {parseTags(tagsInput).length}{" "}
              {parseTags(tagsInput).length === 1 ? "tag" : "tags"}
            </span>
          )}
        </label>

        <div
          className={`mt-3 grid min-h-0 flex-1 gap-3 ${
            mode === "split" ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1"
          }`}
        >
          {mode !== "preview" && (
            <div className="flex min-h-[16rem] flex-col overflow-hidden rounded-xl border border-line bg-white/50 focus-within:border-accent/40 focus-within:bg-white lg:min-h-0">
              <textarea
                value={content}
                onChange={(event) => {
                  setContent(event.target.value);
                  touch();
                }}
                placeholder={
                  "Start writing in Markdown…\n\nLink notes with [[Another note]].\nAdd #tags anywhere in the prose."
                }
                spellCheck
                className="h-full min-h-[16rem] w-full flex-1 resize-none bg-transparent p-4 font-mono text-[12.5px] leading-[1.75] text-ink-soft outline-none placeholder:text-faint lg:min-h-0"
              />
            </div>
          )}

          {mode !== "edit" && (
            <div className="min-h-[16rem] overflow-y-auto rounded-xl border border-line bg-white/40 p-5 lg:min-h-0">
              {content.trim() ? (
                <MarkdownPreview content={content} onWiki={navigateWiki} />
              ) : (
                <p className="flex items-center gap-2 text-[12px] text-faint">
                  <IconFile className="h-3.5 w-3.5" />
                  Nothing to preview yet.
                </p>
              )}
            </div>
          )}
        </div>

        {message && (
          <p className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-[11px] text-danger">
            {message}
          </p>
        )}
      </div>
    </main>
  );
}

function MarkdownPreview({
  content,
  onWiki,
}: {
  content: string;
  onWiki: (target: string) => void;
}) {
  return (
    <div className="note-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const target = wikiTarget(href ?? "");
            if (target) {
              return (
                <button
                  type="button"
                  className="wikilink"
                  onClick={() => onWiki(target)}
                >
                  {children}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
        }}
      >
        {withWikilinks(content)}
      </ReactMarkdown>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center bg-canvas p-8">
      <div className="max-w-sm text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-white/60 text-accent">
          <IconFile className="h-5 w-5" />
        </span>
        <h2 className="mt-3 font-serif text-2xl text-ink">{title}</h2>
        <p className="mt-2 text-[12px] leading-relaxed text-muted">{body}</p>
      </div>
    </main>
  );
}

function EditorSkeleton() {
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-canvas px-6 py-4">
      <div className="mx-auto w-full max-w-4xl animate-pulse">
        <div className="h-8 w-1/2 rounded bg-panel-strong" />
        <div className="mt-3 h-3 w-32 rounded bg-panel" />
        <div className="mt-8 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="h-72 rounded-xl border border-line bg-white/40" />
          <div className="h-72 rounded-xl border border-line bg-white/30" />
        </div>
      </div>
    </main>
  );
}
