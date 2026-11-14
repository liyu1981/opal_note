import { useEffect, useRef, useState, type FormEvent } from "react";

import { api } from "../api/client";
import type { Notebook } from "../api/types";
import { IconPencil, IconX } from "./Icons";

const MAX_NAME_CHARS = 120;

/**
 * Structural rename: the server renames `data/notebooks/<old>` on disk, drops
 * every index row for the notebook and re-reads all of its markdown files under
 * the new id. The dialog stays open while that blocking work runs so the user
 * sees both the warning and the elapsed reindex time.
 */
export function RenameNotebookDialog({
  notebook,
  onClose,
  onRenamed,
}: {
  notebook: Notebook;
  onClose: () => void;
  onRenamed: (renamed: Notebook) => void;
}) {
  const [name, setName] = useState(notebook.name);
  const [renaming, setRenaming] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const startedAt = useRef(0);

  const trimmed = name.trim();
  const unchanged = trimmed === notebook.name;
  const canSubmit = trimmed.length > 0 && !unchanged && !renaming;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  useEffect(() => {
    if (!renaming) return;
    startedAt.current = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [renaming]);

  useEffect(() => {
    if (renaming) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, renaming]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setRenaming(true);
    setError(null);
    try {
      const renamed = await api.updateNotebook(notebook.id, { name: trimmed });
      onRenamed(renamed);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not rename notebook",
      );
      setRenaming(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 px-4 pt-[10vh] backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !renaming) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="animate-fade-up flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-canvas shadow-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-notebook-title"
        aria-busy={renaming}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3">
          <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent-strong">
            <IconPencil className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="rename-notebook-title"
              className="font-serif text-lg font-semibold leading-tight text-ink"
            >
              Rename notebook
            </h2>
            <p className="mt-0.5 font-mono text-[14px] leading-relaxed text-muted">
              Rename the notebook folder and rebuild its index.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={renaming}
            className="rounded-md p-1 text-faint transition hover:bg-panel hover:text-ink disabled:opacity-40"
            aria-label="Close"
          >
            <IconX className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-3 px-4 py-4">
          <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 font-mono text-[14px] leading-relaxed text-ink-soft">
            <p>
              The folder{" "}
              <span className="text-ink">notebooks/{notebook.name}</span> is
              renamed on disk. The notebook&apos;s index (search, tags, links
              and tasks) is deleted and rebuilt from its Markdown files.
            </p>
            <p className="mt-1.5 text-muted">
              {notebook.note_count}{" "}
              {notebook.note_count === 1 ? "note" : "notes"} will be reindexed.
              This can take a while on large notebooks, so keep this tab open
              until it finishes.
            </p>
          </div>

          <label className="block">
            <span className="mb-1 block font-mono text-[14px] uppercase tracking-[0.1em] text-faint">
              New name
            </span>
            <input
              ref={inputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={MAX_NAME_CHARS}
              disabled={renaming}
              className="w-full rounded-md border border-line bg-white px-2.5 py-1.5 font-mono text-[14px] text-ink outline-none focus:border-accent disabled:opacity-60"
              aria-label="Notebook name"
            />
          </label>

          <p className="font-mono text-[14px] leading-relaxed text-faint">
            {
              `Folder: notebooks/${notebook.name} → notebooks/${trimmed || "…"}`
            }
            {trimmed !== notebook.name && /[/\\]/u.test(trimmed) && (
              <span className="block text-muted">
                Slashes and control characters are replaced with “-”.
              </span>
            )}
          </p>

          {error && (
            <p
              role="alert"
              className="rounded-lg bg-danger/10 px-3 py-2 font-mono text-[14px] leading-relaxed text-danger"
            >
              {error}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-line px-3 py-2.5">
          <span
            role="status"
            className="inline-flex min-w-0 items-center gap-2 font-mono text-[14px] text-muted"
          >
            {renaming ? (
              <>
                <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent" />
                <span className="truncate">
                  Renaming and reindexing…{" "}
                  <span aria-hidden="true">{elapsed}s</span>
                </span>
              </>
            ) : (
              <span className="truncate text-faint">
                {unchanged
                  ? "Enter a different name to rename."
                  : "The old index is discarded."}
              </span>
            )}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={renaming}
              className="rounded-lg px-2.5 py-1.5 font-mono text-[14px] text-muted transition hover:bg-panel disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-strong px-3 py-1.5 font-mono text-[14px] transition hover:bg-accent-strong/85 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <IconPencil className="h-3 w-3" />
              {renaming ? "Renaming…" : "Rename"}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
