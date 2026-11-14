import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";

import { api } from "../api/client";
import type { Notebook } from "../api/types";
import { formatJournalDate } from "../lib/journal";
import { useAppNavigate } from "../lib/appNavigation";
import { OpalLogo } from "./OpalLogo";
import { RenameNotebookDialog } from "./RenameNotebookDialog";
import {
  IconCalendar,
  IconChevron,
  IconClock,
  IconFile,
  IconFolder,
  IconGraph,
  IconHome,
  IconPencil,
  IconPlus,
  IconStar,
  IconTrash,
  IconUpload,
} from "./Icons";
import {
  activeNoteIdAtom,
  activeNotebookAtom,
  activeNotebookIdAtom,
  assetsViewAtom,
  favoritesAtom,
  graphViewAtom,
  homeViewAtom,
  journalViewAtom,
  notesAtom,
  notebooksAtom,
  pagesViewAtom,
  readOnlyAtom,
  recentsAtom,
  refreshAtom,
  renameNotebookRefsAtom,
  selectNotebookAtom,
  sidebarSectionsAtom,
  type NoteRef,
} from "../state/atoms";

export function LeftSidebar() {
  const notebooks = useAtomValue(notebooksAtom);
  const notebook = useAtomValue(activeNotebookAtom);
  const activeNotebookId = useAtomValue(activeNotebookIdAtom);
  const notes = useAtomValue(notesAtom);
  const activeNoteId = useAtomValue(activeNoteIdAtom);
  const homeView = useAtomValue(homeViewAtom);
  const journalView = useAtomValue(journalViewAtom);
  const pagesView = useAtomValue(pagesViewAtom);
  const graphView = useAtomValue(graphViewAtom);
  const assetsView = useAtomValue(assetsViewAtom);
  const favorites = useAtomValue(favoritesAtom);
  const recents = useAtomValue(recentsAtom);
  const locked = useAtomValue(readOnlyAtom);

  const navigate = useAppNavigate();
  const selectNotebook = useSetAtom(selectNotebookAtom);
  const refresh = useSetAtom(refreshAtom);
  const renameNotebookRefs = useSetAtom(renameNotebookRefsAtom);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAdding(false);
    setRenameOpen(false);
  }, [activeNotebookId]);

  useEffect(() => {
    if (locked) setRenameOpen(false);
  }, [locked]);

  const noteByPath = useMemo(
    () => new Map(notes.map((note) => [note.id, note])),
    [notes],
  );
  const favoriteRefs = activeNotebookId
    ? (favorites[activeNotebookId] ?? [])
    : [];
  const recentRefs = activeNotebookId ? (recents[activeNotebookId] ?? []) : [];
  function openNote(path: string) {
    navigate({ view: "note", noteId: path });
  }

  function openHome() {
    navigate({ view: "home" });
  }

  function openJournalFeed() {
    navigate({ view: "journal" });
  }

  function openPagesView() {
    navigate({ view: "pages" });
  }

  function openGraphView() {
    navigate({ view: "graph" });
  }

  function openAssetsView() {
    navigate({ view: "assets" });
  }

  function switchNotebook(id: string) {
    const notebookId = id || null;
    selectNotebook(notebookId);
    navigate({ view: "home" }, { notebookId });
  }

  async function importNotebook(file: File) {
    if (importing || locked) return;
    setImporting(true);
    setError(null);
    const requested =
      file.name.replace(/\.zip$/iu, "").trim() || "Imported Notebook";
    try {
      const created = await api.importNotebook(file, requested);
      setAdding(false);
      switchNotebook(created.id);
      refresh();
      if (created.name !== requested) {
        window.alert(
          `Imported as “${created.name}” because “${requested}” already exists.`,
        );
      }
    } catch (cause) {
      window.alert(
        cause instanceof Error ? cause.message : "Could not import notebook",
      );
    } finally {
      setImporting(false);
      if (importRef.current) importRef.current.value = "";
    }
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

  function handleRenamed(renamed: Notebook) {
    const previousId = notebook?.id;
    setRenameOpen(false);
    if (previousId && previousId !== renamed.id) {
      renameNotebookRefs({ oldId: previousId, newId: renamed.id });
    }
    selectNotebook(renamed.id);
    navigate({ view: "home" }, { notebookId: renamed.id, replace: true });
    refresh();
  }

  function refTitle(ref: NoteRef) {
    const title = noteByPath.get(ref.path)?.title ?? ref.title;
    return ref.path.startsWith("journals/") ? formatJournalDate(title) : title;
  }

  return (
    <aside className="flex w-[15.5rem] shrink-0 flex-col border-r border-line bg-panel/35">
      <div className="border-b border-line px-3 pb-2 pt-3">
        <div className="flex items-center gap-2">
          <OpalLogo className="h-7 w-7 shrink-0 drop-shadow-sm" />
          <span className="font-serif text-[16px] leading-none text-ink">
            OpalNote
          </span>
        </div>

        <div className="mt-2.5 flex items-center gap-1">
          <select
            value={activeNotebookId ?? ""}
            onChange={(event) => switchNotebook(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-line bg-white/70 px-2 py-1 font-mono text-[14px] text-ink-soft outline-none focus:border-accent/60"
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
          <input
            ref={importRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importNotebook(file);
            }}
          />
          <button
            type="button"
            onClick={() => importRef.current?.click()}
            disabled={locked || importing}
            className="rounded-md border border-transparent p-1 text-faint transition hover:bg-panel-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Import notebook ZIP"
            title={locked ? "Read only" : "Import Logseq ZIP as a new notebook"}
          >
            <IconUpload className={`h-3.5 w-3.5 ${importing ? "animate-pulse" : ""}`} />
          </button>
          <button
            type="button"
            onClick={() => setRenameOpen(true)}
            disabled={!notebook || locked}
            className="rounded-md border border-transparent p-1 text-faint transition hover:bg-panel-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Rename notebook"
            title={locked ? "Read only" : "Rename current notebook"}
          >
            <IconPencil className="h-3.5 w-3.5" />
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
              className="w-full rounded-md border border-line bg-white px-2 py-1 font-mono text-[14px] outline-none focus:border-accent"
            />
            {error && <p className="text-[14px] text-danger">{error}</p>}
            <div className="flex gap-1">
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="rounded bg-accent-strong px-2 py-1 text-[14px] font-medium text-white transition hover:bg-accent disabled:opacity-40"
              >
                {busy ? "Adding…" : "Add"}
              </button>
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="rounded px-2 py-1 text-[14px] text-muted hover:bg-panel-strong"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {!activeNotebookId ? (
          <p className="mx-1 mt-3 rounded-lg border border-dashed border-line-strong px-3 py-4 text-center font-mono text-[14px] leading-relaxed text-muted">
            Create a notebook to start a journal or write pages.
          </p>
        ) : (
          <>
            <div className="space-y-0.5 border-b border-line pb-2">
              <NavItem
                icon={<IconHome className="h-3.5 w-3.5" />}
                label="Home"
                active={homeView}
                onClick={openHome}
              />
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
                label="Graph"
                active={graphView}
                onClick={openGraphView}
              />
              <NavItem
                icon={<IconFolder className="h-3.5 w-3.5" />}
                label="Assets"
                active={assetsView}
                onClick={openAssetsView}
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

          </>
        )}
      </div>
      {renameOpen && notebook && !locked && (
        <RenameNotebookDialog
          notebook={notebook}
          onClose={() => setRenameOpen(false)}
          onRenamed={handleRenamed}
        />
      )}
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
  const [sections, setSections] = useAtom(sidebarSectionsAtom);
  const open = sections[title] ?? false;
  return (
    <section className="border-b border-line/60 py-2.5 last:border-0">
      <div className="flex items-center gap-1 px-1">
        <button
          type="button"
          onClick={() =>
            setSections((current) => ({
              ...current,
              [title]: !(current[title] ?? false),
            }))
          }
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left font-mono text-[1rem] font-semibold leading-tight tracking-[-0.025em] text-ink-soft transition hover:bg-white/50 hover:text-ink"
        >
          <IconChevron
            className={`h-4 w-4 shrink-0 text-faint transition-transform ${
              open ? "" : "-rotate-90"
            }`}
          />
          <span className="truncate">{title}</span>
          {count !== undefined && (
            <span className="ml-1 rounded-full bg-panel px-1.5 py-0.5 font-mono text-[14px] font-medium tracking-normal text-faint">
              {count}
            </span>
          )}
        </button>
        {action}
      </div>
      {open && <div className="mt-1 space-y-0.5">{children}</div>}
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
      <span className="truncate font-sans text-[14px]">{title}</span>
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
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[14px] transition ${
        active
          ? "bg-accent-soft text-accent-strong"
          : "text-ink-soft hover:bg-white/60"
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      <span className={active ? "text-accent" : "text-faint"}>{icon}</span>
      <span className="truncate">{label}</span>
      {soon && (
        <span className="ml-auto rounded bg-panel px-1 py-0.5 font-mono text-[14px] uppercase tracking-wide text-faint">
          soon
        </span>
      )}
    </button>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-1.5 font-mono text-[14px] leading-relaxed text-faint">
      {children}
    </p>
  );
}
