import { useEffect, useLayoutEffect } from "react";
import {
  Navigate,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";

import { api } from "./api/client";
import { EditorPane } from "./components/EditorPane";
import { GraphView } from "./components/GraphView";
import { JournalFeed } from "./components/JournalFeed";
import { PagesView } from "./components/PagesView";
import { Workspace } from "./components/Workspace";
import {
  activeNoteIdAtom,
  activeNotebookIdAtom,
  graphViewAtom,
  journalViewAtom,
  pagesViewAtom,
} from "./state/atoms";

function useSyncView(view: "journal" | "pages" | "graph") {
  const setJournal = useSetAtom(journalViewAtom);
  const setPages = useSetAtom(pagesViewAtom);
  const setGraph = useSetAtom(graphViewAtom);
  const setActiveNote = useSetAtom(activeNoteIdAtom);

  useLayoutEffect(() => {
    setJournal(view === "journal");
    setPages(view === "pages");
    setGraph(view === "graph");
    setActiveNote(null);
  }, [setActiveNote, setGraph, setJournal, setPages, view]);
}

function JournalRoute() {
  useSyncView("journal");
  return <JournalFeed />;
}

function PagesRoute() {
  useSyncView("pages");
  return <PagesView />;
}

function GraphRoute() {
  useSyncView("graph");
  return <GraphView />;
}

function PageRoute() {
  const { p } = useSearch({ from: "/page" });
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const setJournal = useSetAtom(journalViewAtom);
  const setPages = useSetAtom(pagesViewAtom);
  const setGraph = useSetAtom(graphViewAtom);
  const setActiveNote = useSetAtom(activeNoteIdAtom);
  const navigate = useNavigate();
  const param = p?.trim() ?? "";
  const isPath =
    param.includes("/") || param.endsWith(".md");

  useLayoutEffect(() => {
    setJournal(false);
    setPages(false);
    setGraph(false);
    if (param) {
      if (isPath) setActiveNote(param);
      else setActiveNote(null);
    } else {
      setActiveNote(null);
    }
  }, [
    isPath,
    param,
    setActiveNote,
    setGraph,
    setJournal,
    setPages,
  ]);

  useEffect(() => {
    if (!param) {
      void navigate({ to: "/journal", replace: true });
      return;
    }
    if (isPath || !notebookId) {
      setActiveNote(param);
      return;
    }

    let cancelled = false;
    api
      .listNotes(notebookId, 200)
      .then((notes) => {
        if (cancelled) return;
        const needle = param.toLowerCase();
        const hit =
          notes.find((note) => note.title === param) ??
          notes.find((note) => note.title.toLowerCase() === needle);
        if (!hit) {
          setActiveNote(null);
          return;
        }
        setActiveNote(hit.id);
        void navigate({
          to: "/page",
          search: { p: hit.id },
          replace: true,
        });
      })
      .catch(() => {
        if (!cancelled) setActiveNote(null);
      });

    return () => {
      cancelled = true;
    };
  }, [isPath, navigate, notebookId, param, setActiveNote]);

  return <EditorPane />;
}

function NotFound() {
  return <Navigate to="/journal" replace />;
}

const rootRoute = createRootRoute({
  component: Workspace,
  notFoundComponent: NotFound,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/journal", replace: true });
  },
});

const journalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/journal",
  component: JournalRoute,
});

const pagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pages",
  component: PagesRoute,
});

const graphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/graph",
  component: GraphRoute,
});

const pageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/page",
  validateSearch: (
    search: Record<string, unknown>,
  ): { p?: string } => ({
    p: typeof search.p === "string" ? search.p : undefined,
  }),
  component: PageRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  journalRoute,
  pagesRoute,
  graphRoute,
  pageRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
