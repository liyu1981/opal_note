import type { JournalPluginResult } from "@app/api/types";
import { formatJournalDate } from "@app/lib/journal";
import { PluginHost } from "@app/components/PluginHost";
import type {
  BuiltinClientPlugin,
  HomePluginContext,
} from "@app/plugins/types";

function titleFor(
  ref: { path: string; title: string },
  notes: HomePluginContext["notes"],
): string {
  const note = notes.find((candidate) => candidate.id === ref.path);
  const title = note?.title ?? ref.title;
  return ref.path.startsWith("journals/") ? formatJournalDate(title) : title;
}

function renderFavorites(context: HomePluginContext) {
  const items = context.favorites.map((ref) => ({
    title: titleFor(ref, context.notes),
    detail: ref.path,
    action: { type: "openNote" as const, path: ref.path },
  }));
  const plugin: JournalPluginResult = {
    id: "OpalNote/favorites",
    title: "Favorites",
    description: "Pages pinned from the editor.",
    items: [],
    ui: {
      schema: 1,
      root: {
        type: "card",
        title: "Favorites",
        children: [
          {
            type: "list",
            emptyText: "Star a page in the editor to pin it here.",
            items,
          },
        ],
      },
    },
  };
  return (
    <PluginHost
      plugin={plugin}
      onAction={context.onAction}
      notebookId={context.notebookId}
      linkKeys={context.linkKeys}
      linkTargets={context.linkTargets}
      onWikiLink={context.onWikiLink}
      onTag={context.onTag}
    />
  );
}

const favoritesPlugin: BuiltinClientPlugin = {
  id: "OpalNote/favorites",
  title: "Favorites",
  render: renderFavorites,
};

export default favoritesPlugin;
