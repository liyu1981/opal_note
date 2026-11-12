import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import { formatJournalDate, ensureJournal } from "../lib/journal";
import {
  IconCalendar,
  IconChevron,
  IconClock,
  IconFile,
  IconGraph,
  IconOpal,
  IconPlus,
  IconStar,
  IconTrash,
} from "./Icons";
import {
  activeNoteIdAtom,
  activeNotebookAtom,
  activeNotebookIdAtom,
  favoritesAtom,
  journalViewAtom,
  navigateAtom,
  notesAtom,
  notebooksAtom,
  pagesViewAtom,
  readOnlyAtom,
  recentsAtom,
  refreshAtom,
  selectNotebookAtom,
  type NoteRef,
} from "../state/atoms";

export function LeftSidebar() {
  const notebooks = useAtomValue(notebooksAtom);
  const notebook = useAtomValue(activeNotebookAtom);
  const activeNotebookId = useAtomValue(activeNotebookIdAtom);
  const notes = useAtomValue(notesAtom);
  const activeNoteId = useAtomValue(activeNoteIdAtom);
  const journalView = useAtomValue(journalViewAtom);
  const pagesView = useAtomValue(pagesViewAtom);
  const favorites = useAtomValue(favoritesAtom);
  const recents = useAtomValue(recentsAtom);
  const locked = useAtomValue(readOnlyAtom);

  const navigate = useSetAtom(navigateAtom);
  const selectNotebook = useSetAtom(selectNotebookAtom);
  const refresh = useSetAtom(refreshAtom);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAdding(false);
  }, [activeNotebookId]);

  const noteByPath = useMemo(
    () => new Map(notes.map((note) => [note.id, note])),
    [notes],
  );
  const favoriteRefs = activeNotebookId
    ? (favorites[activeNotebookId] ?? [])
    : [];
  const recentRefs = activeNotebookId ? (recents[activeNotebookId] ?? []) : [];
  const journalNotes = useMemo(
    () =>
      notes
        .filter((note) => note.id.startsWith("journals/"))
        .sort((left, right) => right.id.localeCompare(left.id)),
    [notes],
  );
  const pageNotes = notes.filter((note) => note.id.startsWith("pages/"));

  function openNote(path: string) {
    navigate({ view: "note", noteId: path });
  }

  function openJournalFeed() {
    navigate({ view: "journal" });
  }

  function openPagesView() {
    navigate({ view: "pages" });
  }

  async function openToday() {
    if (!activeNotebookId || locked) return;
    try {
      const note = await ensureJournal(activeNotebookId);
      openNote(note.id);
      refresh();
    } catch (cause) {
      window.alert(
        cause instanceof Error ? cause.message : "Could not open today's journal",
      );
    }
  }

  async function createPage() {
    if (!activeNotebookId || busy || locked) return;
    setBusy(true);
    try {
      const note = await api.createNote(activeNotebookId, {
        title: "Untitled",
        content: "",
      });
      openNote(note.id);
      refresh();
    } catch (cause) {
      window.alert(
        cause instanceof Error ? cause.message : "Could not create page",
      );
    } finally {
      setBusy(false);
    }
  }

  function switchNotebook(id: string) {
    selectNotebook(id || null);
  }

  async function createNotebook(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy || locked) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createNotebook({ name: trimmed });
      setAdding(false);
      switchNotebook(created.id);
      refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create notebook",
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeNotebook() {
    if (!notebook || locked) return;
    if (
      !window.confirm(
        `Delete “${notebook.name}” and every note inside it? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      await api.deleteNotebook(notebook.id);
      switchNotebook("");
      refresh();
    } catch (cause) {
      window.alert(
        cause instanceof Error ? cause.message : "Could not delete notebook",
      );
    }
  }

  function refTitle(ref: NoteRef) {
    const title = noteByPath.get(ref.path)?.title ?? ref.title;
    return ref.path.startsWith("journals/") ? formatJournalDate(title) : title;
  }

  return (
    <aside className="flex w-[15.5rem] shrink-0 flex-col border-r border-line bg-panel/35">
      <div className="border-b border-line px-3 pb-2 pt-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-ink text-canvas">
            <IconOpal className="h-3.5 w-3.5" />
          </span>
          <span className="font-serif text-[16px] leading-none text-ink">
            Opal Note
          </span>
          <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.14em] text-faint">
            graph
          </span>
        </div>

        <div className="mt-2.5 flex items-center gap-1">
          <select
            value={activeNotebookId ?? ""}
            onChange={(event) => switchNotebook(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-line bg-white/70 px-2 py-1 font-mono text-[11px] text-ink-soft outline-none focus:border-accent/60"
            aria-label="Notebook"
          >
            <option value="">No notebook</option>
            {notebooks.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setAdding((open) => !open)}
            disabled={locked}
            className="rounded-md border border-line bg-white/60 p-1 text-muted transition hover:bg-white hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="New notebook"
            title={locked ? "Unlock editing to create notebooks" : "New notebook"}
          >
            <IconPlus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={removeNotebook}
            disabled={!notebook || locked}
            className="rounded-md border border-transparent p-1 text-faint transition hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Delete notebook"
            title={locked ? "Read only" : "Delete current notebook"}
          >
            <IconTrash className="h-3.5 w-3.5" />
          </button>
        </div>

        {adding && !locked && (
          <form onSubmit={createNotebook} className="mt-2 space-y-1.5">
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Notebook name"
              maxLength={120}
              className="w-full rounded-md border border-line bg-white px-2 py-1 font-mono text-[11px] outline-none focus:border-accent"
            />
            {error && <p className="text-[10px] text-danger">{error}</p>}
            <div className="flex gap-1">
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="rounded bg-ink px-2 py-1 text-[10px] font-medium text-canvas disabled:opacity-40"
              >
                {busy ? "Adding…" : "Add"}
              </button>
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="rounded px-2 py-1 text-[10px] text-muted hover:bg-panel-strong"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {!activeNotebookId ? (
          <p className="mx-1 mt-3 rounded-lg border border-dashed border-line-strong px-3 py-4 text-center font-mono text-[10.5px] leading-relaxed text-muted">
            Create a notebook to start a journal or write pages.
          </p>
        ) : (
          <>
            <div className="space-y-0.5 border-b border-line pb-2">
              <NavItem
                icon={<IconCalendar className="h-3.5 w-3.5" />}
                label="Journals"
                active={journalView}
                onClick={openJournalFeed}
              />
              <NavItem
                icon={<IconFile className="h-3.5 w-3.5" />}
                label="Pages"
                active={pagesView}
                onClick={openPagesView}
              />
              <NavItem
                icon={<IconGraph className="h-3.5 w-3.5" />}
                label="Graph view"
                active={false}
                disabled
                soon
              />
            </div>

            <SidebarSection title="Favorites" count={favoriteRefs.length}>
              {favoriteRefs.length === 0 ? (
                <Hint>Star a page in the editor to pin it here.</Hint>
              ) : (
                favoriteRefs.map((ref) => (
                  <NoteRow
                    key={ref.path}
                    title={refTitle(ref)}
                    active={ref.path === activeNoteId}
                    icon={<IconStar className="h-3 w-3 text-accent" />}
                    onClick={() => openNote(ref.path)}
                  />
                ))
              )}
            </SidebarSection>

            <SidebarSection title="Recent" count={recentRefs.length}>
              {recentRefs.length === 0 ? (
                <Hint>Pages you open will appear here.</Hint>
              ) : (
                recentRefs.map((ref) => (
                  <NoteRow
                    key={ref.path}
                    title={refTitle(ref)}
                    active={ref.path === activeNoteId}
                    icon={<IconClock className="h-3 w-3" />}
                    onClick={() => openNote(ref.path)}
                  />
                ))
              )}
            </SidebarSection>

            <SidebarSection
              title="Journal"
              count={journalNotes.length}
              action={
                <button
                  type="button"
                  onClick={openToday}
                  disabled={locked}
                  className="rounded px-1.5 py-0.5 font-mono text-[9px] text-accent-strong transition hover:bg-accent-soft disabled:opacity-40"
                  title={locked ? "Read only" : "Open today's journal"}
                >
                  Today
                </button>
              }
            >
              {journalNotes.length === 0 ? (
                <Hint>No journal pages yet. Start with Today.</Hint>
              ) : (
                journalNotes.slice(0, 6).map((note) => (
                  <NoteRow
                    key={note.id}
                    title={formatJournalDate(note.title)}
                    active={note.id === activeNoteId}
                    icon={<IconCalendar className="h-3 w-3" />}
                    onClick={() => openNote(note.id)}
                  />
                ))
              )}
              {journalNotes.length > 0 && (
                <button
                  type="button"
                  onClick={openJournalFeed}
                  className="mt-1 w-full rounded px-2 py-1 text-left font-mono text-[9.5px] text-faint transition hover:bg-panel-strong hover:text-ink"
                >
                  Open journal feed →
                </button>
              )}
            </SidebarSection>

            <div id="pages-section">
              <SidebarSection
                title="Pages"
                count={pageNotes.length}
                action={
                  <button
                    type="button"
                    onClick={createPage}
                    disabled={locked || busy}
                    className="rounded p-1 text-muted transition hover:bg-panel-strong hover:text-ink disabled:opacity-30"
                    aria-label="New page"
                    title={locked ? "Read only" : "New page"}
                  >
                    <IconPlus className="h-3 w-3" />
                  </button>
                }
              >
                {pageNotes.length === 0 ? (
                  <Hint>No pages yet.</Hint>
                ) : (
                  pageNotes.map((note) => (
                    <NoteRow
                      key={note.id}
                      title={note.title}
                      active={note.id === activeNoteId}
                      icon={<IconFile className="h-3 w-3" />}
                      onClick={() => openNote(note.id)}
                    />
                  ))
                )}
              </SidebarSection>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function SidebarSection({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border-b border-line/60 py-1.5 last:border-0">
      <div className="flex items-center gap-1 px-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-left font-mono text-[9.5px] font-semibold uppercase tracking-[0.13em] text-faint transition hover:text-ink-soft"
        >
          <IconChevron
            className={`h-3 w-3 transition-transform ${open ? "" : "-rotate-90"}`}
          />
          <span className="truncate">{title}</span>
          {count !== undefined && (
            <span className="ml-1 font-mono text-[8.5px] font-normal tracking-normal text-line-strong">
              {count}
            </span>
          )}
        </button>
        {action}
      </div>
      {open && <div className="mt-0.5 space-y-0.5">{children}</div>}
    </section>
  );
}

function NoteRow({
  title,
  active,
  icon,
  onClick,
}: {
  title: string;
  active: boolean;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition ${
        active
          ? "bg-accent-soft/70 text-accent-strong"
          : "text-ink-soft hover:bg-white/60"
      }`}
    >
      <span className="shrink-0 text-faint">{icon}</span>
      <span className="truncate font-mono text-[11px]">{title}</span>
    </button>
  );
}

function NavItem({
  icon,
  label,
  active,
  onClick,
  disabled = false,
  soon = false,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick?: () => void;
  disabled?: boolean;
  soon?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11.5px] transition ${
        active
          ? "bg-panel-strong text-ink"
          : "text-ink-soft hover:bg-white/60"
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      <span className={active ? "text-accent" : "text-faint"}>{icon}</span>
      <span className="truncate">{label}</span>
      {soon && (
        <span className="ml-auto rounded bg-panel px-1 py-0.5 font-mono text-[8px] uppercase tracking-wide text-faint">
          soon
        </span>
      )}
    </button>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-1.5 font-mono text-[9.5px] leading-relaxed text-faint">
      {children}
    </p>
  );
}
