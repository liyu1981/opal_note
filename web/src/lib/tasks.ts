import type { TaskStatus } from "../api/types";

import { lutezContent } from "./lutez";

/** Status order used by filters, sorting and the status badges. */
export const TASK_STATUSES: TaskStatus[] = [
  "open",
  "doing",
  "done",
  "cancelled",
];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === "string" &&
    (TASK_STATUSES as readonly string[]).includes(value)
  );
}

export function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "open":
      return "Open";
    case "doing":
      return "Doing";
    case "done":
      return "Done";
    case "cancelled":
      return "Cancelled";
  }
}

/**
 * Task rows keep the raw markdown source. Strip the markup that would read as
 * noise in the todo list while leaving ordinary words untouched.
 */
export function cleanTaskText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^\]]+)\]\]/gu, "$1")
    .replace(/[`*]/gu, "")
    .replace(/^[#>\-*+\s]+/u, "")
    .trim();
}

/**
 * Every task the server would derive from `content`, as `status|text` lines.
 *
 * Derived from the shared `lutez` AST: only `-`/`*`/`+` list items count, with
 * `[ ]`/`[x]`/`[-]` checkboxes and the Logseq `TODO`/`DOING`/`DONE`/`CANCELED`
 * keywords read from the item's own line — the same rows `extract_tasks` writes
 * on the server. Two versions of a note with the same signature produce the same
 * rows, so an editor can tell a body edit that touched tasks from one that did
 * not. Before the parser is ready there is nothing to compare: an empty
 * signature keeps saves quiet until it loads.
 */
export function taskSignature(content: string): string {
  const shared = lutezContent(content);
  if (shared === null) return "";
  return shared.tasks.map((task) => `${task.status}|${task.text}`).join("\n");
}
