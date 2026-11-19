import { useEffect } from "react";
import { useSetAtom } from "jotai";

import { refreshNotesAtom } from "../state/atoms";

/** Ignore quick app switches; only revalidate when the tab was really away. */
const MIN_AWAY_MS = 2_000;

/**
 * Refresh the workspace when the page comes back.
 *
 * An installed PWA (and a backgrounded tab) is never reloaded: it resumes with
 * whatever state it held, so notes changed on another device stay stale until
 * the app is killed and reopened. Coming back from the background, a bfcache
 * restore, or a regained network connection re-reads note-derived data.
 *
 * Only `notesRevisionAtom` is bumped: it refreshes notes, journals, pages,
 * tasks, tags, stats and the graph without invalidating the notebook shell, so
 * an open editor keeps its unsaved draft instead of being torn down.
 */
export function useRevalidateOnResume(): void {
  const refreshNotes = useSetAtom(refreshNotesAtom);

  useEffect(() => {
    let lastRefresh = Date.now();

    const revalidate = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefresh < MIN_AWAY_MS) return;
      lastRefresh = Date.now();
      refreshNotes();
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        // Start the clock from the moment the app lost focus.
        lastRefresh = Math.min(lastRefresh, Date.now() - MIN_AWAY_MS);
        return;
      }
      revalidate();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      // bfcache restores keep the old DOM; treat them like a resume.
      if (event.persisted) lastRefresh = 0;
      revalidate();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", revalidate);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", revalidate);
    };
  }, [refreshNotes]);
}
