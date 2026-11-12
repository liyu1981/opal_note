import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";
import type { PageOverview } from "../api/types";
import { formatJournalDate } from "../lib/journal";
import {
  IconCalendar,
  IconFile,
  IconTrash,
  IconX,
} from "./Icons";

export function OrphanDialog({
  notebookId,
  onClose,
  onDeleted,
}: {
  notebookId: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [pages, setPages] = useState<PageOverview[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listOrphans(notebookId)
      .then((found) => {
        if (cancelled) return;
        setPages(found);
        setSelected(new Set(found.map((page) => page.id)));
        setError(null);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : "Could not find orphans",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [notebookId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !deleting) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleting, onClose]);

  const chosen = useMemo(
    () => (pages ?? []).filter((page) => selected.has(page.id)),
    [pages, selected],
  );

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (!pages) return;
    setSelected((current) =>
      current.size === pages.length
        ? new Set()
        : new Set(pages.map((page) => page.id)),
    );
  }

  async function removeSelected() {
    if (chosen.length === 0 || deleting) return;
    setDeleting(true);
    setError(null);
    let removed = 0;
    try {
      for (const page of chosen) {
        await api.deleteNote(notebookId, page.id);
        removed += 1;
      }
      onDeleted();
      onClose();
    } catch (cause) {
      if (removed > 0) onDeleted();
      setError(
        cause instanceof Error
          ? `${removed} deleted, then: ${cause.message}`
          : "Could not delete orphan pages",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 px-4 pt-[10vh] backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !deleting) onClose();
      }}
    >
      <div
        className="animate-fade-up flex max-h-[min(36rem,80vh)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-canvas shadow-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="orphans-title"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3">
          <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-danger/10 text-danger">
            <IconTrash className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="orphans-title"
              className="font-serif text-lg leading-tight text-ink"
            >
              Clean orphan pages
            </h2>
            <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-muted">
              Empty pages with no backlinks. Deleted files move to the server
              trash.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="rounded-md p-1 text-faint transition hover:bg-panel hover:text-ink disabled:opacity-40"
            aria-label="Close"
          >
            <IconX className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {loading ? (
            <p className="px-3 py-8 text-center font-mono text-[10.5px] text-faint">
              Finding orphan pages…
            </p>
          ) : error ? (
            <p className="mx-2 rounded-lg bg-danger/10 px-3 py-2 font-mono text-[10.5px] text-danger">
              {error}
            </p>
          ) : !pages || pages.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="font-mono text-[11px] text-ink-soft">
                No orphan pages.
              </p>
              <p className="mt-1 font-mono text-[9.5px] text-faint">
                Empty pages will appear here when nothing links to them.
              </p>
            </div>
          ) : (
            <>
              <label className="mb-1 flex items-center gap-2 rounded-md px-2 py-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-faint">
                <input
                  type="checkbox"
                  checked={selected.size === pages.length}
                  onChange={toggleAll}
                  className="accent-accent"
                />
                Select all · {pages.length}{" "}
                {pages.length === 1 ? "page" : "pages"}
              </label>
              {pages.map((page) => {
                const journal = page.id.startsWith("journals/");
                return (
                  <label
                    key={page.id}
                    className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 transition hover:bg-panel/70"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(page.id)}
                      onChange={() => toggle(page.id)}
                      className="mt-0.5 accent-accent"
                    />
                    <span className="mt-0.5 text-faint">
                      {journal ? (
                        <IconCalendar className="h-3.5 w-3.5" />
                      ) : (
                        <IconFile className="h-3.5 w-3.5" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11px] text-ink">
                        {journal
                          ? formatJournalDate(page.title)
                          : page.title}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[8.5px] text-faint">
                        {page.id}
                      </span>
                    </span>
                  </label>
                );
              })}
            </>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-line px-3 py-2.5">
          <span className="font-mono text-[9px] text-faint">
            {chosen.length} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={deleting}
              className="rounded-lg px-2.5 py-1.5 font-mono text-[10px] text-muted transition hover:bg-panel disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void removeSelected()}
              disabled={
                deleting ||
                loading ||
                !!error ||
                !pages ||
                pages.length === 0 ||
                chosen.length === 0
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 font-mono text-[10px] text-white transition hover:bg-danger/85 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <IconTrash className="h-3 w-3" />
              {deleting
                ? "Deleting…"
                : `Delete ${chosen.length || ""}`.trim()}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
