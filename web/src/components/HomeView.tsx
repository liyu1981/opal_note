import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";

import { ApiError, api } from "../api/client";
import type {
  JournalPage,
  JournalPluginResult,
  Note,
  PluginAction,
} from "../api/types";
import {
  dayKeyOffset,
  ensureJournalPage,
  formatJournalDate,
  todayKey,
} from "../lib/journal";
import { useAppNavigate } from "../lib/appNavigation";
import { useViewAutoFocus } from "../lib/useViewFocus";
import { useShortcutRunner } from "../lib/useShortcutRunner";
import { noteLinkKeys, normalizeLinkTarget, safeExternalUrl } from "../lib/markdown";
import { settingsAtom } from "../lib/settings";
import { JournalCard, type JournalCardHandle } from "./JournalCard";
import { PluginHost } from "./PluginHost";
import { IconChevron, IconPlus } from "./Icons";
import { BUILTIN_CLIENT_PLUGINS } from "../../../builtin/plugins/index.js";
import type { HomePluginContext } from "../plugins/types";
import type { AppSettings } from "../lib/settings";
import {
  activeNotebookIdAtom,
  favoritesAtom,
  homeDayOffsetAtom,
  journalPluginsRevisionAtom,
  tasksRevisionAtom,
  notesAtom,
  notesRevisionAtom,
  readOnlyAtom,
  recentsAtom,
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

/** Days back from today the home journal card can be stepped through. */
const DAY_WINDOW = 5;

function dayLabel(offset: number): string {
  if (offset === 0) return "Today";
  if (offset === 1) return "Yesterday";
  return `${offset} days ago`;
}

/** Which home sections the settings keep switched on, by plugin id. */
function sectionSwitch(settings: AppSettings): Record<string, boolean> {
  return {
    "OpalNote/todos": settings.homeShowTodos,
    "OpalNote/favorites": settings.homeShowFavorites,
    "OpalNote/recent": settings.homeShowRecent,
  };
}

export function HomeView() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const settings = useAtomValue(settingsAtom);
  const notes = useAtomValue(notesAtom);
  const favorites = useAtomValue(favoritesAtom);
  const recents = useAtomValue(recentsAtom);
  const notesRevision = useAtomValue(notesRevisionAtom);
  const pluginRevision = useAtomValue(journalPluginsRevisionAtom);
  const tasksRevision = useAtomValue(tasksRevisionAtom);
  const locked = useAtomValue(readOnlyAtom);
  const refresh = useSetAtom(refreshAtom);
  const refreshNotes = useSetAtom(refreshNotesAtom);
  const navigate = useAppNavigate();
  const runCommand = useShortcutRunner();
  const todayCardRef = useRef<JournalCardHandle>(null);

  const [dayOffset, setDayOffset] = useAtom(homeDayOffsetAtom);
  const [today, setToday] = useState<JournalPage | null>(null);
  const [loadingToday, setLoadingToday] = useState(true);
  const [todayError, setTodayError] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<JournalPluginResult[]>([]);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useViewAutoFocus(
    "home",
    () => todayCardRef.current?.focus(),
    Boolean(today),
  );

  // Stepping to another day hands the cursor to that card, so typing continues
  // where the switcher went. Keyed on the loaded page (not the offset) because
  // the day only becomes focusable once its note has arrived.
  const dayOffsetRef = useRef(dayOffset);
  dayOffsetRef.current = dayOffset;
  const focusedDayRef = useRef(dayOffset);
  useEffect(() => {
    if (!today || focusedDayRef.current === dayOffsetRef.current) return;
    focusedDayRef.current = dayOffsetRef.current;
    const timer = window.setTimeout(
      () => todayCardRef.current?.focus(),
      80,
    );
    return () => window.clearTimeout(timer);
  }, [today]);

  const favoriteRefs = notebookId ? (favorites[notebookId] ?? []) : [];
  const recentRefs = notebookId ? (recents[notebookId] ?? []) : [];
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
    const key = dayKeyOffset(dayOffset);
    const path = `journals/${key}.md`;

    void (async () => {
      try {
        // Only today is created on open; older days load (and can be created on
        // request) so merely stepping back never writes files.
        if (!locked && dayOffset === 0) {
          const { note, created } = await ensureJournalPage(notebookId, key);
          if (cancelled) return;
          setToday(toJournalPage(note));
          if (created) refreshNotes();
          return;
        }
        try {
          const note = await api.getNote(notebookId, path);
          if (!cancelled) setToday(toJournalPage(note));
        } catch (cause) {
          if (cancelled) return;
          // A missing journal file is an empty day, not an error.
          setToday(null);
          if (cause instanceof ApiError && cause.status === 404) return;
          setTodayError(
            cause instanceof Error
              ? cause.message
              : "Could not open that journal day",
          );
        }
      } catch (cause) {
        if (!cancelled) {
          setTodayError(
            cause instanceof Error
              ? cause.message
              : "Could not open that journal day",
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
  }, [dayOffset, locked, notebookId, refreshNotes]);

  useEffect(() => {
    if (!notebookId) {
      setPlugins([]);
      return;
    }
    let cancelled = false;
    api
      .journalPlugins(notebookId)
      .then((results) => {
        if (cancelled) return;
        setPlugins(results);
        setPluginsError(null);
      })
      .catch((cause) => {
        if (cancelled) return;
        setPlugins([]);
        setPluginsError(
          cause instanceof Error ? cause.message : "Could not load plugins",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [notebookId, notesRevision, pluginRevision, tasksRevision]);

  function handlePluginAction(action: PluginAction) {
    switch (action.type) {
      case "openNote":
        navigate({ view: "note", noteId: action.path });
        break;
      case "openTag":
        navigate({ view: "tag", tag: action.tag });
        break;
      case "openExternal": {
        const safe = safeExternalUrl(action.url);
        if (safe) window.open(safe, "_blank", "noopener,noreferrer");
        break;
      }
      case "runCommand":
        runCommand(action.id);
        break;
    }
  }

  const recent = useMemo(() => {
    const todayPath = `journals/${todayKey()}.md`;
    return [...notes]
      .filter((note) => note.id !== todayPath)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, 3);
  }, [notes]);

  const switches = useMemo(() => sectionSwitch(settings), [settings]);
  const homePlugins = useMemo(() => {
    const builtinIds = new Set(BUILTIN_CLIENT_PLUGINS.map((plugin) => plugin.id));
    return plugins.filter(
      (plugin) =>
        !builtinIds.has(plugin.id) && (switches[plugin.id] ?? true),
    );
  }, [plugins, switches]);
  const homeBuiltins = useMemo(
    () =>
      BUILTIN_CLIENT_PLUGINS.filter((plugin) => switches[plugin.id] ?? true),
    [switches],
  );

  function openWiki(target: string) {
    const needle = normalizeLinkTarget(target);
    const hit = notes.find((note) =>
      noteLinkKeys(note.title, note.id).includes(needle),
    );
    if (hit) navigate({ view: "note", noteId: hit.id });
  }

  /** Create the journal page for the day the switcher shows. */
  async function createJournalEntry() {
    if (!notebookId || locked) return;
    const key = dayKeyOffset(dayOffset);
    try {
      const { note } = await ensureJournalPage(notebookId, key);
      setToday(toJournalPage(note));
      refreshNotes();
      window.setTimeout(() => todayCardRef.current?.focus(), 60);
    } catch (cause) {
      window.alert(
        cause instanceof Error
          ? cause.message
          : "Could not create the journal entry",
      );
    }
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
      <main className="flex min-h-0 flex-1 items-center justify-center bg-transparent p-8">
        <p className="max-w-sm text-center font-mono text-[14px] leading-relaxed text-muted">
          Create or select a notebook to open its home.
        </p>
      </main>
    );
  }

  const pluginContext: HomePluginContext = {
    notebookId,
    notes,
    favorites: favoriteRefs,
    recents: recentRefs,
    recentNotes: recent,
    linkKeys,
    linkTargets,
    onAction: handlePluginAction,
    onWikiLink: openWiki,
    onTag: (tag) => navigate({ view: "tag", tag }),
  };

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-transparent">
      <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-6">
        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setDayOffset((offset) => Math.min(DAY_WINDOW, offset + 1))}
                disabled={dayOffset >= DAY_WINDOW}
                aria-label="Previous day"
                title="Previous day"
                className="rounded p-1 text-faint transition hover:bg-panel hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
              >
                <IconChevron className="h-3.5 w-3.5 rotate-90" />
              </button>
              <h2 className="w-28 text-center font-mono text-[14px] font-semibold uppercase tracking-[0.14em] text-faint">
                {dayLabel(dayOffset)}
              </h2>
              <button
                type="button"
                onClick={() => setDayOffset((offset) => Math.max(0, offset - 1))}
                disabled={dayOffset === 0}
                aria-label="Next day"
                title="Next day"
                className="rounded p-1 text-faint transition hover:bg-panel hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
              >
                <IconChevron className="h-3.5 w-3.5 -rotate-90" />
              </button>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-[14px] text-faint">
                {formatJournalDate(dayKeyOffset(dayOffset))}
              </span>
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
          </div>

          {loadingToday ? (
            <div className="h-40 animate-pulse rounded-xl border border-line bg-panel/30" />
          ) : todayError ? (
            <p className="rounded-lg bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
              {todayError}
            </p>
          ) : today ? (
            <JournalCard
              key={`${notebookId}:${today.id}`}
              ref={todayCardRef}
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
            />
          ) : (
            <div className="rounded-xl border border-line bg-paper px-4 py-8 text-center">
              <p className="font-sans text-[14px] text-faint">
                No journal entry for {formatJournalDate(dayKeyOffset(dayOffset))}.
              </p>
              {!locked && (
                <button
                  type="button"
                  onClick={() => void createJournalEntry()}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-line bg-white/60 px-2.5 py-1.5 font-sans text-[14px] text-muted transition hover:border-line-strong hover:bg-white hover:text-ink"
                >
                  <IconPlus className="h-3.5 w-3.5" />
                  {dayOffset === 0 ? "Write today's entry" : "Write that entry"}
                </button>
              )}
            </div>
          )}
        </section>

        <section>
          {pluginsError && (
            <p className="mb-3 rounded-lg bg-danger/10 px-3 py-2 font-sans text-[14px] text-danger">
              {pluginsError}
            </p>
          )}

          <div className="space-y-3">
            {homePlugins.map((plugin) => (
              <PluginHost
                key={plugin.id}
                plugin={plugin}
                onAction={handlePluginAction}
                notebookId={notebookId}
                linkKeys={linkKeys}
                linkTargets={linkTargets}
                onWikiLink={openWiki}
                onTag={(tag) => navigate({ view: "tag", tag })}
              />
            ))}
            {homeBuiltins.map((plugin) => (
              <Fragment key={plugin.id}>
                {plugin.render(pluginContext)}
              </Fragment>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
