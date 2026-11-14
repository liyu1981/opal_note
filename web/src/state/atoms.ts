import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import { ApiError, api, getStoredToken, storeToken } from "../api/client";
import type {
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

/** Full-page notebook graph view. */
export const graphViewAtom = atom(false);

/** Full-page notebook asset browser. */
export const assetsViewAtom = atom(false);

/** Current omni-bar query, including the optional `#tag` prefix. */
export const omniQueryAtom = atom("");

/** Incremented by the search shortcut to focus the omni bar. */
export const omniFocusRequestAtom = atom(0);

/** Rows per page in the pages directory; persisted per browser. */
export const pagesPageSizeAtom = atomWithStorage<number>(
  "opalnote.pages-page-size",
  20,
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
    set(graphViewAtom, false);
    set(assetsViewAtom, false);
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

/** Presentation lock. Kept outside the note editor so link navigation stays
 * read-only until the user unlocks. */
export const readOnlyAtom = atom(false);

export const settingsOpenAtom = atom(false);

/** Incremented by the Save shortcut; the active note editor consumes it. */
export const saveRequestAtom = atom(0);

/** Pending multi-key shortcut sequence, shown in the shortcut HUD. */
export const shortcutSequenceAtom = atom("");

/** While recording a shortcut in Settings, global shortcuts are suspended. */
export const shortcutRecordingAtom = atom(false);

export const tokenAtom = atom(getStoredToken());

export const saveTokenAtom = atom(null, (_get, set, token: string) => {
  storeToken(token);
  set(tokenAtom, token);
  set(revisionAtom, (revision) => revision + 1);
});

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

export const activeNoteAtom = atom(async (get): Promise<Note | null> => {
  get(notesRevisionAtom);
  const notebookId = get(activeNotebookIdAtom);
  const id = get(activeNoteIdAtom);
  if (!notebookId || !id) return null;
  try {
    return await api.getNote(notebookId, id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
});

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
