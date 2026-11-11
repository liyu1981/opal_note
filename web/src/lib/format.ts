const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** Render an ISO timestamp as "3 minutes ago" / "just now". */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const seconds = Math.round((then - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 45) return "just now";
  if (absolute < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (absolute < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  if (absolute < 2_592_000) return relative.format(Math.round(seconds / 86_400), "day");
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function fullTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function wordCount(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/u).length;
}

export function parseTags(input: string): string[] {
  return input
    .split(/[,\n]/u)
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter(Boolean);
}

export function tagList(tags: string[]): string {
  return tags.join(", ");
}
