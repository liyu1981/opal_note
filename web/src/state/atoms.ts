import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import { ApiError, api, getStoredToken, storeToken } from "../api/client";
import type { Note, NoteSummary, Notebook, Stats, TagCount } from "../api/types";

/** Bumped after every mutation to invalidate the read atoms below. */
export const revisionAtom = atom(0);

export const refreshAtom = atom(null, (_get, set) => {
  set(revisionAtom, (revision) => revision + 1);
});

export const activeNotebookIdAtom = atomWithStorage<string | null>(
  "opalnote.active-notebook",
  null,
);

export const activeNoteIdAtom = atomWithStorage<string | null>(
  "opalnote.active-note",
  null,
);

export const searchQueryAtom = atom("");

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
  get(revisionAtom);
  const notebookId = get(activeNotebookIdAtom);
  if (!notebookId) return [];

  const query = get(searchQueryAtom).trim();
  try {
    return query
      ? await api.searchNotes(notebookId, query, 50)
      : await api.listNotes(notebookId, 100);
  } catch (error) {
    // A notebook deleted in another tab must not take down the workspace;
    // the selection effect will pick a valid one on the next render.
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
});

export const activeNoteAtom = atom(async (get): Promise<Note | null> => {
  get(revisionAtom);
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
  get(revisionAtom);
  return api.stats();
});

export const tagsAtom = atom(async (get): Promise<TagCount[]> => {
  get(revisionAtom);
  const notebookId = get(activeNotebookIdAtom);
  if (!notebookId) return [];
  try {
    return await api.listTags(notebookId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
});
