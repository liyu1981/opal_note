import { useEffect, useMemo, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import type { PageList, PageOverview } from "../api/types";
import { compactTime } from "../lib/format";
import { formatJournalDate } from "../lib/journal";
import { useAppNavigate } from "../lib/appNavigation";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCalendar,
  IconFile,
  IconFilter,
  IconLayoutGrid,
  IconPlus,
  IconRows,
  IconSearch,
  IconSort,
  IconTable,
  IconTrash,
  IconX,
} from "./Icons";
import { OrphanDialog } from "./OrphanDialog";
import {
  activeNotebookIdAtom,
  notesRevisionAtom,
  pagesPageSizeAtom,
  readOnlyAtom,
  refreshAtom,
} from "../state/atoms";

type SortKey = "title" | "backlinks" | "tags" | "created_at" | "updated_at";
type SortDir = "asc" | "desc";
type ViewMode = "table" | "cards";

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200] as const;

export function PagesView() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const revision = useAtomValue(notesRevisionAtom);
  const locked = useAtomValue(readOnlyAtom);
  const navigate = useAppNavigate();
  const refresh = useSetAtom(refreshAtom);

  const [storedPageSize, setStoredPageSize] = useAtom(pagesPageSizeAtom);
  const pageSize = (PAGE_SIZE_OPTIONS as readonly number[]).includes(
    storedPageSize,
  )
    ? storedPageSize
    : 20;

  const [mode, setMode] = useState<ViewMode>("table");
  const [sortKey, setSortKey] = useState<SortKey>("updated_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [tagFilter, setTagFilter] = useState("");
  const [allTags, setAllTags] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<PageList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [orphansOpen, setOrphansOpen] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!notebookId) {
      setAllTags([]);
      return;
    }
    let cancelled = false;
    api
      .listTags(notebookId)
      .then((tags) => {
        if (!cancelled) setAllTags(tags.map((tag) => tag.tag).sort());
      })
      .catch(() => {
        if (!cancelled) setAllTags([]);
      });
    return () => {
      cancelled = true;
    };
  }, [notebookId, revision]);

  useEffect(() => {
    if (!notebookId) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .listPages(notebookId, {
        limit: pageSize,
        offset: page * pageSize,
        q: debouncedQuery || undefined,
        tag: tagFilter || undefined,
        sort: sortKey,
        dir: sortDir,
      })
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
        const lastPage = Math.max(0, Math.ceil(result.total / pageSize) - 1);
        if (page > lastPage) setPage(lastPage);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : "Could not load pages",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    notebookId,
    page,
    pageSize,
    debouncedQuery,
    tagFilter,
    sortKey,
    sortDir,
    revision,
  ]);

  const pages = data?.pages ?? [];
  const total = data?.total ?? 0;
  const offset = data?.offset ?? page * pageSize;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const tagOptions = useMemo(
    () => (tagFilter && !allTags.includes(tagFilter) ? [tagFilter, ...allTags] : allTags),
    [allTags, tagFilter],
  );

  if (!notebookId) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-canvas p-8">
        <p className="max-w-sm text-center font-mono text-[11.5px] leading-relaxed text-muted">
          Select or create a notebook to browse its pages.
        </p>
      </main>
    );
  }

  function toggleSort(key: SortKey) {
    setPage(0);
    if (key === sortKey) {
      setSortDir((direction) => (direction === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "title" || key === "tags" ? "asc" : "desc");
  }

  function chooseTag(tag: string) {
    setTagFilter(tag);
    setPage(0);
  }

  function openPage(item: PageOverview) {
    navigate({ view: "note", noteId: item.id });
  }

  function choosePageSize(value: string) {
    setStoredPageSize(Number(value));
    setPage(0);
  }

  async function createPage() {
    if (!notebookId || locked || creating) return;
    setCreating(true);
    try {
      const note = await api.createNote(notebookId, {
        title: "Untitled",
        content: "",
      });
      navigate({ view: "note", noteId: note.id });
      refresh();
    } catch (cause) {
      window.alert(
        cause instanceof Error ? cause.message : "Could not create page",
      );
    } finally {
      setCreating(false);
    }
  }

  const showEmpty = !loading && !error && total === 0;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-canvas">
      <div className="mx-auto w-full max-w-6xl px-6 py-6">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <IconTable className="h-4 w-4 text-muted" />
            <h1 className="font-mono text-[13px] font-semibold tracking-tight text-ink">
              All
            </h1>
            <span className="rounded-full bg-panel px-1.5 py-0.5 font-mono text-[9px] text-faint">
              {total}
            </span>
            <button
              type="button"
              onClick={() => void createPage()}
              disabled={locked || creating}
              className="ml-1 rounded-md border border-line bg-white/50 p-1 text-muted transition hover:border-line-strong hover:bg-white hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="New page"
              title={locked ? "Read only" : "New page"}
            >
              <IconPlus className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => setOrphansOpen(true)}
              disabled={locked}
              className="inline-flex items-center gap-1 rounded-md border border-transparent px-1.5 py-1 font-mono text-[9px] text-muted transition hover:border-line hover:bg-white/60 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
              title={locked ? "Read only" : "Clean orphan pages"}
              aria-label="Clean orphan pages"
            >
              <IconTrash className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Clean</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setPage(0);
                setSortDir((direction) =>
                  direction === "asc" ? "desc" : "asc",
                );
              }}
              className="inline-flex items-center gap-1 rounded-md border border-transparent px-1.5 py-1 font-mono text-[9px] text-muted transition hover:border-line hover:bg-white/60 hover:text-ink"
              title={`Sort ${sortLabel(sortKey)} ${sortDir === "asc" ? "ascending" : "descending"}`}
              aria-label="Toggle sort direction"
            >
              <IconSort className="h-3.5 w-3.5" />
              <span>{sortDir === "asc" ? "↑" : "↓"}</span>
            </button>

            <label
              className="relative inline-flex items-center rounded-md border border-transparent text-muted transition hover:border-line hover:bg-white/60 hover:text-ink focus-within:border-line focus-within:bg-white/60"
              title="Filter by tag"
            >
              <IconFilter className="pointer-events-none absolute left-1.5 h-3.5 w-3.5" />
              <select
                value={tagFilter}
                onChange={(event) => chooseTag(event.target.value)}
                className="max-w-[9rem] appearance-none bg-transparent py-1 pl-7 pr-2 font-mono text-[9px] outline-none"
                aria-label="Filter by tag"
              >
                <option value="">All tags</option>
                {tagOptions.map((tag) => (
                  <option key={tag} value={tag}>
                    #{tag}
                  </option>
                ))}
              </select>
            </label>

            {searchOpen ? (
              <div className="relative">
                <IconSearch className="pointer-events-none absolute left-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setPage(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setQuery("");
                      setPage(0);
                      setSearchOpen(false);
                    }
                  }}
                  placeholder="Filter pages…"
                  className="w-36 rounded-md border border-line bg-white/70 py-1 pl-7 pr-6 font-mono text-[9.5px] text-ink outline-none focus:border-accent/60"
                  aria-label="Filter pages"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setPage(0);
                    }}
                    className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-faint hover:text-ink"
                    aria-label="Clear page filter"
                  >
                    <IconX className="h-3 w-3" />
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className="rounded-md border border-transparent p-1.5 text-muted transition hover:border-line hover:bg-white/60 hover:text-ink"
                aria-label="Filter pages"
                title="Filter pages"
              >
                <IconSearch className="h-3.5 w-3.5" />
              </button>
            )}

            <button
              type="button"
              onClick={() =>
                setMode((current) => (current === "table" ? "cards" : "table"))
              }
              className="rounded-md border border-transparent p-1.5 text-muted transition hover:border-line hover:bg-white/60 hover:text-ink"
              aria-label={mode === "table" ? "Show as cards" : "Show as table"}
              title={mode === "table" ? "Show as cards" : "Show as table"}
            >
              {mode === "table" ? (
                <IconLayoutGrid className="h-3.5 w-3.5" />
              ) : (
                <IconRows className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </header>

        {error ? (
          <p className="mt-4 rounded-lg bg-danger/10 px-3 py-2 font-mono text-[10.5px] text-danger">
            {error}
          </p>
        ) : loading && !data ? (
          <p className="mt-16 text-center font-mono text-[11px] text-faint">
            Loading pages…
          </p>
        ) : showEmpty ? (
          <div className="mt-16 text-center">
            <p className="font-mono text-[12px] text-muted">
              {debouncedQuery || tagFilter
                ? "No pages match this filter."
                : "No pages yet. Create one with +."}
            </p>
          </div>
        ) : mode === "table" ? (
          <div className="mt-3 overflow-x-auto rounded-xl border border-line bg-white/25">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-panel/35">
                  <SortHeader
                    label="Page name"
                    column="title"
                    active={sortKey}
                    direction={sortDir}
                    onSort={toggleSort}
                    className="w-[38%] pl-4"
                  />
                  <SortHeader
                    label="Backlinks"
                    column="backlinks"
                    active={sortKey}
                    direction={sortDir}
                    onSort={toggleSort}
                    className="w-24"
                  />
                  <SortHeader
                    label="Tags"
                    column="tags"
                    active={sortKey}
                    direction={sortDir}
                    onSort={toggleSort}
                    className="w-[24%]"
                  />
                  <SortHeader
                    label="Created At"
                    column="created_at"
                    active={sortKey}
                    direction={sortDir}
                    onSort={toggleSort}
                    className="w-[15%]"
                  />
                  <SortHeader
                    label="Updated At"
                    column="updated_at"
                    active={sortKey}
                    direction={sortDir}
                    onSort={toggleSort}
                    className="w-[15%] pr-4"
                  />
                </tr>
              </thead>
              <tbody>
                {pages.map((item) => {
                  const journal = item.id.startsWith("journals/");
                  return (
                    <tr
                      key={item.id}
                      className="border-b border-line/45 transition last:border-0 hover:bg-white/50"
                    >
                      <td className="py-2 pl-4 pr-3">
                        <button
                          type="button"
                          onClick={() => openPage(item)}
                          className="inline-flex max-w-full items-center gap-2 text-left font-mono text-[11px] text-ink-soft transition hover:text-accent-strong"
                          title={item.id}
                        >
                          {journal ? (
                            <IconCalendar className="h-3 w-3 shrink-0 text-faint" />
                          ) : (
                            <IconFile className="h-3 w-3 shrink-0 text-faint" />
                          )}
                          <span className="truncate">
                            {journal
                              ? formatJournalDate(item.title)
                              : item.title}
                          </span>
                        </button>
                      </td>
                      <td className="py-2 pr-3 font-mono text-[10px] text-muted">
                        {item.backlink_count}
                      </td>
                      <td className="py-2 pr-3">
                        <PageTags
                          tags={item.tags}
                          onTagClick={chooseTag}
                        />
                      </td>
                      <td className="py-2 pr-3 font-mono text-[9.5px] text-muted">
                        {compactTime(item.created_at)}
                      </td>
                      <td className="py-2 pr-4 font-mono text-[9.5px] text-muted">
                        {compactTime(item.updated_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {pages.map((item) => {
              const journal = item.id.startsWith("journals/");
              return (
                <article
                  key={item.id}
                  className="rounded-xl border border-line bg-white/30 p-3 transition hover:border-line-strong hover:bg-white/50"
                >
                  <button
                    type="button"
                    onClick={() => openPage(item)}
                    className="flex w-full items-start gap-2 text-left"
                  >
                    <span className="mt-0.5 text-faint">
                      {journal ? (
                        <IconCalendar className="h-3.5 w-3.5" />
                      ) : (
                        <IconFile className="h-3.5 w-3.5" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-ink">
                      {journal
                        ? formatJournalDate(item.title)
                        : item.title}
                    </span>
                    <span className="shrink-0 font-mono text-[9px] text-faint">
                      {item.backlink_count} backlinks
                    </span>
                  </button>
                  <div className="mt-2 min-h-5">
                    <PageTags tags={item.tags} onTagClick={chooseTag} />
                  </div>
                  <p className="mt-2 border-t border-line/50 pt-1.5 font-mono text-[8.5px] text-faint">
                    Updated {compactTime(item.updated_at)}
                  </p>
                </article>
              );
            })}
          </div>
        )}

        {total > 0 && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-[9px] text-faint">
                {loading
                  ? "Loading…"
                  : `${offset + 1}–${Math.min(offset + pages.length, total)} of ${total}`}
              </span>
              <label className="inline-flex items-center gap-1 font-mono text-[9px] text-faint">
                <select
                  value={pageSize}
                  onChange={(event) => choosePageSize(event.target.value)}
                  className="rounded border border-line bg-white/50 px-1 py-0.5 font-mono text-[9px] text-muted outline-none focus:border-accent/60"
                  aria-label="Rows per page"
                >
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
                / page
              </label>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                disabled={page === 0 || loading}
                className="rounded-md border border-line bg-white/50 p-1 text-muted transition hover:border-line-strong hover:bg-white hover:text-ink disabled:cursor-default disabled:opacity-30"
                aria-label="Previous page"
              >
                <IconArrowLeft className="h-3.5 w-3.5" />
              </button>
              <span className="min-w-20 text-center font-mono text-[9px] text-muted">
                Page {page + 1} / {pageCount}
              </span>
              <button
                type="button"
                onClick={() =>
                  setPage((current) => Math.min(pageCount - 1, current + 1))
                }
                disabled={page >= pageCount - 1 || loading}
                className="rounded-md border border-line bg-white/50 p-1 text-muted transition hover:border-line-strong hover:bg-white hover:text-ink disabled:cursor-default disabled:opacity-30"
                aria-label="Next page"
              >
                <IconArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {orphansOpen && (
        <OrphanDialog
          notebookId={notebookId}
          onClose={() => setOrphansOpen(false)}
          onDeleted={refresh}
        />
      )}
    </main>
  );
}

function SortHeader({
  label,
  column,
  active,
  direction,
  onSort,
  className = "",
}: {
  label: string;
  column: SortKey;
  active: SortKey;
  direction: SortDir;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const selected = active === column;
  return (
    <th
      scope="col"
      aria-sort={
        selected ? (direction === "asc" ? "ascending" : "descending") : "none"
      }
      className={`py-2 pr-3 font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-faint ${className}`}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 transition hover:text-ink-soft"
      >
        {label}
        {selected && <span>{direction === "asc" ? "↑" : "↓"}</span>}
      </button>
    </th>
  );
}

function PageTags({
  tags,
  onTagClick,
}: {
  tags: string[];
  onTagClick: (tag: string) => void;
}) {
  if (tags.length === 0) {
    return <span className="font-mono text-[9.5px] text-faint">—</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          onClick={() => onTagClick(tag)}
          className="rounded bg-panel px-1.5 py-0.5 font-mono text-[8.5px] text-muted transition hover:bg-accent-soft hover:text-accent-strong"
          title={`Filter by #${tag}`}
        >
          #{tag}
        </button>
      ))}
    </div>
  );
}

function sortLabel(key: SortKey): string {
  switch (key) {
    case "title":
      return "page name";
    case "backlinks":
      return "backlinks";
    case "tags":
      return "tags";
    case "created_at":
      return "created";
    case "updated_at":
      return "updated";
  }
}
