import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";

import { api } from "../api/client";
import type { TaskList, TaskOverview, TaskStatus } from "../api/types";
import { compactTime, relativeTime } from "../lib/format";
import { formatJournalDate } from "../lib/journal";
import { useAppNavigate } from "../lib/appNavigation";
import { useViewAutoFocus } from "../lib/useViewFocus";
import {
  cleanTaskText,
  isTaskStatus,
  taskStatusLabel,
  TASK_STATUSES,
} from "../lib/tasks";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconFile,
  IconSearch,
  IconSort,
  IconX,
} from "./Icons";
import {
  activeNotebookIdAtom,
  notesRevisionAtom,
  taskStatusFilterAtom,
  tasksPageSizeAtom,
} from "../state/atoms";

type SortKey = "status" | "task" | "page" | "updated_at";
type SortDir = "asc" | "desc";

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200] as const;

const SORT_LABELS: Record<SortKey, string> = {
  status: "status",
  task: "task",
  page: "page",
  updated_at: "updated",
};

export function TasksView() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const revision = useAtomValue(notesRevisionAtom);
  const navigate = useAppNavigate();

  const [storedPageSize, setStoredPageSize] = useAtom(tasksPageSizeAtom);
  const pageSize = (PAGE_SIZE_OPTIONS as readonly number[]).includes(
    storedPageSize,
  )
    ? storedPageSize
    : 20;

  const [statusFilter, setStatusFilter] = useAtom(taskStatusFilterAtom);
  const selectedStatuses = useMemo(
    () => statusFilter.filter(isTaskStatus),
    [statusFilter],
  );

  // Newest first by default: the todo list is a "what changed lately" view.
  const [sortKey, setSortKey] = useState<SortKey>("updated_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<TaskList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const firstRowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!notebookId) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const statuses = selectedStatuses.join(",");
    api
      .listTasks(notebookId, {
        limit: pageSize,
        offset: page * pageSize,
        status: statuses || undefined,
        q: debouncedQuery || undefined,
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
            cause instanceof Error ? cause.message : "Could not load todos",
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
    selectedStatuses,
    sortKey,
    sortDir,
    revision,
  ]);

  const tasks = data?.tasks ?? [];
  const total = data?.total ?? 0;
  const counts = data?.counts;

  useViewAutoFocus("tasks", () => firstRowRef.current?.focus(), tasks.length > 0);

  const offset = data?.offset ?? page * pageSize;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  if (!notebookId) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-transparent p-8">
        <p className="max-w-sm text-center font-mono text-[14px] leading-relaxed text-muted">
          Select or create a notebook to browse its todos.
        </p>
      </main>
    );
  }

  function toggleStatus(status: TaskStatus) {
    setPage(0);
    setStatusFilter((current) =>
      current.includes(status)
        ? current.filter((value) => value !== status)
        : [...current, status],
    );
  }

  function showEverything() {
    setPage(0);
    setStatusFilter(TASK_STATUSES);
  }

  function openTask(task: TaskOverview) {
    navigate({ view: "note", noteId: task.note_path });
  }

  function choosePageSize(value: string) {
    setStoredPageSize(Number(value));
    setPage(0);
  }

  // An empty selection means "everything", same as selecting every status.
  const showAll =
    selectedStatuses.length === 0 || selectedStatuses.length === TASK_STATUSES.length;
  const showEmpty = !loading && !error && total === 0;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-transparent">
      <div className="mx-auto w-full max-w-5xl px-6 py-6">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <IconCheck className="h-4 w-4 text-muted" />
            <h1 className="font-serif text-[18px] font-semibold tracking-tight text-ink">
              Todos
            </h1>
            <span className="rounded-full bg-panel px-1.5 py-0.5 font-mono text-[14px] text-faint">
              {total}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setPage(0);
                setSortDir((direction) =>
                  direction === "asc" ? "desc" : "asc",
                );
              }}
              className="inline-flex items-center gap-1 rounded-md border border-transparent px-1.5 py-1 font-mono text-[14px] text-muted transition hover:border-line hover:bg-white/60 hover:text-ink"
              title={`Sort by ${SORT_LABELS[sortKey]} ${sortDir === "asc" ? "ascending" : "descending"}`}
              aria-label="Toggle sort direction"
            >
              <IconSort className="h-3.5 w-3.5" />
              <span>{sortDir === "asc" ? "↑" : "↓"}</span>
            </button>

            <label
              className="relative inline-flex items-center rounded-md border border-transparent text-muted transition hover:border-line hover:bg-white/60 hover:text-ink focus-within:border-line focus-within:bg-white/60"
              title="Sort todos"
            >
              <select
                value={sortKey}
                onChange={(event) => {
                  const next = event.target.value as SortKey;
                  setPage(0);
                  setSortKey(next);
                  setSortDir(next === "updated_at" ? "desc" : "asc");
                }}
                className="appearance-none bg-transparent py-1 pl-2 pr-2 font-mono text-[14px] outline-none"
                aria-label="Sort todos"
              >
                {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                  <option key={key} value={key}>
                    {SORT_LABELS[key]}
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
                  placeholder="Filter todos…"
                  className="w-40 rounded-md border border-line bg-white/70 py-1 pl-7 pr-6 font-mono text-[14px] text-ink outline-none focus:border-accent/60"
                  aria-label="Filter todos"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setPage(0);
                    }}
                    className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-faint hover:text-ink"
                    aria-label="Clear todo filter"
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
                aria-label="Filter todos"
                title="Filter todos"
              >
                <IconSearch className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-1.5 pt-3">
          <button
            type="button"
            onClick={showEverything}
            aria-pressed={showAll}
            className={`rounded-full border px-2 py-0.5 font-mono text-[14px] transition ${
              showAll
                ? "border-accent/40 bg-accent-soft text-accent-strong"
                : "border-line bg-white/50 text-muted hover:bg-white hover:text-ink"
            }`}
            title="Show every status"
          >
            All
            <span className="ml-1 text-faint">
              {counts
                ? counts.open + counts.doing + counts.done + counts.cancelled
                : 0}
            </span>
          </button>
          {TASK_STATUSES.map((status) => {
            const active = selectedStatuses.includes(status);
            return (
              <button
                key={status}
                type="button"
                onClick={() => toggleStatus(status)}
                aria-pressed={active}
                className={`rounded-full border px-2 py-0.5 font-mono text-[14px] transition ${
                  active
                    ? "border-accent/40 bg-accent-soft text-accent-strong"
                    : "border-line bg-white/50 text-muted hover:bg-white hover:text-ink"
                }`}
                title={`Toggle ${taskStatusLabel(status).toLowerCase()} todos`}
              >
                {taskStatusLabel(status)}
                <span className="ml-1 text-faint">
                  {counts ? counts[status] : 0}
                </span>
              </button>
            );
          })}
        </div>

        {error ? (
          <p className="mt-4 rounded-lg bg-danger/10 px-3 py-2 font-mono text-[14px] text-danger">
            {error}
          </p>
        ) : loading && !data ? (
          <p className="mt-16 text-center font-mono text-[14px] text-faint">
            Loading todos…
          </p>
        ) : showEmpty ? (
          <div className="mt-16 text-center">
            <p className="font-mono text-[14px] text-muted">
              {debouncedQuery || !showAll
                ? "No todos match this filter."
                : "No todos yet. Write `- [ ] task` in any page."}
            </p>
          </div>
        ) : (
          <div className="mt-3 overflow-hidden rounded-xl border border-line bg-paper">
            {tasks.map((task, index) => (
              <button
                key={task.id}
                ref={index === 0 ? firstRowRef : undefined}
                type="button"
                onClick={() => openTask(task)}
                title={`${task.note_path}:${task.line}`}
                className="flex w-full items-center gap-2.5 border-b border-line/45 px-3 py-2 text-left transition last:border-0 hover:bg-white/60"
              >
                <StatusGlyph status={task.status} />
                <span
                  className={`min-w-0 flex-1 truncate font-mono text-[14px] ${
                    task.status === "done" || task.status === "cancelled"
                      ? "text-faint line-through"
                      : "text-ink"
                  }`}
                >
                  {cleanTaskText(task.text) || task.text}
                </span>
                <span className="hidden shrink-0 items-center gap-1 font-mono text-[14px] text-muted sm:inline-flex">
                  <IconFile className="h-3 w-3 text-faint" />
                  <span className="max-w-48 truncate">
                    {task.note_path.startsWith("journals/")
                      ? formatJournalDate(task.note_title)
                      : task.note_title}
                  </span>
                </span>
                <span
                  className="w-32 shrink-0 text-right font-mono text-[14px] text-faint"
                  title={compactTime(task.updated_at)}
                >
                  {relativeTime(task.updated_at)}
                </span>
              </button>
            ))}
          </div>
        )}

        {total > 0 && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-[14px] text-faint">
                {loading
                  ? "Loading…"
                  : `${offset + 1}–${Math.min(offset + tasks.length, total)} of ${total}`}
              </span>
              <label className="inline-flex items-center gap-1 font-mono text-[14px] text-faint">
                <select
                  value={pageSize}
                  onChange={(event) => choosePageSize(event.target.value)}
                  className="rounded border border-line bg-white/50 px-1 py-0.5 font-mono text-[14px] text-muted outline-none focus:border-accent/60"
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
              <span className="min-w-20 text-center font-mono text-[14px] text-muted">
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
    </main>
  );
}

/** Checkbox-like status marker; done and cancelled read as finished. */
function StatusGlyph({ status }: { status: TaskStatus }) {
  const base =
    "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border text-[10px]";
  switch (status) {
    case "done":
      return (
        <span className={`${base} border-success/50 bg-success/15 text-success`}>
          <IconCheck className="h-2.5 w-2.5" />
        </span>
      );
    case "cancelled":
      return (
        <span className={`${base} border-line-strong bg-panel text-faint`}>
          <IconX className="h-2.5 w-2.5" />
        </span>
      );
    case "doing":
      return (
        <span className={`${base} border-accent/60 bg-accent-soft text-accent`}>
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        </span>
      );
    case "open":
    default:
      return <span className={`${base} border-line-strong bg-white/60`} />;
  }
}
