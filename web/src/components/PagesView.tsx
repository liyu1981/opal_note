import { useAtomValue } from "jotai";

import { IconFile, IconSearch } from "./Icons";
import {
  activeNotebookAtom,
  activeNotebookIdAtom,
  notesAtom,
} from "../state/atoms";

export function PagesView() {
  const notebookId = useAtomValue(activeNotebookIdAtom);
  const notebook = useAtomValue(activeNotebookAtom);
  const notes = useAtomValue(notesAtom);
  const pageCount = notes.filter((note) => note.id.startsWith("pages/")).length;

  if (!notebookId) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-canvas p-8">
        <p className="max-w-sm text-center font-mono text-[11.5px] leading-relaxed text-muted">
          Select or create a notebook to browse its pages.
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-canvas">
      <div className="mx-auto w-full max-w-4xl px-6 py-8">
        <header className="border-b border-line pb-4">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.16em] text-faint">
            Pages
          </div>
          <h1 className="mt-1 font-mono text-[26px] font-semibold tracking-tight text-ink">
            {notebook?.name ?? "Page directory"}
          </h1>
          <p className="mt-2 font-mono text-[10.5px] text-muted">
            {pageCount} {pageCount === 1 ? "page" : "pages"} in this notebook
          </p>
        </header>

        <div className="mt-10 rounded-2xl border border-dashed border-line-strong bg-white/30 px-8 py-16 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-panel text-accent">
            <IconFile className="h-5 w-5" />
          </span>
          <h2 className="mt-4 font-mono text-[15px] font-semibold text-ink">
            A dedicated page directory
          </h2>
          <p className="mx-auto mt-2 max-w-md font-mono text-[10.5px] leading-relaxed text-muted">
            This view will become the full page browser with filters, sort and
            a page-level map. For now, use the Pages section in the left sidebar
            to open a page.
          </p>
          <div className="mx-auto mt-5 flex max-w-sm items-center gap-2 rounded-lg border border-line bg-white/60 px-3 py-2 text-left">
            <IconSearch className="h-3.5 w-3.5 shrink-0 text-faint" />
            <span className="font-mono text-[10px] text-faint">
              Search pages from the sidebar to jump directly to one.
            </span>
          </div>
        </div>
      </div>
    </main>
  );
}
