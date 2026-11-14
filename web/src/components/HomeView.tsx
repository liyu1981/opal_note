import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import type { JournalPage, JournalPluginResult, Note } from "../api/types";
import { relativeTime } from "../lib/format";
import { formatJournalDate, todayKey, ensureJournalPage } from "../lib/journal";
import { useAppNavigate } from "../lib/appNavigation";
import { noteLinkKeys, normalizeLinkTarget } from "../lib/markdown";
import { JournalCard } from "./JournalCard";
import { PluginCard } from "./JournalPluginsPanel";
import { IconCalendar, IconFile, IconPlus } from "./Icons";
import {
  activeNotebookIdAtom,
  journalPluginsRevisionAtom,
  notesAtom,
  notesRevisionAtom,
  readOnlyAtom,
  refreshAtom,
  refreshNotesAtom,
} from "../state/atoms";

function toJournalPage(note: Note): JournalPage {
  return {
    id: note.id,
    notebook_id: note.notebook_id,
    title: note.title,
    content: note.content,
    created_at: note.created_at,
    updated_at: note.updated_at,
    tags: note.tags,
  };
}

function noteTitle(note: { id: string; title: string }): string {
  return note.id.startsWith("journals/")
    ? formatJournalDate(note.title)
    : note.title;
}

export function HomeView() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const notes = useAtomValue(notesAtom);
  const notesRevision = useAtomValue(notesRevisionAtom);
  const pluginRevision = useAtomValue(journalPluginsRevisionAtom);
  const locked = useAtomValue(readOnlyAtom);
  const refresh = useSetAtom(refreshAtom);
  const refreshNotes = useSetAtom(refreshNotesAtom);
  const navigate = useAppNavigate();

  const [today, setToday] = useState<JournalPage | null>(null);
  const [loadingToday, setLoadingToday] = useState(true);
  const [todayError, setTodayError] = useState<string | null>(null);
  const [todos, setTodos] = useState<JournalPluginResult | null>(null);
  const [todosError, setTodosError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const linkTargets = useMemo(
    () => notes.map((note) => ({ title: note.title, path: note.id })),
    [notes],
  );
  const linkKeys = useMemo(
    () => new Set(notes.flatMap((note) => noteLinkKeys(note.title, note.id))),
    [notes],
  );

  useEffect(() => {
    if (!notebookId) {
      setToday(null);
      setLoadingToday(false);
      return;
    }

    let cancelled = false;
    setLoadingToday(true);
    setTodayError(null);
    const path = `journals/${todayKey()}`;

    void (async () => {
      try {
        if (locked) {
          try {
            const note = await api.getNote(notebookId, path);
            if (!cancelled) setToday(toJournalPage(note));
          } catch {
            if (!cancelled) setToday(null);
          }
          return;
        }

        const { note, created } = await ensureJournalPage(notebookId);
        if (cancelled) return;
        setToday(toJournalPage(note));
        if (created) refreshNotes();
      } catch (cause) {
        if (!cancelled) {
          setTodayError(
            cause instanceof Error
              ? cause.message
              : "Could not open today's journal",
          );
          setToday(null);
        }
      } finally {
        if (!cancelled) setLoadingToday(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [locked, notebookId, refreshNotes]);

  useEffect(() => {
    if (!notebookId) {
      setTodos(null);
      return;
    }
    let cancelled = false;
    api
      .journalPlugins(notebookId)
      .then((plugins) => {
        if (cancelled) return;
        setTodos(plugins.find((plugin) => plugin.id === "todos") ?? null);
        setTodosError(null);
      })
      .catch((cause) => {
        if (cancelled) return;
        setTodos(null);
        setTodosError(
          cause instanceof Error ? cause.message : "Could not load todos",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [notebookId, notesRevision, pluginRevision]);

  const recent = useMemo(() => {
    const todayPath = `journals/${todayKey()}.md`;
    return [...notes]
      .filter((note) => note.id !== todayPath)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, 3);
  }, [notes]);

  function openWiki(target: string) {
    const needle = normalizeLinkTarget(target);
    const hit = notes.find((note) =>
      noteLinkKeys(note.title, note.id).includes(needle),
    );
    if (hit) navigate({ view: "note", noteId: hit.id });
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

  if (!notebookId) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-canvas p-8">
        <p className="max-w-sm text-center font-mono text-[14px] leading-relaxed text-muted">
          Create or select a notebook to open its home.
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-canvas">
      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-mono text-[14px] font-semibold uppercase tracking-[0.14em] text-faint">
                Today
              </h2>
              <span className="font-mono text-[14px] text-faint">
                {formatJournalDate(todayKey())}
              </span>
            </div>

            {loadingToday ? (
              <div className="h-40 animate-pulse rounded-xl border border-line bg-panel/30" />
            ) : todayError ? (
              <p className="rounded-lg bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
                {todayError}
              </p>
            ) : today ? (
              <JournalCard
                page={today}
                notebookId={notebookId}
                linkKeys={linkKeys}
                linkTargets={linkTargets}
                readOnly={locked}
                onOpenPage={(page) =>
                  navigate({ view: "note", noteId: page.id })
                }
                onWikiLink={openWiki}
                onTag={(tag) => navigate({ view: "tag", tag })}
                onSaved={refreshNotes}
              />
            ) : (
              <p className="rounded-xl border border-line bg-white/30 px-4 py-8 text-center font-sans text-[14px] text-faint">
                No journal page for today yet.
              </p>
            )}
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-mono text-[14px] font-semibold uppercase tracking-[0.14em] text-faint">
                Recent pages
              </h2>
              <button
                type="button"
                onClick={() => void createPage()}
                disabled={locked || creating}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-white/60 px-2.5 py-1.5 font-sans text-[14px] text-muted transition hover:border-line-strong hover:bg-white hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                <IconPlus className="h-3.5 w-3.5" />
                New page
              </button>
            </div>

            {recent.length === 0 ? (
              <p className="rounded-xl border border-line bg-white/30 px-4 py-8 text-center font-sans text-[14px] text-faint">
                No recent pages yet.
              </p>
            ) : (
              <div className="overflow-hidden rounded-xl border border-line bg-paper">
                {recent.map((note) => (
                  <button
                    key={note.id}
                    type="button"
                    onClick={() =>
                      navigate({ view: "note", noteId: note.id })
                    }
                    className="flex w-full items-center gap-3 border-b border-line/60 px-4 py-3 text-left transition last:border-b-0 hover:bg-white/60"
                  >
                    <span className="shrink-0 text-faint">
                      {note.id.startsWith("journals/") ? (
                        <IconCalendar className="h-4 w-4" />
                      ) : (
                        <IconFile className="h-4 w-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-sans text-[14px] font-medium text-ink">
                        {noteTitle(note)}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[14px] text-faint">
                        {note.id}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[14px] text-faint">
                      {relativeTime(note.updated_at)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="sticky top-6 hidden max-h-[calc(100vh-5rem)] self-start overflow-y-auto lg:block">
          <div className="mb-2 flex items-center justify-between px-1">
            <h2 className="font-mono text-[14px] font-semibold uppercase tracking-[0.14em] text-faint">
              Outstanding todos
            </h2>
            {todos && (
              <span className="font-mono text-[14px] text-faint">
                {todos.items.length}
              </span>
            )}
          </div>
          {todosError ? (
            <p className="rounded-lg bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
              {todosError}
            </p>
          ) : todos ? (
            <PluginCard
              plugin={todos}
              onOpen={(item) =>
                navigate({ view: "note", noteId: item.note_path })
              }
            />
          ) : (
            <p className="rounded-xl border border-line bg-white/30 px-4 py-8 text-center font-sans text-[14px] text-faint">
              No todo plugin loaded.
            </p>
          )}
        </aside>
      </div>
    </main>
  );
}
