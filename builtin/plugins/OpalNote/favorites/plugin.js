// src/index.tsx
import { formatJournalDate } from "@app/lib/journal";
import { PluginHost } from "@app/components/PluginHost";
import { jsx } from "react/jsx-runtime";
function titleFor(ref, notes) {
  const note = notes.find((candidate) => candidate.id === ref.path);
  const title = note?.title ?? ref.title;
  return ref.path.startsWith("journals/") ? formatJournalDate(title) : title;
}
function renderFavorites(context) {
  const items = context.favorites.map((ref) => ({
    title: titleFor(ref, context.notes),
    detail: ref.path,
    action: { type: "openNote", path: ref.path }
  }));
  const plugin = {
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
            items
          }
        ]
      }
    }
  };
  return /* @__PURE__ */ jsx(
    PluginHost,
    {
      plugin,
      onAction: context.onAction,
      notebookId: context.notebookId,
      linkKeys: context.linkKeys,
      linkTargets: context.linkTargets,
      onWikiLink: context.onWikiLink,
      onTag: context.onTag
    }
  );
}
var favoritesPlugin = {
  id: "OpalNote/favorites",
  title: "Favorites",
  render: renderFavorites
};
var index_default = favoritesPlugin;
export {
  index_default as default
};
