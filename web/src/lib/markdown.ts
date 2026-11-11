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
