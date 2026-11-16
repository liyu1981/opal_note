// src/index.tsx
import { formatJournalDate } from "@app/lib/journal";
import { relativeTime } from "@app/lib/format";
import { PluginHost } from "@app/components/PluginHost";
import { jsx } from "react/jsx-runtime";
function titleFor(note) {
  return note.id.startsWith("journals/") ? formatJournalDate(note.title) : note.title;
}
function renderRecent(context) {
  const items = context.recentNotes.map((note) => ({
    title: titleFor(note),
    detail: `${relativeTime(note.updated_at)} \xB7 ${note.id}`,
    action: { type: "openNote", path: note.id }
  }));
  const plugin = {
    id: "OpalNote/recent",
    title: "Recent pages",
    description: "Recently updated pages in this notebook.",
    items: [],
    ui: {
      schema: 1,
      root: {
        type: "card",
        title: "Recent pages",
        children: [
          {
            type: "list",
            emptyText: "No recent pages yet.",
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
var recentPlugin = {
  id: "OpalNote/recent",
  title: "Recent pages",
  render: renderRecent
};
var index_default = recentPlugin;
export {
  index_default as default
};
