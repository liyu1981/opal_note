import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import { ApiError, api } from "../api/client";
import type {
  BackgroundList,
  Note,
  NoteSummary,
  Notebook,
  Stats,
  TagCount,
} from "../api/types";

/** Bumped after structural mutations (notebooks, note count) to invalidate all
 * read atoms. Ordinary note saves use notesRevisionAtom instead so the root
 * workspace and its editors do not suspend mid-edit. */
export const revisionAtom = atom(0);

/** Bumped after note content/title/tag changes. Readers with their own
 * Suspense boundary can refresh without invalidating notebooks or the shell. */
export const notesRevisionAtom = atom(0);

export const refreshAtom = atom(null, (_get, set) => {
  set(revisionAtom, (revision) => revision + 1);
  set(notesRevisionAtom, (revision) => revision + 1);
});

export const refreshNotesAtom = atom(null, (_get, set) => {
  set(notesRevisionAtom, (revision) => revision + 1);
});

/** Bumped by journal-card saves so the plugin rail can refresh without
 * invalidating notesAtom (and therefore without suspending the journal feed). */
export const journalPluginsRevisionAtom = atom(0);

export const refreshJournalPluginsAtom = atom(null, (_get, set) => {
  set(journalPluginsRevisionAtom, (revision) => revision + 1);
});

export const activeNotebookIdAtom = atomWithStorage<string | null>(
  "opalnote.active-notebook",
  null,
);

export const activeNoteIdAtom = atomWithStorage<string | null>(
  "opalnote.active-note",
  null,
);

/** When true the main pane is the home dashboard. */
export const homeViewAtom = atom(true);

/** When true the main pane is the journal feed rather than a single note. */
export const journalViewAtom = atom(false);

/** Dedicated page-directory view. */
export const pagesViewAtom = atom(false);

/** Dedicated todo-directory view. */
export const tasksViewAtom = atom(false);

/** Full-page notebook graph view. */
export const graphViewAtom = atom(false);

/** Full-page notebook asset browser. */
export const assetsViewAtom = atom(false);

/** Global trash/bin view. */
export const trashViewAtom = atom(false);

/** Current omni-bar query, including the optional `#tag` prefix. */
export const omniQueryAtom = atom("");

/** Incremented by the search shortcut to focus the omni bar. */
export const omniFocusRequestAtom = atom(0);

/** Rows per page in the pages directory; persisted per browser. */
export const pagesPageSizeAtom = atomWithStorage<number>(
  "opalnote.pages-page-size",
  20,
);

/** Rows per page in the todo directory; persisted per browser. */
export const tasksPageSizeAtom = atomWithStorage<number>(
  "opalnote.tasks-page-size",
  20,
);

/** Status filters selected in the todo directory; persisted per browser. */
export const taskStatusFilterAtom = atomWithStorage<string[]>(
  "opalnote.task-status-filter",
  ["open", "doing"],
);

/** Expanded/collapsed state for left-sidebar sections, keyed by section title. */
export const sidebarSectionsAtom = atomWithStorage<Record<string, boolean>>(
  "opalnote.sidebar-sections.v2",
  {},
);

/** Switching notebooks clears note selection and returns to the journal. */
export const selectNotebookAtom = atom(
  null,
  (get, set, notebookId: string | null) => {
    if (get(activeNotebookIdAtom) === notebookId) return;
    set(activeNotebookIdAtom, notebookId);
    set(activeNoteIdAtom, null);
    set(homeViewAtom, true);
    set(journalViewAtom, false);
    set(pagesViewAtom, false);
    set(tasksViewAtom, false);
    set(graphViewAtom, false);
    set(assetsViewAtom, false);
    set(trashViewAtom, false);
  },
);

export type NoteRef = {
  notebookId: string;
  path: string;
  title: string;
};

export const leftPanelOpenAtom = atomWithStorage<boolean>(
  "opalnote.left-panel.v2",
  false,
);

export const rightPanelOpenAtom = atomWithStorage<boolean>(
  "opalnote.right-panel.v2",
  false,
);

/** Default width in px; the panel can be dragged from 320px up to half the viewport. */
export const RIGHT_PANEL_MIN_WIDTH = 320;
export const RIGHT_PANEL_DEFAULT_WIDTH = 420;

/** Persisted right-panel width in px (clamped on render). */
export const rightPanelWidthAtom = atomWithStorage<number>(
  "opalnote.right-panel-width",
  RIGHT_PANEL_DEFAULT_WIDTH,
);

export const favoritesAtom = atomWithStorage<Record<string, NoteRef[]>>(
  "opalnote.favorites",
  {},
);

export const recentsAtom = atomWithStorage<Record<string, NoteRef[]>>(
  "opalnote.recents",
  {},
);

export const toggleFavoriteAtom = atom(
  null,
  (get, set, ref: NoteRef) => {
    const all = get(favoritesAtom);
    const list = all[ref.notebookId] ?? [];
    const exists = list.some((item) => item.path === ref.path);
    const next = exists
      ? list.filter((item) => item.path !== ref.path)
      : [ref, ...list.filter((item) => item.path !== ref.path)].slice(0, 30);
    set(favoritesAtom, { ...all, [ref.notebookId]: next });
  },
);

export const recordRecentAtom = atom(
  null,
  (get, set, ref: NoteRef) => {
    const all = get(recentsAtom);
    const list = all[ref.notebookId] ?? [];
    const next = [ref, ...list.filter((item) => item.path !== ref.path)].slice(
      0,
      8,
    );
    set(recentsAtom, { ...all, [ref.notebookId]: next });
  },
);

/** Keep favorites/recents pointing at the right file after a rename. */
export const renameNoteRefsAtom = atom(
  null,
  (
    get,
    set,
    change: {
      notebookId: string;
      oldPath: string;
      newPath: string;
      title: string;
    },
  ) => {
    const update = (all: Record<string, NoteRef[]>) => {
      const list = all[change.notebookId] ?? [];
      return {
        ...all,
        [change.notebookId]: list.map((item) =>
          item.path === change.oldPath
            ? { ...item, path: change.newPath, title: change.title }
            : item,
        ),
      };
    };
    set(favoritesAtom, update(get(favoritesAtom)));
    set(recentsAtom, update(get(recentsAtom)));
  },
);

/** Keep favorites/recents under the renamed notebook id. The note paths do not
 * change when a notebook folder is renamed, so only the notebook key and each
 * ref's `notebookId` need to move. */
export const renameNotebookRefsAtom = atom(
  null,
  (get, set, change: { oldId: string; newId: string }) => {
    if (change.oldId === change.newId) return;
    const migrate = (all: Record<string, NoteRef[]>) => {
      const previous = all[change.oldId];
      if (!previous) return all;
      const next = { ...all };
      delete next[change.oldId];
      const existing = next[change.newId] ?? [];
      const known = new Set(existing.map((item) => item.path));
      next[change.newId] = [
        ...previous
          .filter((item) => !known.has(item.path))
          .map((item) => ({ ...item, notebookId: change.newId })),
        ...existing,
      ];
      return next;
    };
    set(favoritesAtom, migrate(get(favoritesAtom)));
    set(recentsAtom, migrate(get(recentsAtom)));
  },
);

/** Presentation lock. Kept outside the note editor so link navigation stays
 * read-only until the user unlocks. */
export const readOnlyAtom = atom(false);

export const settingsOpenAtom = atom(false);

/** Selected Settings tab; `Keyboard help` opens this on `shortcuts`. */
export const settingsTabAtom = atom("fonts");

/** Incremented by the Save shortcut; the active note editor consumes it. */
export const saveRequestAtom = atom(0);

/** Pending multi-key shortcut sequence, shown in the shortcut HUD. */
export const shortcutSequenceAtom = atom("");

export type ViewFocusTarget =
  | "view"
  | "home"
  | "journal"
  | "pages"
  | "tasks"
  | "graph"
  | "assets"
  | "asset"
  | "trash"
  | "note"
  | "tag";

export type ViewFocusRequest = {
  id: number;
  target: ViewFocusTarget;
  /** Optional route identity (note path, tag, …) so an outgoing view cannot
   * consume a request meant for the incoming one. */
  identity?: string;
};

let nextViewFocusId = 0;

export function createViewFocusRequest(
  target: ViewFocusTarget,
  identity?: string,
): ViewFocusRequest {
  nextViewFocusId += 1;
  return { id: nextViewFocusId, target, identity };
}

/** One-shot focus handoff from navigation to the destination view. */
export const pendingViewFocusAtom = atom<ViewFocusRequest | null>(null);

/** While recording a shortcut in Settings, global shortcuts are suspended. */
export const shortcutRecordingAtom = atom(false);

export const notebooksAtom = atom(async (get): Promise<Notebook[]> => {
  get(revisionAtom);
  return api.listNotebooks();
});

export const activeNotebookAtom = atom(
  async (get): Promise<Notebook | null> => {
    const id = get(activeNotebookIdAtom);
    if (!id) return null;
    const notebooks = await get(notebooksAtom);
    return notebooks.find((notebook) => notebook.id === id) ?? null;
  },
);

export const backgroundsRevisionAtom = atom(0);

export const refreshBackgroundsAtom = atom(null, (_get, set) => {
  set(backgroundsRevisionAtom, (revision) => revision + 1);
});

export const backgroundsAtom = atom(async (get): Promise<BackgroundList> => {
  get(backgroundsRevisionAtom);
  try {
    return await api.listBackgrounds();
  } catch {
    return { directory: "", backgrounds: [], errors: [] };
  }
});

export const notesAtom = atom(async (get): Promise<NoteSummary[]> => {
  get(notesRevisionAtom);
  const notebookId = get(activeNotebookIdAtom);
  if (!notebookId) return [];

  try {
    return await api.listNotes(notebookId, 200);
  } catch (error) {
    // A notebook deleted in another tab must not take down the workspace;
    // the selection effect will pick a valid one on the next render.
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
});

/** The active note shown in the right panel. The editor owns loading and
 * writes the authoritative note here, so ordinary saves do not refetch it. */
export const activeNoteAtom = atom<Note | null>(null);

export const statsAtom = atom(async (get): Promise<Stats> => {
  get(notesRevisionAtom);
  return api.stats();
});

export const tagsAtom = atom(async (get): Promise<TagCount[]> => {
  get(notesRevisionAtom);
  const notebookId = get(activeNotebookIdAtom);
  if (!notebookId) return [];
  try {
    return await api.listTags(notebookId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
});
