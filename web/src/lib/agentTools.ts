import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentToolDescriptor } from "@liyu1981/reagent";

import { api } from "../api/client";
import { activeNotebookIdAtom } from "../state/atoms";
import { getDefaultStore } from "jotai";

/**
 * Agent tools that let the assistant read the notebook.
 *
 * They are read-only, always enabled, and run in the browser, which already
 * holds the session cookie and CSRF token, so no credential wiring is needed
 * beyond `api`. The notebook id is read from `activeNotebookIdAtom` at call
 * time, so switching notebooks needs no rebuild.
 *
 * - `search_notes`  — full-text search across titles and bodies (snippets)
 * - `list_tags`     — every tag with its page count
 * - `read_note`     — full body of a note, by path or title
 */
export const OPALNOTE_TOOL_GROUP = "content" as const;

export function createOpalNoteToolDescriptors(): AgentToolDescriptor[] {
  const notebookId = () => {
    const id = getDefaultStore().get(activeNotebookIdAtom);
    if (!id) throw new Error("no notebook is open");
    return id;
  };

  const make = <T extends object>(
    name: string,
    label: string,
    description: string,
    parameters: T,
    execute: (args: T) => Promise<string>,
  ): AgentToolDescriptor => ({
    id: name,
    name,
    label,
    description,
    group: OPALNOTE_TOOL_GROUP,
    requiresEditor: false,
    defaultEnabled: true,
    build: () => ({
      name,
      label,
      description,
      parameters,
      execute: async (_toolCallId: string, args: unknown) => ({
        content: [{ type: "text", text: await execute(args as T) }],
        details: {},
      }),
    }),
  });

  return [
    make(
      "search_notes",
      "Search notes",
      "Full-text search across the open notebook's note titles and bodies. " +
        "Returns titles, relative paths and match snippets. Use it first to find " +
        "candidate notes before reading them.",
      Type.Object({
        query: Type.String({ description: "search text" }),
        limit: Type.Optional(
          Type.Number({ description: "max results (default 15, max 50)" }),
        ),
      }),
      async (args) => {
        const { query, limit } = args as unknown as { query: string; limit?: number };
        const hits = await api.searchNotes(
          notebookId(),
          query,
          Math.min(Math.max(limit ?? 15, 1), 50),
        );
        if (hits.length === 0) return "No matching notes.";
        return hits
          .map((hit) => `• ${hit.title} (${hit.id})\n  ${hit.excerpt ?? ""}`)
          .join("\n");
      },
    ),

    make(
      "list_tags",
      "List tags",
      "Every tag in the open notebook with the number of pages that use it, " +
        "sorted by count. Use it to answer 'what do I have about X' questions.",
      Type.Object({}),
      async () => {
        const tags = await api.listTags(notebookId());
        if (tags.length === 0) return "No tags.";
        return tags.map((tag) => `${tag.tag}: ${tag.count}`).join("\n");
      },
    ),

    make(
      "read_note",
      "Read note",
      "Read the full body of one note. `path` may be a relative path " +
        "(`pages/hello.md`, `journals/2026-11-12.md`) or a title; the server " +
        "resolves it.",
      Type.Object({
        path: Type.String({ description: "note path or title" }),
      }),
      async (args) => {
        const { path } = args as unknown as { path: string };
        const note = await api.getNote(notebookId(), path);
        const header = `# ${note.title}\npath: ${note.id}\ntags: ${note.tags.join(", ") || "(none)"}`;
        return `${header}\n\n${note.content}`;
      },
    ),
  ];
}

/** Convenience for tests and for callers that want instances directly. */
export function createOpalNoteTools(): AgentTool<any>[] {
  return createOpalNoteToolDescriptors().map((descriptor) =>
    descriptor.build({}),
  );
}
