import { ApiError, api } from "../api/client";
import type { Note } from "../api/types";

export function todayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function ordinal(day: number): string {
  if (day >= 11 && day <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/** `2026-11-12` → `Nov 12th, 2026`; non-date titles pass through. */
export function formatJournalDate(title: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(title);
  if (!match) return title;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (month < 0 || month > 11 || day < 1 || day > 31) return title;
  return `${MONTHS[month]} ${ordinal(day)}, ${year}`;
}

/** Open today's journal page, creating it if the file does not exist yet. */
export async function ensureJournalPage(
  notebookId: string,
  date = todayKey(),
): Promise<{ note: Note; created: boolean }> {
  const path = `journals/${date}.md`;
  try {
    return { note: await api.getNote(notebookId, path), created: false };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  return {
    note: await api.createNote(notebookId, {
      title: date,
      content: "",
      section: "journals",
    }),
    created: true,
  };
}

export async function ensureJournal(
  notebookId: string,
  date = todayKey(),
): Promise<Note> {
  return (await ensureJournalPage(notebookId, date)).note;
}
