import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import type {
  JournalPage,
  JournalPluginResult,
  Note,
  PluginAction,
} from "../api/types";
import { formatJournalDate, todayKey, ensureJournalPage } from "../lib/journal";
import { useAppNavigate } from "../lib/appNavigation";
import { useViewAutoFocus } from "../lib/useViewFocus";
import { useShortcutRunner } from "../lib/useShortcutRunner";
import { noteLinkKeys, normalizeLinkTarget, safeExternalUrl } from "../lib/markdown";
import { JournalCard, type JournalCardHandle } from "./JournalCard";
import { PluginHost } from "./PluginHost";
import { IconPlus } from "./Icons";
import { BUILTIN_CLIENT_PLUGINS } from "../../../builtin/plugins/index.js";
import type { HomePluginContext } from "../plugins/types";
import {
  activeNotebookIdAtom,
  favoritesAtom,
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

export function HomeView() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
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

  const homePlugins = useMemo(() => {
    const builtinIds = new Set(BUILTIN_CLIENT_PLUGINS.map((plugin) => plugin.id));
    return plugins.filter((plugin) => !builtinIds.has(plugin.id));
  }, [plugins]);

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
            <h2 className="font-mono text-[14px] font-semibold uppercase tracking-[0.14em] text-faint">
              Today
            </h2>
            <div className="flex items-center gap-3">
              <span className="font-mono text-[14px] text-faint">
                {formatJournalDate(todayKey())}
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
            <p className="rounded-xl border border-line bg-paper px-4 py-8 text-center font-sans text-[14px] text-faint">
              No journal page for today yet.
            </p>
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
            {BUILTIN_CLIENT_PLUGINS.map((plugin) => (
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
