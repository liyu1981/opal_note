/**
 * Rewrite `[[target]]` / `[[target|label]]` into private links that the
 * markdown renderer can hand back to the app. Fenced code blocks are skipped
 * so examples do not turn into navigation.
 */
export function withWikilinks(source: string): string {
  let inFence = false;
  return source
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;

      return line.replace(
        /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/gu,
        (_match, rawTarget: string, label?: string) => {
          const target = rawTarget.split("#")[0]?.trim() ?? "";
          if (!target) return _match;
          const text = (label ?? rawTarget).trim();
          return `[${text}](#wiki/${encodeURIComponent(target)})`;
        },
      );
    })
    .join("\n");
}

/** Extract the target from a `#wiki/...` href produced above. */
export function wikiTarget(href: string): string | null {
  if (!href.startsWith("#wiki/")) return null;
  try {
    return decodeURIComponent(href.slice("#wiki/".length));
  } catch {
    return null;
  }
}
