import type { JournalPluginResult } from "@app/api/types";
import { formatJournalDate } from "@app/lib/journal";
import { relativeTime } from "@app/lib/format";
import { PluginHost } from "@app/components/PluginHost";
import type {
  BuiltinClientPlugin,
  HomePluginContext,
} from "@app/plugins/types";

function titleFor(
  note: HomePluginContext["notes"][number],
): string {
  return note.id.startsWith("journals/")
    ? formatJournalDate(note.title)
    : note.title;
}

function renderRecent(context: HomePluginContext) {
  const items = context.recentNotes.map((note) => ({
    title: titleFor(note),
    detail: `${relativeTime(note.updated_at)} · ${note.id}`,
    action: { type: "openNote" as const, path: note.id },
  }));
  const plugin: JournalPluginResult = {
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

const recentPlugin: BuiltinClientPlugin = {
  id: "OpalNote/recent",
  title: "Recent pages",
  render: renderRecent,
};

export default recentPlugin;
