import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useAtom, useAtomValue } from "jotai";

import type { Note, TagCount } from "../api/types";
import { fullTime, wordCount } from "../lib/format";
import { useAppNavigate } from "../lib/appNavigation";
import { IconFile, IconLink, IconTag } from "./Icons";
import { GraphPanel } from "./GraphPanel";
import {
  activeNoteAtom,
  activeNoteIdAtom,
  activeNotebookAtom,
  activeNotebookIdAtom,
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  rightPanelWidthAtom,
  statsAtom,
  tagsAtom,
} from "../state/atoms";

type Tab = "context" | "agent" | "info" | "graph";

/** The agent bundle (pi-ai, radix, …) only loads when its tab is first opened. */
const AgentPanel = lazy(() =>
  import("./agent/AgentPanel").then((module) => ({
    default: module.AgentPanel,
  })),
);

const TAG_PREVIEW_LIMIT = 12;

/** The panel may grow to half the viewport; below the minimum it stops shrinking. */
function maxPanelWidth(viewportWidth: number): number {
  return Math.max(RIGHT_PANEL_MIN_WIDTH, Math.floor(viewportWidth * 0.5));
}

function clampPanelWidth(width: number, maxWidth: number): number {
  return Math.min(Math.max(Math.round(width), RIGHT_PANEL_MIN_WIDTH), maxWidth);
}

export function RightPanel() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const notebook = useAtomValue(activeNotebookAtom);
  const activeNoteId = useAtomValue(activeNoteIdAtom);
  const cachedNote = useAtomValue(activeNoteAtom);
  const note = cachedNote?.id === activeNoteId ? cachedNote : null;
  const tags = useAtomValue(tagsAtom);
  const stats = useAtomValue(statsAtom);
  const navigate = useAppNavigate();
  const [tab, setTab] = useState<Tab>("agent");
  const [storedWidth, setStoredWidth] = useAtom(rightPanelWidthAtom);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [dragging, setDragging] = useState(false);
  // Live width while dragging; persisted once on pointer-up so a drag does not
  // write to localStorage on every pointer move.
  const [draftWidth, setDraftWidth] = useState<number | null>(null);
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    next: number;
  } | null>(null);

  // Track the viewport so a shrunken window (or a width saved on a large
  // monitor) still leaves room for the main pane.
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = previous;
    };
  }, [dragging]);

  const maxWidth = maxPanelWidth(viewport);
  const width = clampPanelWidth(draftWidth ?? storedWidth, maxWidth);

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragRef.current = {
        startX: event.clientX,
        startWidth: width,
        next: width,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    },
    [width],
  );

  const onHandlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.next = drag.startWidth + (drag.startX - event.clientX);
      setDraftWidth(drag.next);
    },
    [],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      setStoredWidth(clampPanelWidth(drag.next, maxWidth));
      setDraftWidth(null);
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [maxWidth, setStoredWidth],
  );

  const onHandleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 64 : 16;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setStoredWidth((current) => clampPanelWidth(current + step, maxWidth));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setStoredWidth((current) => clampPanelWidth(current - step, maxWidth));
      } else if (event.key === "Home") {
        event.preventDefault();
        setStoredWidth(RIGHT_PANEL_DEFAULT_WIDTH);
      }
    },
    [maxWidth, setStoredWidth],
  );

  // The agent does not belong to a notebook, so it stays reachable from an
  // empty workspace; the notebook tabs only exist once one is selected.
  const tabs: Array<{ id: Tab; label: string; count?: number }> = notebookId
    ? [
        { id: "agent", label: "Agent" },
        {
          id: "context",
          label: "Context",
          count: note ? note.backlinks.length : undefined,
        },
        { id: "info", label: "Info" },
        { id: "graph", label: "Graph" },
      ]
    : [{ id: "agent", label: "Agent" }];
  const activeTab: Tab = tabs.some((item) => item.id === tab)
    ? tab
    : (tabs[0]?.id ?? "agent");

  return (
    <aside
      className="relative flex h-full w-[var(--right-panel-width)] shrink-0 flex-col border-l border-line bg-panel shadow-panel max-md:w-[min(24rem,calc(100vw-3rem))] md:bg-panel/25 md:shadow-none"
      style={{ "--right-panel-width": `${width}px` } as CSSProperties}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize right panel"
        aria-valuenow={width}
        aria-valuemin={RIGHT_PANEL_MIN_WIDTH}
        aria-valuemax={maxWidth}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={() => setStoredWidth(RIGHT_PANEL_DEFAULT_WIDTH)}
        onKeyDown={onHandleKeyDown}
        className={`absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize touch-none outline-none transition max-md:hidden ${
          dragging
            ? "bg-accent/40"
            : "hover:bg-accent/20 focus-visible:bg-accent/30"
        }`}
      />

      <div className="flex shrink-0 border-b border-line px-2 pt-2">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`relative flex items-center gap-1 px-2.5 pb-2 pt-1 font-sans text-[14px] font-semibold uppercase tracking-[0.12em] transition ${
              activeTab === item.id
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
            {activeTab === item.id && (
              <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" />
            )}
          </button>
        ))}
      </div>

      <div
        className={
          activeTab === "agent"
            ? "min-h-0 flex-1 overflow-hidden"
            : activeTab === "graph"
              ? "min-h-0 flex-1 overflow-hidden p-3"
              : "min-h-0 flex-1 overflow-y-auto px-4 py-4"
        }
      >
        {activeTab === "context" && (
          <ContextTab
            note={note}
            notebookDescription={notebook?.description ?? ""}
            tags={tags}
            onOpenNote={(path) => navigate({ view: "note", noteId: path })}
            onOpenTag={(tag) => navigate({ view: "tag", tag })}
          />
        )}

        {activeTab === "agent" && (
          <Suspense
            fallback={
              <p className="px-4 py-6 text-center font-mono text-[14px] text-faint">
                Loading agent…
              </p>
            }
          >
            <AgentPanel />
          </Suspense>
        )}

        {activeTab === "info" && (
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

        {activeTab === "graph" && notebookId && (
          <GraphPanel
            notebookId={notebookId}
            activeNoteId={note?.id ?? null}
            panel
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
  const [showAllTags, setShowAllTags] = useState(false);

  if (!note) {
    const visibleTags = showAllTags
      ? tags
      : tags.slice(0, TAG_PREVIEW_LIMIT);
    return (
      <div className="space-y-5">
        <section>
          <SectionLabel icon={<IconLink className="h-3 w-3" />}>
            Outgoing links
          </SectionLabel>
          <Hint>Open a page to see its outgoing links.</Hint>
        </section>
        <section>
          <SectionLabel icon={<IconFile className="h-3 w-3" />}>
            Backlinks
          </SectionLabel>
          <Hint>Open a page to see what links to it.</Hint>
        </section>
        <section>
          <SectionLabel icon={<IconTag className="h-3 w-3" />}>
            Notebook tags
          </SectionLabel>
          {tags.length > 0 ? (
            <>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {visibleTags.map((tag) => (
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
              {tags.length > TAG_PREVIEW_LIMIT && (
                <button
                  type="button"
                  onClick={() => setShowAllTags((value) => !value)}
                  className="mt-1.5 font-mono text-[12px] text-faint transition hover:text-ink"
                >
                  {showAllTags ? "Show fewer" : `Show all ${tags.length}`}
                </button>
              )}
            </>
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

  const visibleNoteTags = showAllTags
    ? note.tags
    : note.tags.slice(0, TAG_PREVIEW_LIMIT);

  return (
    <div className="animate-fade-up space-y-5">
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

      <section>
        <SectionLabel icon={<IconTag className="h-3 w-3" />}>Tags</SectionLabel>
        {note.tags.length > 0 ? (
          <>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {visibleNoteTags.map((tag) => (
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
            {note.tags.length > TAG_PREVIEW_LIMIT && (
              <button
                type="button"
                onClick={() => setShowAllTags((value) => !value)}
                className="mt-1.5 font-mono text-[12px] text-faint transition hover:text-ink"
              >
                {showAllTags ? "Show fewer" : `Show all ${note.tags.length}`}
              </button>
            )}
          </>
        ) : (
          <Hint>Add commas to the tag field, or write #tags inline.</Hint>
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
