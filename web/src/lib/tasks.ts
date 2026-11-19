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

/**
 * Every task the server would derive from `content`, as `status|text` lines.
 *
 * Mirrors `extract_tasks` in `src/store/markdown.rs` (fenced code skipped, any
 * whitespace run after a `-`/`*`/`+` bullet, `[ ]`/`[x]`/`[-]` checkboxes and
 * the Logseq `TODO`/`DOING`/`DONE`/`CANCELED` keywords). Two versions of a note with the
 * same signature produce the same rows, so an editor can tell a body edit that
 * touched tasks from one that did not.
 */
/** The fence a line opens with (```` ``` ```` or `~~~`), bullet prefix allowed. */
function fenceOpener(line: string): "```" | "~~~" | null {
  const candidate = /^[-*+]\s+/.test(line) ? line.replace(/^[-*+]\s+/, "") : line;
  if (candidate.startsWith("```")) return "```";
  if (candidate.startsWith("~~~")) return "~~~";
  return null;
}

export function taskSignature(content: string): string {
  const rows: string[] = [];
  let fence: "```" | "~~~" | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trimStart();
    if (fence) {
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }
    // A fence may be written as a list child (`- ``` … ``` `), which the editor
    // renders as code; missing that made the closing fence open a block here.
    const fenceLine = fenceOpener(trimmed);
    if (fenceLine !== null) {
      fence = fenceLine;
      continue;
    }

    // Any whitespace run after the bullet counts, like the editor's rendering.
    const rest = /^[-*+]\s+(.*)$/u.exec(trimmed)?.[1];
    if (rest === undefined) continue;

    const keyword = (name: string, status: string): string | null => {
      if (!rest.startsWith(name)) return null;
      const after = rest.slice(name.length);
      if (after !== "" && !/^\s/u.test(after)) return null;
      return `${status}|${after.trim()}`;
    };

    let row: string | null = null;
    if (rest.startsWith("[ ]")) row = `open|${rest.slice(3).trim()}`;
    else if (rest.startsWith("[x]") || rest.startsWith("[X]")) {
      row = `done|${rest.slice(3).trim()}`;
    } else if (rest.startsWith("[-]")) row = `cancelled|${rest.slice(3).trim()}`;
    else {
      row =
        keyword("TODO", "open") ??
        keyword("DOING", "doing") ??
        keyword("DONE", "done") ??
        keyword("CANCELED", "cancelled") ??
        keyword("CANCELLED", "cancelled");
    }
    if (row === null) continue;
    const [, text] = row.split("|", 2);
    if ((text ?? "").trim() !== "") rows.push(row);
  }

  return rows.join("\n");
}
