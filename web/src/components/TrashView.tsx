import { useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import type {
  TrashDetail,
  TrashEntry,
  TrashKind,
  TrashList,
  TrashRestoreResult,
} from "../api/types";
import { formatBytes } from "../lib/assets";
import { relativeTime } from "../lib/format";
import { formatJournalDate } from "../lib/journal";
import { settingsAtom } from "../lib/settings";
import { useViewAutoFocus } from "../lib/useViewFocus";
import { readOnlyAtom, refreshAtom } from "../state/atoms";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCalendar,
  IconFile,
  IconFolder,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
} from "./Icons";

const PAGE_SIZE = 20;

const KIND_LABELS: Record<TrashKind, string> = {
  page: "Page",
  journal: "Journal",
  asset: "Asset",
  notebook: "Notebook",
};

type SortValue = "deleted_at:desc" | "deleted_at:asc" | "title:asc" | "size:desc";

export function TrashView() {
  const locked = useAtomValue(readOnlyAtom);
  const settings = useAtomValue(settingsAtom);
  const refresh = useSetAtom(refreshAtom);

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [kind, setKind] = useState<"" | TrashKind>("");
  const [sortValue, setSortValue] = useState<SortValue>("deleted_at:desc");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<TrashList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<TrashEntry | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  useViewAutoFocus("trash", () => mainRef.current?.focus());

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(0);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const [sort, dir] = sortValue.split(":");
    api
      .listTrash({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        q: debouncedQuery || undefined,
        kind: kind || undefined,
        sort,
        dir,
      })
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(
          cause instanceof Error ? cause.message : "Could not load the trash",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, kind, page, sortValue, tick]);

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);

  function reload() {
    setTick((value) => value + 1);
  }

  function handleRestored(result: TrashRestoreResult) {
    setSelected(null);
    refresh();
    reload();
    if (result.kind === "notebook") {
      window.alert(`Restored notebook “${result.restored_path}”.`);
    } else {
      window.alert(
        `Restored to ${result.notebook_name}/${result.restored_path}.`,
      );
    }
  }

  function handleDeleted() {
    setSelected(null);
    reload();
  }

  return (
    <main
      ref={mainRef}
      tabIndex={-1}
      className="min-h-0 flex-1 overflow-y-auto bg-transparent outline-none"
    >
      <div className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6">
        <header className="flex flex-wrap items-center gap-2 border-b border-line pb-3">
          <div className="min-w-0 flex-1">
            <h1 className="font-serif text-[22px] font-semibold tracking-tight text-ink">
              Trash
            </h1>
            <p className="mt-0.5 font-mono text-[14px] leading-relaxed text-muted">
              Deleted pages, assets and notebooks stay here for{" "}
              {settings.trashRetentionDays} days. Restore them before they are
              permanently removed.
            </p>
          </div>
          <button
            type="button"
            onClick={reload}
            className="rounded-md border border-transparent p-1.5 text-muted transition hover:border-line hover:bg-white/60 hover:text-ink"
            aria-label="Refresh trash"
            title="Refresh"
          >
            <IconRefresh className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex h-8 min-w-[12rem] flex-1 items-center gap-2 rounded-lg border border-line bg-white/60 px-2.5 focus-within:border-accent focus-within:bg-white sm:max-w-sm">
            <IconSearch className="h-3.5 w-3.5 shrink-0 text-faint" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by title, path or notebook…"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent font-sans text-[14px] text-ink outline-none placeholder:text-faint"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="rounded p-0.5 text-faint hover:text-ink"
                aria-label="Clear trash filter"
              >
                <IconX className="h-3 w-3" />
              </button>
            )}
          </div>

          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as "" | TrashKind);
              setPage(0);
            }}
            className="h-8 rounded-md border border-line bg-white/70 px-2 font-mono text-[14px] text-ink-soft outline-none focus:border-accent"
            aria-label="Trash kind"
          >
            <option value="">All kinds</option>
            <option value="page">Pages</option>
            <option value="journal">Journals</option>
            <option value="asset">Assets</option>
            <option value="notebook">Notebooks</option>
          </select>

          <select
            value={sortValue}
            onChange={(event) => {
              setSortValue(event.target.value as SortValue);
              setPage(0);
            }}
            className="h-8 rounded-md border border-line bg-white/70 px-2 font-mono text-[14px] text-ink-soft outline-none focus:border-accent"
            aria-label="Trash sort"
          >
            <option value="deleted_at:desc">Newest deleted</option>
            <option value="deleted_at:asc">Oldest deleted</option>
            <option value="title:asc">Name A–Z</option>
            <option value="size:desc">Largest first</option>
          </select>
        </div>

        {error ? (
          <p className="mt-4 rounded-lg bg-danger/10 px-3 py-2 font-mono text-[14px] text-danger">
            {error}
          </p>
        ) : loading && !data ? (
          <p className="mt-16 text-center font-mono text-[14px] text-faint">
            Loading trash…
          </p>
        ) : !data || data.entries.length === 0 ? (
          <div className="mt-16 text-center">
            <IconTrash className="mx-auto h-6 w-6 text-faint" />
            <p className="mt-2 font-mono text-[14px] text-muted">
              {debouncedQuery || kind
                ? "Nothing in the trash matches this filter."
                : "The trash is empty."}
            </p>
          </div>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-xl border border-line bg-paper">
            <table className="w-full min-w-[880px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-panel/35 font-mono text-[12px] uppercase tracking-[0.08em] text-faint">
                  <th className="w-[34%] py-2 pl-4 pr-3 font-normal">Item</th>
                  <th className="w-[15%] py-2 pr-3 font-normal">Notebook</th>
                  <th className="w-24 py-2 pr-3 font-normal">Kind</th>
                  <th className="w-32 py-2 pr-3 font-normal">Deleted</th>
                  <th className="w-32 py-2 pr-3 font-normal">Expires</th>
                  <th className="w-20 py-2 pr-3 font-normal">Size</th>
                  <th className="w-40 py-2 pr-4 font-normal">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((entry) => (
                  <TrashRow
                    key={entry.id}
                    entry={entry}
                    locked={locked}
                    onOpen={() => setSelected(entry)}
                    onChanged={() => {
                      refresh();
                      reload();
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pageCount > 1 && (
          <div className="mt-3 flex items-center justify-between gap-2 font-mono text-[14px] text-muted">
            <span>
              {total} {total === 1 ? "item" : "items"} · page {page + 1} of{" "}
              {pageCount}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPage((value) => Math.max(0, value - 1))}
                disabled={page === 0}
                className="inline-flex items-center gap-1 rounded-md border border-line bg-white/60 px-2 py-1 transition hover:bg-white disabled:opacity-40"
              >
                <IconArrowLeft className="h-3 w-3" />
                Previous
              </button>
              <button
                type="button"
                onClick={() =>
                  setPage((value) => Math.min(pageCount - 1, value + 1))
                }
                disabled={page >= pageCount - 1}
                className="inline-flex items-center gap-1 rounded-md border border-line bg-white/60 px-2 py-1 transition hover:bg-white disabled:opacity-40"
              >
                Next
                <IconArrowRight className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}
      </div>

      {selected && (
        <TrashDetailDialog
          entry={selected}
          locked={locked}
          onClose={() => setSelected(null)}
          onRestored={handleRestored}
          onDeleted={handleDeleted}
        />
      )}
    </main>
  );
}

function TrashRow({
  entry,
  locked,
  onOpen,
  onChanged,
}: {
  entry: TrashEntry;
  locked: boolean;
  onOpen: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<"restore" | "delete" | null>(null);

  async function restore() {
    if (locked || busy) return;
    setBusy("restore");
    try {
      await api.restoreTrash(entry.id);
      onChanged();
    } catch (cause) {
      window.alert(
        cause instanceof Error ? cause.message : "Could not restore item",
      );
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (locked || busy) return;
    if (
      !window.confirm(
        `Permanently delete “${entry.title}”? This cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy("delete");
    try {
      await api.deleteTrash(entry.id);
      onChanged();
    } catch (cause) {
      window.alert(
        cause instanceof Error ? cause.message : "Could not delete item",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <tr
      onClick={onOpen}
      className="cursor-pointer border-b border-line/45 transition last:border-0 hover:bg-white/50"
      title="Preview"
    >
      <td className="py-2 pl-4 pr-3">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 shrink-0 text-faint">
            {entry.kind === "notebook" ? (
              <IconFolder className="h-3.5 w-3.5" />
            ) : entry.kind === "journal" ? (
              <IconCalendar className="h-3.5 w-3.5" />
            ) : (
              <IconFile className="h-3.5 w-3.5" />
            )}
          </span>
          <div className="min-w-0">
            <span className="block truncate font-sans text-[14px] font-medium text-ink">
              {entry.kind === "journal"
                ? formatJournalDate(entry.title)
                : entry.title}
            </span>
            <span className="mt-0.5 block truncate font-mono text-[12px] text-faint">
              {entry.original_path}
            </span>
            {entry.preview && (
              <span className="mt-0.5 block truncate font-mono text-[12px] text-muted">
                {entry.preview}
              </span>
            )}
          </div>
        </div>
      </td>
      <td className="py-2 pr-3 font-mono text-[13px] text-muted">
        <span className="block truncate" title={entry.notebook_name}>
          {entry.notebook_name}
        </span>
      </td>
      <td className="py-2 pr-3 font-mono text-[13px] text-muted">
        {KIND_LABELS[entry.kind]}
      </td>
      <td className="py-2 pr-3 font-mono text-[13px] text-muted">
        {relativeTime(entry.deleted_at)}
      </td>
      <td className="py-2 pr-3 font-mono text-[13px] text-muted">
        {relativeTime(entry.expires_at)}
      </td>
      <td className="py-2 pr-3 font-mono text-[13px] text-muted">
        {formatBytes(entry.size)}
      </td>
      <td className="py-2 pr-4">
        <div
          className="flex items-center gap-1"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => void restore()}
            disabled={locked || busy !== null}
            className="rounded-md border border-line bg-white/60 px-2 py-1 font-mono text-[12px] text-ink-soft transition hover:bg-white hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === "restore" ? "Restoring…" : "Restore"}
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={locked || busy !== null}
            className="rounded-md border border-transparent p-1 text-faint transition hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={`Permanently delete ${entry.title}`}
            title="Delete forever"
          >
            <IconTrash className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function TrashDetailDialog({
  entry,
  locked,
  onClose,
  onRestored,
  onDeleted,
}: {
  entry: TrashEntry;
  locked: boolean;
  onClose: () => void;
  onRestored: (result: TrashRestoreResult) => void;
  onDeleted: () => void;
}) {
  const [detail, setDetail] = useState<TrashDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<"restore" | "delete" | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const isImage = entry.kind === "asset" && entry.mime.startsWith("image/");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getTrash(entry.id)
      .then((next) => {
        if (!cancelled) {
          setDetail(next);
          setError(null);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load this trash entry",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry.id]);

  useEffect(() => {
    if (!isImage) {
      setImageUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    api
      .getTrashBlob(entry.id)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setImageUrl(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [entry.id, isImage]);

  useEffect(() => {
    if (acting) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [acting, onClose]);

  async function restore() {
    if (locked || acting) return;
    setActing("restore");
    try {
      onRestored(await api.restoreTrash(entry.id));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not restore item",
      );
      setActing(null);
    }
  }

  async function remove() {
    if (locked || acting) return;
    if (
      !window.confirm(
        `Permanently delete “${entry.title}”? This cannot be undone.`,
      )
    ) {
      return;
    }
    setActing("delete");
    try {
      await api.deleteTrash(entry.id);
      onDeleted();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not delete item",
      );
      setActing(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 px-4 pt-[8vh] backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !acting) onClose();
      }}
    >
      <div
        className="animate-fade-up flex max-h-[min(44rem,86vh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-canvas shadow-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trash-detail-title"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3">
          <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-panel-strong text-muted">
            {entry.kind === "notebook" ? (
              <IconFolder className="h-4 w-4" />
            ) : entry.kind === "journal" ? (
              <IconCalendar className="h-4 w-4" />
            ) : (
              <IconFile className="h-4 w-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="trash-detail-title"
              className="truncate font-serif text-lg font-semibold leading-tight text-ink"
            >
              {entry.kind === "journal"
                ? formatJournalDate(entry.title)
                : entry.title}
            </h2>
            <p className="mt-0.5 truncate font-mono text-[13px] text-faint">
              {entry.kind === "notebook"
                ? entry.notebook_name
                : `${entry.notebook_name}/${entry.original_path}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={acting !== null}
            className="rounded-md p-1 text-faint transition hover:bg-panel hover:text-ink disabled:opacity-40"
            aria-label="Close"
          >
            <IconX className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[13px]">
            <Meta label="Kind" value={KIND_LABELS[entry.kind]} />
            <Meta label="Size" value={formatBytes(entry.size)} />
            <Meta label="Deleted" value={relativeTime(entry.deleted_at)} />
            <Meta label="Expires" value={relativeTime(entry.expires_at)} />
          </dl>

          <div className="mt-3 border-t border-line pt-3">
            {loading ? (
              <p className="py-8 text-center font-mono text-[14px] text-faint">
                Loading preview…
              </p>
            ) : error ? (
              <p className="rounded-lg bg-danger/10 px-3 py-2 font-mono text-[14px] text-danger">
                {error}
              </p>
            ) : isImage ? (
              imageUrl ? (
                <img
                  src={imageUrl}
                  alt={entry.title}
                  className="mx-auto max-h-[min(28rem,50vh)] rounded-lg border border-line object-contain"
                />
              ) : (
                <p className="py-8 text-center font-mono text-[14px] text-faint">
                  Loading image…
                </p>
              )
            ) : detail?.content != null ? (
              <>
                <pre className="max-h-[min(28rem,50vh)] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[13px] leading-relaxed text-ink-soft">
                  {detail.content || "This file is empty."}
                </pre>
                {detail.truncated && (
                  <p className="mt-1 font-mono text-[12px] text-faint">
                    Preview truncated. Restore the item to read all of it.
                  </p>
                )}
              </>
            ) : (
              <p className="py-8 text-center font-mono text-[14px] text-muted">
                No inline preview for this{" "}
                {entry.kind === "asset" ? "file type" : "item"}. Restore it to
                open.
              </p>
            )}
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-3 py-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={acting !== null}
            className="rounded-lg px-2.5 py-1.5 font-mono text-[14px] text-muted transition hover:bg-panel disabled:opacity-40"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={locked || acting !== null}
            className="inline-flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 font-mono text-[14px] transition hover:bg-danger/85 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <IconTrash className="h-3 w-3" />
            {acting === "delete" ? "Deleting…" : "Delete forever"}
          </button>
          <button
            type="button"
            onClick={() => void restore()}
            disabled={locked || acting !== null}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent-strong px-3 py-1.5 font-mono text-[14px] transition hover:bg-accent-strong/85 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {acting === "restore" ? "Restoring…" : "Restore"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="shrink-0 uppercase tracking-[0.08em] text-faint">
        {label}
      </dt>
      <dd className="truncate text-ink-soft">{value}</dd>
    </div>
  );
}
