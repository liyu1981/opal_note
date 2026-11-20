/** Lowercase and collapse whitespace, matching the server's title keys. */
export function normalizeTitle(title: string): string {
  return title.split(/\s+/u).filter(Boolean).join(" ").toLowerCase();
}

/**
 * Normalize a wikilink target (title or path) the same way the server does.
 * Legacy Logseq folder names fold onto the canonical lowercase layout.
 */
export function normalizeLinkTarget(target: string): string {
  let text = target.trim();
  while (text.startsWith("./")) text = text.slice(2);
  text = text.replace(/^\/+/u, "").toLowerCase();
  if (text.endsWith(".md")) text = text.slice(0, -3);

  if (text.startsWith("journal/")) {
    text = `journals/${text.slice("journal/".length)}`;
  } else if (text.startsWith("journals/")) {
    text = `journals/${text.slice("journals/".length)}`;
  } else if (text.startsWith("pages/")) {
    text = `pages/${text.slice("pages/".length)}`;
  }

  return text.split(/\s+/u).filter(Boolean).join(" ");
}

/** All keys a note can be discovered by: title and path (without `.md`). */
export function noteLinkKeys(title: string, path: string): string[] {
  const keys: string[] = [];
  const titleKey = normalizeTitle(title);
  if (titleKey) keys.push(titleKey);
  const pathKey = normalizeLinkTarget(path);
  if (pathKey && !keys.includes(pathKey)) keys.push(pathKey);
  return keys;
}

/** Split `Target|Label` / `Target#Heading` wikilink inner text. */
export function splitWikilink(inner: string): {
  target: string;
  label: string;
} {
  const [targetPart, alias] = inner.split("|", 2);
  const raw = targetPart ?? "";
  const target = raw.split("#")[0]?.trim() ?? "";
  const label = (alias ?? raw).trim() || target;
  return { target, label };
}


/** Only open explicit safe schemes or same-origin URLs. */
export function safeExternalUrl(raw: string): string | null {
  const value = raw.trim().replace(/^<|>$/gu, "");
  if (!value) return null;
  try {
    const resolved = new URL(value, window.location.origin);
    if (
      resolved.protocol === "http:" ||
      resolved.protocol === "https:" ||
      resolved.protocol === "mailto:"
    ) {
      return resolved.href;
    }
    return null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- fences -- */

export type Fence = "```" | "~~~";

/**
 * The fence a line opens with, allowing a list-marker prefix because Logseq
 * writes fences as list children (`  - ```js`, `1. ```js`). Mirrors
 * `fence_marker` in `src/store/markdown.rs`: a fence may *open* after a list
 * marker, but only a bare fence closes it — otherwise the closing fence would
 * open a block and swallow the rest of the note.
 */
export function fenceOpener(line: string): Fence | null {
  const candidate = line
    .trimStart()
    .replace(/^(?:[-*+]|\d+[.)])\s+/u, "");
  if (candidate.startsWith("```")) return "```";
  if (candidate.startsWith("~~~")) return "~~~";
  return null;
}

/** True when a line closes `fence` (a bare fence, list markers not allowed). */
export function closesFence(line: string, fence: Fence): boolean {
  return line.trimStart().startsWith(fence);
}

/**
 * Which lines sit inside a fenced block, fence lines included. Every consumer
 * that has to ignore code (tags, tasks, blocks) uses this so the bullet-fence
 * rule cannot drift between them.
 */
export function fencedLines(lines: string[]): boolean[] {
  const mask = lines.map(() => false);
  let fence: Fence | null = null;
  lines.forEach((line, index) => {
    if (fence !== null) {
      mask[index] = true;
      if (closesFence(line, fence)) fence = null;
      return;
    }
    const opener = fenceOpener(line);
    if (opener === null) return;
    fence = opener;
    mask[index] = true;
  });
  return mask;
}
