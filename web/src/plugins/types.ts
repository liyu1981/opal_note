import type { ReactNode } from "react";

import type {
  NoteSummary,
  PluginAction,
} from "../api/types";
import type { LinkTarget } from "../lib/livePreview";
import type { NoteRef } from "../state/atoms";

/** Data and app actions exposed to built-in client plugins. */
export type HomePluginContext = {
  notebookId: string;
  notes: NoteSummary[];
  favorites: NoteRef[];
  /** Pages recently opened in this browser. */
  recents: NoteRef[];
  /** Pages most recently edited in the notebook. */
  recentNotes: NoteSummary[];
  linkKeys: Set<string>;
  linkTargets: LinkTarget[];
  onAction: (action: PluginAction) => void;
  onWikiLink: (target: string) => void;
  onTag: (tag: string) => void;
};

export type BuiltinClientPlugin = {
  id: string;
  title: string;
  render: (context: HomePluginContext) => ReactNode;
};
