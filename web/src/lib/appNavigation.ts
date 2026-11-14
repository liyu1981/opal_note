import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";

import { activeNotebookIdAtom } from "../state/atoms";

export type AppTarget =
  | { view: "home" }
  | { view: "journal" }
  | { view: "pages" }
  | { view: "graph" }
  | { view: "assets" }
  | { view: "asset"; path: string }
  | { view: "note"; noteId: string }
  | { view: "tag"; tag: string };

export type AppNavigateOptions = {
  replace?: boolean;
  /** Override the current notebook, e.g. immediately after switching. */
  notebookId?: string | null;
};

/**
 * Map app-level destinations to TanStack Router paths/search. Keeping this in
 * one hook prevents view components from inventing their own URL shapes.
 *
 * Notebook-scoped routes are `/<notebook>/home`, `/<notebook>/journal`,
 * `/<notebook>/pages`, `/<notebook>/graph`, `/<notebook>/tag/<tag>`, and
 * `/<notebook>/page?p=...`. The legacy unprefixed
 * routes remain as redirects/fallbacks for empty workspaces and old links.
 */
export function useAppNavigate() {
  const navigate = useNavigate();
  const activeNotebookId = useAtomValue(activeNotebookIdAtom);

  return (target: AppTarget, options?: AppNavigateOptions) => {
    const replace = options?.replace;
    const notebook =
      options?.notebookId !== undefined
        ? options.notebookId
        : activeNotebookId;

    switch (target.view) {
      case "home":
        if (notebook) {
          void navigate({
            to: "/$notebook/home",
            params: { notebook },
            replace,
          });
        } else {
          void navigate({ to: "/journal", replace });
        }
        break;
      case "journal":
        if (notebook) {
          void navigate({
            to: "/$notebook/journal",
            params: { notebook },
            replace,
          });
        } else {
          void navigate({ to: "/journal", replace });
        }
        break;
      case "pages":
        if (notebook) {
          void navigate({
            to: "/$notebook/pages",
            params: { notebook },
            replace,
          });
        } else {
          void navigate({ to: "/pages", replace });
        }
        break;
      case "graph":
        if (notebook) {
          void navigate({
            to: "/$notebook/graph",
            params: { notebook },
            replace,
          });
        } else {
          void navigate({ to: "/graph", replace });
        }
        break;
      case "assets":
        if (notebook) {
          void navigate({
            to: "/$notebook/assets",
            params: { notebook },
            replace,
          });
        } else {
          void navigate({ to: "/journal", replace });
        }
        break;
      case "asset":
        if (notebook) {
          void navigate({
            to: "/$notebook/asset/$",
            params: { notebook, _splat: target.path },
            replace,
          });
        } else {
          void navigate({ to: "/journal", replace });
        }
        break;
      case "note":
        if (notebook) {
          void navigate({
            to: "/$notebook/page",
            params: { notebook },
            search: { p: target.noteId },
            replace,
          });
        } else {
          void navigate({
            to: "/page",
            search: { p: target.noteId },
            replace,
          });
        }
        break;
      case "tag":
        if (notebook) {
          void navigate({
            to: "/$notebook/tag/$",
            params: { notebook, _splat: target.tag },
            replace,
          });
        } else {
          void navigate({ to: "/journal", replace });
        }
        break;
    }
  };
}
