import { useEffect, useLayoutEffect } from "react";
import {
  Navigate,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { getDefaultStore, useAtomValue, useSetAtom } from "jotai";

import { api } from "./api/client";
import { EditorPane } from "./components/EditorPane";
import { GraphView } from "./components/GraphView";
import { HomeView } from "./components/HomeView";
import { JournalFeed } from "./components/JournalFeed";
import { PagesView } from "./components/PagesView";
import { TagView } from "./components/TagView";
import { Workspace } from "./components/Workspace";
import {
  activeNoteIdAtom,
  activeNotebookIdAtom,
  graphViewAtom,
  homeViewAtom,
  journalViewAtom,
  pagesViewAtom,
} from "./state/atoms";

function useSyncView(view: "home" | "journal" | "pages" | "graph") {
  const setHome = useSetAtom(homeViewAtom);
  const setJournal = useSetAtom(journalViewAtom);
  const setPages = useSetAtom(pagesViewAtom);
  const setGraph = useSetAtom(graphViewAtom);
  const setActiveNote = useSetAtom(activeNoteIdAtom);

  useLayoutEffect(() => {
    setHome(view === "home");
    setJournal(view === "journal");
    setPages(view === "pages");
    setGraph(view === "graph");
    setActiveNote(null);
  }, [setActiveNote, setGraph, setHome, setJournal, setPages, view]);
}

function HomeRoute() {
  useSyncView("home");
  return <HomeView />;
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

function NotebookLayout() {
  return <Outlet />;
}

function TagRoute() {
  const { _splat } = useParams({ from: "/$notebook/tag/$" });
  return <TagView tag={_splat ?? ""} />;
}

function PageRoute() {
  const { p } = useSearch({ from: "/$notebook/page" });
  const { notebook } = useParams({ from: "/$notebook/page" });
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const setHome = useSetAtom(homeViewAtom);
  const setJournal = useSetAtom(journalViewAtom);
  const setPages = useSetAtom(pagesViewAtom);
  const setGraph = useSetAtom(graphViewAtom);
  const setActiveNote = useSetAtom(activeNoteIdAtom);
  const navigate = useNavigate();
  const param = p?.trim() ?? "";
  const isPath = param.includes("/") || param.endsWith(".md");

  useLayoutEffect(() => {
    setHome(false);
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
    setHome,
    setJournal,
    setPages,
  ]);

  useEffect(() => {
    if (!param) {
      void navigate({
        to: "/$notebook/journal",
        params: { notebook },
        replace: true,
      });
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
          to: "/$notebook/page",
          params: { notebook },
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
  }, [isPath, navigate, notebook, notebookId, param, setActiveNote]);

  return <EditorPane />;
}

function NotFound() {
  return <Navigate to="/" replace />;
}

async function pickNotebook() {
  const notebooks = await api.listNotebooks();
  const stored = getDefaultStore().get(activeNotebookIdAtom);
  return notebooks.find((notebook) => notebook.id === stored) ?? notebooks[0];
}

const rootRoute = createRootRoute({
  component: Workspace,
  notFoundComponent: NotFound,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async () => {
    const notebook = await pickNotebook();
    if (notebook) {
      throw redirect({
        to: "/$notebook/home",
        params: { notebook: notebook.id },
        replace: true,
      });
    }
    throw redirect({ to: "/journal", replace: true });
  },
});

const notebookRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$notebook",
  beforeLoad: async ({ params }) => {
    const notebooks = await api.listNotebooks();
    const notebook = notebooks.find(
      (item) => item.id === params.notebook || item.name === params.notebook,
    );
    if (!notebook) {
      throw redirect({ to: "/", replace: true });
    }
    getDefaultStore().set(activeNotebookIdAtom, notebook.id);
  },
  component: NotebookLayout,
});

const homeRoute = createRoute({
  getParentRoute: () => notebookRoute,
  path: "home",
  component: HomeRoute,
});

const journalRoute = createRoute({
  getParentRoute: () => notebookRoute,
  path: "journal",
  component: JournalRoute,
});

const pagesRoute = createRoute({
  getParentRoute: () => notebookRoute,
  path: "pages",
  component: PagesRoute,
});

const graphRoute = createRoute({
  getParentRoute: () => notebookRoute,
  path: "graph",
  component: GraphRoute,
});

const tagRoute = createRoute({
  getParentRoute: () => notebookRoute,
  path: "tag/$",
  component: TagRoute,
});

const pageRoute = createRoute({
  getParentRoute: () => notebookRoute,
  path: "page",
  validateSearch: (
    search: Record<string, unknown>,
  ): { p?: string } => ({
    p: typeof search.p === "string" ? search.p : undefined,
  }),
  component: PageRoute,
});

const legacyJournalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/journal",
  beforeLoad: async () => {
    const notebook = await pickNotebook();
    if (notebook) {
      throw redirect({
        to: "/$notebook/journal",
        params: { notebook: notebook.id },
        replace: true,
      });
    }
  },
  component: JournalRoute,
});

const legacyPagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pages",
  beforeLoad: async () => {
    const notebook = await pickNotebook();
    if (notebook) {
      throw redirect({
        to: "/$notebook/pages",
        params: { notebook: notebook.id },
        replace: true,
      });
    }
    throw redirect({ to: "/journal", replace: true });
  },
});

const legacyGraphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/graph",
  beforeLoad: async () => {
    const notebook = await pickNotebook();
    if (notebook) {
      throw redirect({
        to: "/$notebook/graph",
        params: { notebook: notebook.id },
        replace: true,
      });
    }
    throw redirect({ to: "/journal", replace: true });
  },
});

const legacyPageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/page",
  validateSearch: (
    search: Record<string, unknown>,
  ): { p?: string } => ({
    p: typeof search.p === "string" ? search.p : undefined,
  }),
  beforeLoad: async ({ search }) => {
    const notebook = await pickNotebook();
    if (!notebook) {
      throw redirect({ to: "/journal", replace: true });
    }
    throw redirect({
      to: "/$notebook/page",
      params: { notebook: notebook.id },
      search: { p: search.p },
      replace: true,
    });
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  notebookRoute.addChildren([
    homeRoute,
    journalRoute,
    pagesRoute,
    graphRoute,
    tagRoute,
    pageRoute,
  ]),
  legacyJournalRoute,
  legacyPagesRoute,
  legacyGraphRoute,
  legacyPageRoute,
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
