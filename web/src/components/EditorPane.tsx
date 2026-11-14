import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { ApiError, api } from "../api/client";
import type { Note, NoteSummary } from "../api/types";
import { parseTags, relativeTime, tagList, wordCount } from "../lib/format";
import { useAppNavigate } from "../lib/appNavigation";
import { noteLinkKeys, normalizeLinkTarget } from "../lib/markdown";
import { bindingLabel } from "../lib/shortcuts";
import { settingsAtom } from "../lib/settings";
import {
  IconCheck,
  IconFile,
  IconLock,
  IconLockOpen,
  IconStar,
  IconStarFilled,
  IconTag,
  IconTrash,
} from "./Icons";
import {
  LiveMarkdownEditor,
  type LiveMarkdownEditorHandle,
} from "./editor/LiveMarkdownEditor";
import {
  activeNoteIdAtom,
  activeNotebookIdAtom,
  favoritesAtom,
  readOnlyAtom,
  recordRecentAtom,
  saveRequestAtom,
  notesRevisionAtom,
  refreshAtom,
  refreshNotesAtom,
  renameNoteRefsAtom,
  revisionAtom,
  toggleFavoriteAtom,
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
        body="Open the left sidebar from the top bar to choose a page or start a new one. Everything is saved to the server automatically."
      />
    );
  }

  return (
    <Suspense fallback={<EditorSkeleton />}>
      <ActiveNote />
    </Suspense>
  );
}

type ActiveNoteLoad = {
  key: string;
  note: Note | null;
  error?: Error;
};

/**
 * Load the active note outside Jotai's Suspense boundary and keep the last
 * value while a refresh is in flight. Server saves bump `notesRevisionAtom`;
 * using the async atom directly would suspend this pane and unmount the editor
 * every time autosave runs, losing focus and the [[ completion popup.
 */
function ActiveNote() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const noteId = useAtomValue(activeNoteIdAtom);
  const notesRevision = useAtomValue(notesRevisionAtom);
  const key = `${notebookId ?? ""}/${noteId ?? ""}`;
  const [loaded, setLoaded] = useState<ActiveNoteLoad | null>(null);

  useEffect(() => {
    if (!notebookId || !noteId) {
      setLoaded({ key, note: null });
      return;
    }
    let cancelled = false;
    api
      .getNote(notebookId, noteId)
      .then((note) => {
        if (!cancelled) setLoaded({ key, note });
      })
      .catch((cause) => {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 404) {
          setLoaded({ key, note: null });
          return;
        }
        // Keep an already loaded note if a background refresh fails; a
        // transient network error must not tear down an open editor.
        setLoaded((current) =>
          current?.key === key && current.note
            ? current
            : {
                key,
                note: null,
                error:
                  cause instanceof Error ? cause : new Error(String(cause)),
              },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [key, notebookId, noteId, notesRevision]);

  if (loaded?.key === key && loaded.error) {
    return (
      <EmptyState
        title="Could not load this note"
        body={loaded.error.message}
      />
    );
  }
  if (!loaded || loaded.key !== key) return <EditorSkeleton />;
  if (!loaded.note) {
    return (
      <EmptyState
        title="This note is gone"
        body="It may have been deleted. Pick another note from the list."
      />
    );
  }
  return <NoteEditor key={key} note={loaded.note} />;
}

function NoteEditor({ note }: { note: Note }) {
  const refresh = useSetAtom(refreshAtom);
  const refreshNotes = useSetAtom(refreshNotesAtom);
  const revision = useAtomValue(revisionAtom);
  const saveRequest = useAtomValue(saveRequestAtom);
  const lastSaveRequest = useRef(saveRequest);
  const navigate = useAppNavigate();
  const locked = useAtomValue(readOnlyAtom);
  const setLocked = useSetAtom(readOnlyAtom);
  const settings = useAtomValue(settingsAtom);
  const favorites = useAtomValue(favoritesAtom);
  const toggleFavorite = useSetAtom(toggleFavoriteAtom);
  const recordRecent = useSetAtom(recordRecentAtom);
  const renameNoteRefs = useSetAtom(renameNoteRefsAtom);

  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [tagsInput, setTagsInput] = useState(tagList(note.explicit_tags));
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

  const isFavorite = (favorites[note.notebook_id] ?? []).some(
    (ref) => ref.path === note.id,
  );

  useEffect(() => {
    recordRecent({
      notebookId: note.notebook_id,
      path: note.id,
      title: note.title,
    });
  }, [note.id, note.notebook_id, note.title, recordRecent]);

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
        .then(() => refreshNotes())
        .catch(() => {
          // The unmounted view has nowhere to show the failure; the next
          // autosave/edit path will surface it if the user returns.
        });
    };
  }, [note.id, note.notebook_id, refreshNotes]);

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
        navigate({ view: "note", noteId: updated.id }, { replace: true });
      }
      renameNoteRefs({
        notebookId: note.notebook_id,
        oldPath: note.id,
        newPath: updated.id,
        title: updated.title,
      });
      refreshNotes();
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
  }, [
    navigate,
    note.id,
    note.notebook_id,
    refreshNotes,
    renameNoteRefs,
  ]);

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
    if (saveRequest === lastSaveRequest.current) return;
    lastSaveRequest.current = saveRequest;
    if (locked) return;
    void save();
  }, [locked, save, saveRequest]);

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

  async function toggleLock() {
    if (locked) {
      setLocked(false);
      return;
    }
    // Presentation mode should never freeze an unsaved draft.
    if (dirty) {
      const saved = await save();
      if (!saved) return;
    }
    setLocked(true);
    editorRef.current?.blur();
  }

  const navigateTag = useCallback(
    async (tag: string) => {
      if (dirty) {
        const saved = await save();
        if (!saved) return;
      }
      navigate({ view: "tag", tag });
    },
    [dirty, navigate, save],
  );

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
        navigate({ view: "note", noteId: hit.path });
        return;
      }

      // Do not fall back to full-text search here: the current note contains
      // the link text, so a fuzzy hit would just re-open it. Only an exact
      // title/path match may navigate; otherwise offer to create the page.
      if (locked || needle.includes("/")) return;
      if (!window.confirm(`Create a new page named “${target}”?`)) return;

      try {
        const created = await api.createNote(note.notebook_id, {
          title: target,
          content: "",
        });
        navigate({ view: "note", noteId: created.id });
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
      locked,
      note.notebook_id,
      refresh,
      save,
      navigate,
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
      navigate({ view: "journal" });
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
    <main className="min-h-0 flex-1 overflow-y-auto bg-canvas px-5 py-4">
      <div className="mx-auto w-full max-w-4xl pb-16">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <input
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                touch();
              }}
              onKeyDown={(event) => {
                if (!locked && event.key === "Enter") {
                  event.preventDefault();
                  editorRef.current?.focus();
                }
              }}
              placeholder="Untitled note"
              maxLength={300}
              readOnly={locked}
              autoFocus={
                !locked && note.title === "Untitled" && note.content === ""
              }
              className={`w-full bg-transparent font-serif text-[24px] font-semibold leading-tight tracking-tight text-ink outline-none placeholder:text-faint ${
                locked ? "cursor-default" : ""
              }`}
              aria-label="Note title"
            />
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[14px] text-faint">
              <span
                className={`inline-flex items-center gap-1 ${
                  status === "error" ? "text-danger" : ""
                }`}
              >
                {locked ? (
                  <IconLock className="h-3 w-3 text-accent" />
                ) : status === "saved" ? (
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
                {locked ? "Read only" : statusLabel}
              </span>
              <span>{wordCount(content)} words</span>
              <span>Updated {relativeTime(note.updated_at)}</span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                toggleFavorite({
                  notebookId: note.notebook_id,
                  path: note.id,
                  title: note.title,
                })
              }
              className={`inline-flex h-[35px] w-[35px] shrink-0 items-center justify-center rounded-lg border p-0 transition ${
                isFavorite
                  ? "border-accent/30 bg-accent-soft text-accent-strong"
                  : "border-line bg-white/70 text-faint hover:border-line-strong hover:bg-white hover:text-ink"
              }`}
              aria-pressed={isFavorite}
              aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
              title={isFavorite ? "Remove from favorites" : "Add to favorites"}
            >
              {isFavorite ? (
                <IconStarFilled className="h-4 w-4" />
              ) : (
                <IconStar className="h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              onClick={() => void toggleLock()}
              aria-pressed={locked}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[14px] font-medium transition ${
                locked
                  ? "border-accent/30 bg-accent-soft text-accent-strong"
                  : "border-line bg-white/70 text-ink-soft hover:border-line-strong hover:bg-white"
              }`}
              title={locked ? "Unlock editing" : "Lock as read-only"}
            >
              {locked ? (
                <IconLock className="h-3.5 w-3.5" />
              ) : (
                <IconLockOpen className="h-3.5 w-3.5" />
              )}
              {locked ? "Read only" : "Lock"}
            </button>
            {!locked && (
              <button
                type="button"
                onClick={() => void save()}
                disabled={status === "saving"}
                className="rounded-lg border border-line bg-white/70 px-2.5 py-1.5 text-[14px] font-medium text-ink-soft transition hover:border-line-strong hover:bg-white disabled:opacity-50"
                title={`Save (${bindingLabel("editor.save", settings.keybindings)})`}
              >
                Save
              </button>
            )}
            {!locked && (
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
            )}
          </div>
        </div>

        {locked ? (
          <div className="mt-3 flex min-h-[1.8rem] flex-wrap items-center gap-1.5 border-b border-line pb-2">
            <IconTag className="h-3.5 w-3.5 shrink-0 text-faint" />
            {note.tags.length > 0 ? (
              note.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => navigateTag(tag)}
                  className="rounded-md border border-line bg-white/60 px-1.5 py-0.5 font-mono text-[14px] text-ink-soft transition hover:border-accent/30 hover:bg-accent-soft hover:text-accent-strong"
                  title={`Open #${tag}`}
                >
                  #{tag}
                </button>
              ))
            ) : (
              <span className="font-mono text-[14px] text-faint">
                No tags
              </span>
            )}
          </div>
        ) : (
          <label className="mt-3 flex items-center gap-2 border-b border-line pb-2">
            <IconTag className="h-3.5 w-3.5 shrink-0 text-faint" />
            <input
              value={tagsInput}
              onChange={(event) => {
                setTagsInput(event.target.value);
                touch();
              }}
              placeholder="Tags, comma separated — inline #tags are indexed too"
              className="min-w-0 flex-1 bg-transparent font-mono text-[14px] text-ink-soft outline-none placeholder:text-faint"
              aria-label="Tags"
            />
            {tagsInput.trim() && (
              <span className="shrink-0 font-mono text-[14px] text-faint">
                {parseTags(tagsInput).length}{" "}
                {parseTags(tagsInput).length === 1 ? "tag" : "tags"}
              </span>
            )}
          </label>
        )}

        <div className="note-editor-surface mt-3 overflow-hidden rounded-xl border border-line bg-paper focus-within:border-accent/40">
          <LiveMarkdownEditor
            ref={editorRef}
            value={content}
            onChange={(next) => {
              setContent(next);
              touch();
            }}
            onWikiLink={navigateWiki}
            onTag={(tag) => void navigateTag(tag)}
            notebookId={note.notebook_id}
            notePath={note.id}
            linkKeys={linkKeys}
            linkTargets={linkTargets}
            readOnly={locked}
            autoHeight
          />
          <div className="flex items-center justify-between border-t border-line bg-panel/30 px-3 py-1.5 font-mono text-[14px] uppercase tracking-[0.13em] text-faint">
            <span>{locked ? "Read only" : "Live blocks"}</span>
            <span className="normal-case tracking-normal">
              {locked
                ? "Click a link to navigate"
                : "[[ link ]] · # tag · - block"}
            </span>
          </div>
        </div>

        {message && (
          <p className="mt-2 rounded-lg bg-danger/10 px-3 py-2 font-mono text-[14px] text-danger">
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
        <p className="mt-2 font-mono text-[14px] leading-relaxed text-muted">
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
