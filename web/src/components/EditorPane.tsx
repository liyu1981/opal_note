import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import type { Note, NoteSummary } from "../api/types";
import { parseTags, relativeTime, tagList, wordCount } from "../lib/format";
import { noteLinkKeys, normalizeLinkTarget } from "../lib/markdown";
import { IconCheck, IconFile, IconTag, IconTrash } from "./Icons";
import {
  LiveMarkdownEditor,
  type LiveMarkdownEditorHandle,
} from "./editor/LiveMarkdownEditor";
import {
  activeNoteAtom,
  activeNoteIdAtom,
  activeNotebookIdAtom,
  refreshAtom,
  revisionAtom,
} from "../state/atoms";

type SaveStatus = "saved" | "dirty" | "saving" | "error";
type LinkTarget = { title: string; path: string };

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
  const revision = useAtomValue(revisionAtom);

  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [tagsInput, setTagsInput] = useState(tagList(note.explicit_tags));
  const [live, setLive] = useState(true);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editTick, setEditTick] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [targetNotes, setTargetNotes] = useState<NoteSummary[]>([]);

  const editorRef = useRef<LiveMarkdownEditorHandle>(null);
  const draftRef = useRef({ title, content, tagsInput });
  const dirtyRef = useRef(dirty);
  const deletedRef = useRef(false);
  const changeVersion = useRef(0);
  const savingRef = useRef(false);
  draftRef.current = { title, content, tagsInput };
  dirtyRef.current = dirty;

  // Link completion and resolution need the notebook's pages. Fetching them
  // here (instead of an async atom) keeps the editor mounted across saves.
  useEffect(() => {
    let cancelled = false;
    api
      .listNotes(note.notebook_id, 200)
      .then((notes) => {
        if (!cancelled) setTargetNotes(notes);
      })
      .catch(() => {
        if (!cancelled) setTargetNotes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [note.notebook_id, revision]);

  const linkTargets = useMemo<LinkTarget[]>(
    () => targetNotes.map((candidate) => ({ title: candidate.title, path: candidate.id })),
    [targetNotes],
  );

  const linkKeys = useMemo(
    () =>
      new Set(
        linkTargets.flatMap((target) => noteLinkKeys(target.title, target.path)),
      ),
    [linkTargets],
  );

  // Switching notes by list/link unmounts this editor. Flush a pending draft
  // before that happens so a quick click cannot lose a paragraph. Navigation
  // side effects are left to the regular save path.
  useEffect(() => {
    return () => {
      if (!dirtyRef.current || deletedRef.current || savingRef.current) return;
      const draft = draftRef.current;
      void api
        .updateNote(note.notebook_id, note.id, {
          title: draft.title,
          content: draft.content,
          tags: parseTags(draft.tagsInput),
        })
        .then(() => refresh())
        .catch(() => {
          // The unmounted view has nowhere to show the failure; the next
          // autosave/edit path will surface it if the user returns.
        });
    };
  }, [note.id, note.notebook_id, refresh]);

  const touch = useCallback(() => {
    changeVersion.current += 1;
    setDirty(true);
    setStatus("dirty");
    setEditTick((tick) => tick + 1);
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) return false;
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
      return true;
    } catch (cause) {
      setStatus("error");
      setMessage(cause instanceof Error ? cause.message : "Could not save");
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [note.id, note.notebook_id, refresh, setActiveNote]);

  // Debounced autosave. The tick dependency restarts the timer on every
  // keystroke and after a save that raced with further edits.
  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => void save(), 700);
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

  // A close during the autosave window should at least warn, not silently drop
  // the last paragraph.
  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const navigateWiki = useCallback(
    async (target: string) => {
      const needle = normalizeLinkTarget(target);
      if (!needle) return;

      // Flush pending edits before leaving this block of the notebook.
      if (dirty) {
        const saved = await save();
        if (!saved) return;
      }

      const hit = linkTargets.find((candidate) =>
        noteLinkKeys(candidate.title, candidate.path).includes(needle),
      );
      if (hit) {
        setActiveNote(hit.path);
        return;
      }

      // Do not fall back to full-text search here: the current note contains
      // the link text, so a fuzzy hit would just re-open it. Only an exact
      // title/path match may navigate; otherwise offer to create the page.
      if (needle.includes("/")) return;
      if (!window.confirm(`Create a new page named “${target}”?`)) return;

      try {
        const created = await api.createNote(note.notebook_id, {
          title: target,
          content: "",
        });
        setActiveNote(created.id);
        refresh();
      } catch (cause) {
        setMessage(
          cause instanceof Error ? cause.message : "Could not create the page",
        );
      }
    },
    [
      dirty,
      linkTargets,
      note.notebook_id,
      refresh,
      save,
      setActiveNote,
    ],
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
    deletedRef.current = true;
    try {
      await api.deleteNote(note.notebook_id, note.id);
      setActiveNote(null);
      refresh();
    } catch (cause) {
      deletedRef.current = false;
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
    <main className="flex min-h-0 flex-1 flex-col bg-canvas px-5 py-4">
      <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <input
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                touch();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  editorRef.current?.focus();
                }
              }}
              placeholder="Untitled note"
              maxLength={300}
              autoFocus={note.title === "Untitled" && note.content === ""}
              className="w-full bg-transparent font-mono text-[26px] font-semibold leading-tight tracking-tight text-ink outline-none placeholder:text-faint"
              aria-label="Note title"
            />
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-faint">
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
                  ["live", true],
                  ["source", false],
                ] as const
              ).map(([label, value]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setLive(value)}
                  className={`rounded-md px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-wide transition ${
                    live === value
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
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-ink-soft outline-none placeholder:text-faint"
            aria-label="Tags"
          />
          {tagsInput.trim() && (
            <span className="shrink-0 font-mono text-[9px] text-faint">
              {parseTags(tagsInput).length}{" "}
              {parseTags(tagsInput).length === 1 ? "tag" : "tags"}
            </span>
          )}
        </label>

        <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-white/45 shadow-panel focus-within:border-accent/40">
          <div className="min-h-0 flex-1">
            <LiveMarkdownEditor
              ref={editorRef}
              value={content}
              onChange={(next) => {
                setContent(next);
                touch();
              }}
              onWikiLink={navigateWiki}
              linkKeys={linkKeys}
              linkTargets={linkTargets}
              live={live}
            />
          </div>
          <div className="flex items-center justify-between border-t border-line bg-panel/30 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.13em] text-faint">
            <span>{live ? "Live blocks" : "Markdown source"}</span>
            <span className="normal-case tracking-normal">
              [[ link ]] · # tag · - block
            </span>
          </div>
        </div>

        {message && (
          <p className="mt-2 rounded-lg bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger">
            {message}
          </p>
        )}
      </div>
    </main>
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
        <p className="mt-2 font-mono text-[11.5px] leading-relaxed text-muted">
          {body}
        </p>
      </div>
    </main>
  );
}

function EditorSkeleton() {
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-canvas px-5 py-4">
      <div className="mx-auto w-full max-w-4xl animate-pulse">
        <div className="h-8 w-1/2 rounded bg-panel-strong" />
        <div className="mt-3 h-3 w-32 rounded bg-panel" />
        <div className="mt-8 h-[28rem] rounded-xl border border-line bg-white/40" />
      </div>
    </main>
  );
}
