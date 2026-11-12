import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";

import { api } from "../api/client";
import type { JournalPluginItem, JournalPluginResult } from "../api/types";
import { formatJournalDate } from "../lib/journal";
import { useAppNavigate } from "../lib/appNavigation";
import { IconCheck, IconRefresh } from "./Icons";
import {
  activeNotebookIdAtom,
  journalPluginsRevisionAtom,
  notesRevisionAtom,
} from "../state/atoms";

export function JournalPluginsPanel() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const revision = useAtomValue(notesRevisionAtom);
  const pluginRevision = useAtomValue(journalPluginsRevisionAtom);
  const navigate = useAppNavigate();
  const [results, setResults] = useState<JournalPluginResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!notebookId) return;
    let cancelled = false;
    setLoading(true);
    api
      .journalPlugins(notebookId)
      .then((plugins) => {
        if (cancelled) return;
        setResults(plugins);
        setError(null);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load journal plugins",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [notebookId, pluginRevision, reload, revision]);

  if (!notebookId) return null;

  return (
    <aside className="hidden w-72 shrink-0 flex-col border-l border-line bg-panel/20 lg:flex">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <div className="font-mono text-[14px] font-semibold uppercase tracking-[0.14em] text-faint">
            Journal tools
          </div>
          <p className="mt-1 font-mono text-[14px] leading-relaxed text-faint">
            Server-side plugins running Datalog.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReload((value) => value + 1)}
          disabled={loading}
          className="rounded-md p-1 text-faint transition hover:bg-white/60 hover:text-ink disabled:opacity-40"
          aria-label="Refresh journal plugins"
          title="Refresh journal plugins"
        >
          <IconRefresh className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {error && (
          <p className="rounded-lg bg-danger/10 px-3 py-2 font-mono text-[14px] leading-relaxed text-danger">
            {error}
          </p>
        )}

        {!results && loading && (
          <p className="px-2 py-8 text-center font-mono text-[14px] text-faint">
            Running plugins…
          </p>
        )}

        {results?.map((plugin) => (
          <PluginCard
            key={plugin.id}
            plugin={plugin}
            onOpen={(item) =>
              navigate({ view: "note", noteId: item.note_path })
            }
          />
        ))}
      </div>
    </aside>
  );
}

function PluginCard({
  plugin,
  onOpen,
}: {
  plugin: JournalPluginResult;
  onOpen: (item: JournalPluginItem) => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white/35">
      <header className="flex items-start gap-2 border-b border-line/60 px-3 py-2.5">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-mark/60 text-ink-soft">
          <IconCheck className="h-3 w-3" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="font-sans text-[14px] font-semibold text-ink">
              {plugin.title}
            </h3>
            <span className="rounded-full bg-panel px-1.5 py-0.5 font-mono text-[14px] text-faint">
              {plugin.items.length}
            </span>
          </div>
          <p className="mt-0.5 font-mono text-[14px] leading-relaxed text-faint">
            {plugin.description}
          </p>
        </div>
      </header>

      <div className="p-1.5">
        {plugin.error ? (
          <p className="mx-1 rounded bg-danger/10 px-2 py-1.5 font-mono text-[14px] leading-relaxed text-danger">
            {plugin.error}
          </p>
        ) : plugin.items.length === 0 ? (
          <p className="px-2 py-4 text-center font-mono text-[14px] text-faint">
            All clear.
          </p>
        ) : (
          plugin.items.map((item) => {
            const journal = item.note_path.startsWith("journals/");
            const noteTitle = journal
              ? formatJournalDate(item.detail)
              : item.detail;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpen(item)}
                className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-panel/70"
                title={`Open ${noteTitle}`}
              >
                <span
                  className={`mt-0.5 h-3 w-3 shrink-0 rounded border ${
                    item.status === "doing"
                      ? "border-accent bg-accent-soft"
                      : "border-line-strong bg-white/60"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 font-mono text-[14px] leading-snug text-ink-soft">
                    {item.title}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[14px] text-faint">
                    {noteTitle}
                    {item.status === "doing" ? " · doing" : ""}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}
