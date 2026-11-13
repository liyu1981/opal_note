import { useState, type ReactNode } from "react";
import { useAtomValue } from "jotai";

import type { Note, TagCount } from "../api/types";
import { fullTime, wordCount } from "../lib/format";
import { useAppNavigate } from "../lib/appNavigation";
import { IconFile, IconLink, IconTag } from "./Icons";
import { GraphPanel } from "./GraphPanel";
import {
  activeNoteAtom,
  activeNotebookAtom,
  activeNotebookIdAtom,
  statsAtom,
  tagsAtom,
} from "../state/atoms";

type Tab = "context" | "info" | "graph";

export function RightPanel() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const notebook = useAtomValue(activeNotebookAtom);
  const note = useAtomValue(activeNoteAtom);
  const tags = useAtomValue(tagsAtom);
  const stats = useAtomValue(statsAtom);
  const navigate = useAppNavigate();
  const [tab, setTab] = useState<Tab>("context");

  if (!notebookId) return null;

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    {
      id: "context",
      label: "Context",
      count: note ? note.backlinks.length : undefined,
    },
    { id: "info", label: "Info" },
    { id: "graph", label: "Graph" },
  ];

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-line bg-panel/25">
      <div className="flex shrink-0 border-b border-line px-2 pt-2">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`relative flex items-center gap-1 px-2.5 pb-2 pt-1 font-sans text-[14px] font-semibold uppercase tracking-[0.12em] transition ${
              tab === item.id
                ? "text-ink"
                : "text-faint hover:text-ink-soft"
            }`}
          >
            {item.label}
            {item.count !== undefined && item.count > 0 && (
              <span className="rounded bg-panel px-1 font-sans text-[14px] font-normal text-faint">
                {item.count}
              </span>
            )}
            {tab === item.id && (
              <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" />
            )}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {tab === "context" && (
          <ContextTab
            note={note}
            notebookDescription={notebook?.description ?? ""}
            tags={tags}
            onOpenNote={(path) => navigate({ view: "note", noteId: path })}
            onOpenTag={(tag) => navigate({ view: "tag", tag })}
          />
        )}

        {tab === "info" && (
          <div className="space-y-5">
            <section>
              <SectionLabel icon={<IconFile className="h-3 w-3" />}>
                Notebook
              </SectionLabel>
              <p className="mt-1 font-sans text-[14px] text-ink-soft">
                {notebook?.name ?? notebookId}
              </p>
              <p className="mt-1 font-sans text-[14px] leading-relaxed text-muted">
                {notebook?.description || "No description."}
              </p>
            </section>
            {note ? (
              <>
                <section>
                  <SectionLabel icon={<IconFile className="h-3 w-3" />}>
                    Page
                  </SectionLabel>
                  <p className="mt-1 break-all font-sans text-[14px] text-muted">
                    {note.id}
                  </p>
                </section>
                <section className="border-t border-line pt-3">
                  <dl className="space-y-1 font-sans text-[14px] text-faint">
                    <InfoRow label="Words" value={String(wordCount(note.content))} />
                    <InfoRow label="Tags" value={String(note.tags.length)} />
                    <InfoRow label="Links" value={String(note.links.length)} />
                    <InfoRow label="Backlinks" value={String(note.backlinks.length)} />
                    <InfoRow label="Created" value={fullTime(note.created_at)} />
                    <InfoRow label="Updated" value={fullTime(note.updated_at)} />
                  </dl>
                </section>
              </>
            ) : (
              <p className="font-sans text-[14px] leading-relaxed text-faint">
                Open a page to see its metadata.
              </p>
            )}
          </div>
        )}

        {tab === "graph" && (
          <GraphPanel
            notebookId={notebookId}
            activeNoteId={note?.id ?? null}
          />
        )}
      </div>

      <div className="border-t border-line px-4 py-2.5 font-sans text-[14px] uppercase tracking-[0.12em] text-faint">
        {stats.notes} {stats.notes === 1 ? "note" : "notes"} · {stats.links}{" "}
        {stats.links === 1 ? "link" : "links"} · {stats.tags}{" "}
        {stats.tags === 1 ? "tag" : "tags"}
      </div>
    </aside>
  );
}

function ContextTab({
  note,
  notebookDescription,
  tags,
  onOpenNote,
  onOpenTag,
}: {
  note: Note | null;
  notebookDescription: string;
  tags: TagCount[];
  onOpenNote: (path: string) => void;
  onOpenTag: (tag: string) => void;
}) {
  if (!note) {
    return (
      <div className="space-y-5">
        <section>
          <SectionLabel icon={<IconTag className="h-3 w-3" />}>
            Notebook tags
          </SectionLabel>
          {tags.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {tags.map((tag) => (
                <button
                  key={tag.tag}
                  type="button"
                  onClick={() => onOpenTag(tag.tag)}
                  className="flex items-center gap-1 rounded-md border border-line bg-white/60 px-1.5 py-0.5 font-sans text-[14px] text-ink-soft transition hover:border-accent/30 hover:bg-accent-soft hover:text-accent-strong"
                  title={`Open #${tag.tag}`}
                >
                  #{tag.tag}
                  <span className="text-[14px] text-faint">{tag.count}</span>
                </button>
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
          <p className="mt-1 font-sans text-[14px] leading-relaxed text-muted">
            {notebookDescription || "Open a page to see its links and backlinks."}
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="animate-fade-up space-y-5">
      <section>
        <SectionLabel icon={<IconTag className="h-3 w-3" />}>Tags</SectionLabel>
        {note.tags.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {note.tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => onOpenTag(tag)}
                className="rounded-md border border-line bg-white/60 px-1.5 py-0.5 font-sans text-[14px] text-ink-soft transition hover:border-accent/30 hover:bg-accent-soft hover:text-accent-strong"
                title={`Open #${tag}`}
              >
                #{tag}
              </button>
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
                    onClick={() => onOpenNote(link.note_id ?? "")}
                    className="w-full truncate rounded px-1.5 py-1 text-left font-sans text-[14px] text-ink-soft transition hover:bg-white/70"
                    title={`Open ${link.title ?? link.label}`}
                  >
                    {link.label}
                  </button>
                ) : (
                  <span
                    className="flex items-center gap-1 px-1.5 py-1 font-sans text-[14px] text-faint"
                    title="No note with this title in the notebook"
                  >
                    <span className="truncate">{link.label}</span>
                    <span className="ml-auto shrink-0 rounded bg-panel px-1 font-sans text-[14px] uppercase tracking-wide">
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
          <span className="ml-1 font-sans text-[14px] font-normal tracking-normal text-line-strong">
            {note.backlinks.length}
          </span>
        </SectionLabel>
        {note.backlinks.length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {note.backlinks.map((backlink) => (
              <li key={backlink.id}>
                <button
                  type="button"
                  onClick={() => onOpenNote(backlink.id)}
                  className="w-full truncate rounded px-1.5 py-1 text-left font-sans text-[14px] text-ink-soft transition hover:bg-white/70"
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
    </div>
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
    <h3 className="flex items-center gap-1.5 text-[14px] font-semibold uppercase tracking-[0.16em] text-faint">
      {icon}
      {children}
    </h3>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt>{label}</dt>
      <dd className="text-right text-muted">{value}</dd>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1.5 font-sans text-[14px] leading-relaxed text-faint">
      {children}
    </p>
  );
}
