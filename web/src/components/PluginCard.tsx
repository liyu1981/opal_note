import type { JournalPluginItem, JournalPluginResult } from "../api/types";
import { formatJournalDate } from "../lib/journal";
import { IconCheck } from "./Icons";

export function PluginCard({
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
