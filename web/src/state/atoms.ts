import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import { ApiError, api, getStoredToken, storeToken } from "../api/client";
import type { Note, NoteSummary, Notebook, Stats, TagCount } from "../api/types";

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

export const activeNotebookIdAtom = atomWithStorage<string | null>(
  "opalnote.active-notebook",
  null,
);

export const activeNoteIdAtom = atomWithStorage<string | null>(
  "opalnote.active-note",
  null,
);

/** When true the main pane is the journal feed rather than a single note. */
export const journalViewAtom = atom(true);

/** Dedicated page-directory view (placeholder for now). */
export const pagesViewAtom = atom(false);

export const searchOpenAtom = atom(false);

export type WorkspaceView = "journal" | "pages" | "note";

export type WorkspaceLocation = {
  notebookId: string | null;
  view: WorkspaceView;
  noteId: string | null;
};

export type NavigationTarget =
  | { view: "journal"; notebookId?: string | null }
  | { view: "pages"; notebookId?: string | null }
  | { view: "note"; notebookId?: string | null; noteId: string };

/** The location currently shown by the workspace. */
export const currentLocationAtom = atom<WorkspaceLocation>((get) => {
  const journal = get(journalViewAtom);
  const pages = get(pagesViewAtom);
  const view: WorkspaceView = journal ? "journal" : pages ? "pages" : "note";
  return {
    notebookId: get(activeNotebookIdAtom),
    view,
    noteId: view === "note" ? get(activeNoteIdAtom) : null,
  };
});

type NavigationHistory = {
  entries: WorkspaceLocation[];
  index: number;
};

/** Browser-style in-memory history for note, journal and page views. */
export const navigationHistoryAtom = atom<NavigationHistory>({
  entries: [],
  index: -1,
});

export const canGoBackAtom = atom(
  (get) => get(navigationHistoryAtom).index > 0,
);

export const canGoForwardAtom = atom((get) => {
  const history = get(navigationHistoryAtom);
  return history.index >= 0 && history.index < history.entries.length - 1;
});

function sameLocation(a: WorkspaceLocation, b: WorkspaceLocation): boolean {
  return (
    a.notebookId === b.notebookId &&
    a.view === b.view &&
    a.noteId === b.noteId
  );
}

const applyWorkspaceLocationAtom = atom(
  null,
  (_get, set, location: WorkspaceLocation) => {
    set(activeNotebookIdAtom, location.notebookId);
    set(journalViewAtom, location.view === "journal");
    set(pagesViewAtom, location.view === "pages");
    set(activeNoteIdAtom, location.view === "note" ? location.noteId : null);
  },
);

/** Push a destination onto history and show it. */
export const navigateAtom = atom(
  null,
  (get, set, target: NavigationTarget) => {
    const current = get(currentLocationAtom);
    const notebookId = target.notebookId ?? current.notebookId;
    if (!notebookId) return;

    const next: WorkspaceLocation = {
      notebookId,
      view: target.view,
      noteId: target.view === "note" ? target.noteId : null,
    };
    if (sameLocation(current, next)) return;

    const history = get(navigationHistoryAtom);
    let entries = history.entries.slice(0, history.index + 1);
    if (entries.length === 0) {
      entries = [current];
    } else {
      const tail = entries[entries.length - 1];
      if (!tail || !sameLocation(tail, current)) entries.push(current);
    }
    entries.push(next);
    set(navigationHistoryAtom, {
      entries,
      index: entries.length - 1,
    });
    set(applyWorkspaceLocationAtom, next);
  },
);

export const goBackAtom = atom(null, (get, set) => {
  const history = get(navigationHistoryAtom);
  if (history.index <= 0) return;
  const index = history.index - 1;
  const location = history.entries[index];
  if (!location) return;
  set(navigationHistoryAtom, { ...history, index });
  set(applyWorkspaceLocationAtom, location);
});

export const goForwardAtom = atom(null, (get, set) => {
  const history = get(navigationHistoryAtom);
  if (history.index < 0 || history.index >= history.entries.length - 1) return;
  const index = history.index + 1;
  const location = history.entries[index];
  if (!location) return;
  set(navigationHistoryAtom, { ...history, index });
  set(applyWorkspaceLocationAtom, location);
});

/** A rename changes the current note path without creating a history entry. */
export const replaceNoteIdAtom = atom(null, (get, set, noteId: string) => {
  const current = get(currentLocationAtom);
  const next: WorkspaceLocation = { ...current, view: "note", noteId };
  if (sameLocation(current, next)) return;
  set(applyWorkspaceLocationAtom, next);

  const history = get(navigationHistoryAtom);
  const entry = history.entries[history.index];
  if (history.index >= 0 && entry && sameLocation(entry, current)) {
    const entries = [...history.entries];
    entries[history.index] = next;
    set(navigationHistoryAtom, { ...history, entries });
  }
});

/** Switching notebooks starts a fresh history at that notebook's journal. */
export const selectNotebookAtom = atom(
  null,
  (get, set, notebookId: string | null) => {
    if (get(activeNotebookIdAtom) === notebookId) return;
    set(activeNotebookIdAtom, notebookId);
    set(activeNoteIdAtom, null);
    set(journalViewAtom, true);
    set(pagesViewAtom, false);
    set(navigationHistoryAtom, { entries: [], index: -1 });
    set(searchOpenAtom, false);
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
