import type { ReactNode } from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { fullTime, wordCount } from "../lib/format";
import { IconFile, IconLink, IconTag } from "./Icons";
import {
  activeNoteAtom,
  activeNoteIdAtom,
  activeNotebookAtom,
  activeNotebookIdAtom,
  statsAtom,
  tagsAtom,
} from "../state/atoms";

export function Inspector() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const notebook = useAtomValue(activeNotebookAtom);
  const note = useAtomValue(activeNoteAtom);
  const tags = useAtomValue(tagsAtom);
  const stats = useAtomValue(statsAtom);
  const setActiveNote = useSetAtom(activeNoteIdAtom);

  if (!notebookId) return null;

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-l border-line bg-panel/30 xl:flex">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {note ? (
          <div className="animate-fade-up space-y-5">
            <section>
              <SectionLabel icon={<IconTag className="h-3 w-3" />}>
                Tags
              </SectionLabel>
              {note.tags.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {note.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-md border border-line bg-white/60 px-1.5 py-0.5 font-mono text-[10px] text-ink-soft"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              ) : (
                <Hint>Add commas to the tag field, or write #tags inline.</Hint>
              )}
            </section>

            <section>
              <SectionLabel icon={<IconLink className="h-3 w-3" />}>
                Outgoing links
              </SectionLabel>
              {note.links.length > 0 ? (
                <ul className="mt-1 space-y-0.5">
                  {note.links.map((link) => (
                    <li key={link.target}>
                      {link.note_id ? (
                        <button
                          type="button"
                          onClick={() => setActiveNote(link.note_id ?? null)}
                          className="w-full truncate rounded px-1.5 py-1 text-left text-[11.5px] text-ink-soft transition hover:bg-white/70"
                          title={`Open ${link.title ?? link.label}`}
                        >
                          {link.label}
                        </button>
                      ) : (
                        <span
                          className="flex items-center gap-1 px-1.5 py-1 text-[11.5px] text-faint"
                          title="No note with this title in the notebook"
                        >
                          <span className="truncate">{link.label}</span>
                          <span className="ml-auto shrink-0 rounded bg-panel px-1 font-mono text-[8.5px] uppercase tracking-wide">
                            new
                          </span>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <Hint>Type [[Another note]] in the body to link.</Hint>
              )}
            </section>

            <section>
              <SectionLabel icon={<IconFile className="h-3 w-3" />}>
                Backlinks
                <span className="ml-1 font-mono text-[9px] font-normal tracking-normal text-line-strong">
                  {note.backlinks.length}
                </span>
              </SectionLabel>
              {note.backlinks.length > 0 ? (
                <ul className="mt-1 space-y-0.5">
                  {note.backlinks.map((backlink) => (
                    <li key={backlink.id}>
                      <button
                        type="button"
                        onClick={() => setActiveNote(backlink.id)}
                        className="w-full truncate rounded px-1.5 py-1 text-left text-[11.5px] text-ink-soft transition hover:bg-white/70"
                      >
                        {backlink.title}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <Hint>Nothing links here yet.</Hint>
              )}
            </section>

            <section className="border-t border-line pt-3">
              <dl className="space-y-1 text-[10px] text-faint">
                <div className="flex justify-between gap-2">
                  <dt>Words</dt>
                  <dd className="font-mono text-muted">
                    {wordCount(note.content)}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Created</dt>
                  <dd className="text-right text-muted">
                    {fullTime(note.created_at)}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Updated</dt>
                  <dd className="text-right text-muted">
                    {fullTime(note.updated_at)}
                  </dd>
                </div>
              </dl>
            </section>
          </div>
        ) : (
          <div className="space-y-5">
            <section>
              <SectionLabel icon={<IconTag className="h-3 w-3" />}>
                Notebook tags
              </SectionLabel>
              {tags.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {tags.map((tag) => (
                    <span
                      key={tag.tag}
                      className="flex items-center gap-1 rounded-md border border-line bg-white/60 px-1.5 py-0.5 font-mono text-[10px] text-ink-soft"
                    >
                      #{tag.tag}
                      <span className="text-[8.5px] text-faint">{tag.count}</span>
                    </span>
                  ))}
                </div>
              ) : (
                <Hint>No tags in this notebook yet.</Hint>
              )}
            </section>
            <section>
              <SectionLabel icon={<IconFile className="h-3 w-3" />}>
                Notebook
              </SectionLabel>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
                {notebook?.description || "No description."}
              </p>
              <p className="mt-2 break-all font-mono text-[9.5px] text-faint">
                {notebookId}
              </p>
            </section>
          </div>
        )}
      </div>

      <div className="border-t border-line px-4 py-2.5 font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
        {stats.notes} {stats.notes === 1 ? "note" : "notes"} · {stats.links}{" "}
        {stats.links === 1 ? "link" : "links"} · {stats.tags}{" "}
        {stats.tags === 1 ? "tag" : "tags"}
      </div>
    </aside>
  );
}

function SectionLabel({
  children,
  icon,
}: {
  children: ReactNode;
  icon: ReactNode;
}) {
  return (
    <h3 className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-faint">
      {icon}
      {children}
    </h3>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1.5 text-[10.5px] leading-relaxed text-faint">{children}</p>
  );
}
