import type { TaskStatus } from "../api/types";

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
