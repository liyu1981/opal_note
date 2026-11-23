/**
 * Client-side block parser.
 *
 * The block list comes from the shared `lutez` AST (`./lutez`, the same parse the
 * server indexes), so the editor can draw handles, folding and drag targets
 * without a round-trip and still agree with `src/store/markdown.rs`. The legacy
 * line scanner at the bottom is only the fallback for the moment before the WASM
 * module is ready or if it cannot load at all.
 */

import type { BlockKind } from "./blockKind";
import { lutezContent } from "./lutez";

export type { BlockKind } from "./blockKind";

/** One-glyph marker for a block kind, used by block rows in search results. */
export const BLOCK_KIND_GLYPH: Record<BlockKind, string> = {
  heading: "H",
  paragraph: "¶",
  list_item: "•",
  task: "☐",
  code: "</>",
  quote: "❝",
  table: "▦",
  hr: "—",
  math: "∑",
  html: "◇",
};

/** Glyph for a block kind coming from the API (which types it as a string). */
export function blockGlyph(kind: string): string {
  return BLOCK_KIND_GLYPH[kind as BlockKind] ?? "¶";
}

export type NoteBlock = {
  /** 1-based position in the note. */
  seq: number;
  /** 1-based line numbers in the document, fences included. */
  startLine: number;
  endLine: number;
  kind: BlockKind;
  /** Outline nesting for list items; heading level for headings. */
  depth: number;
  /** `seq` of the enclosing list item, or 0. */
  parentSeq: number;
  text: string;
  /** FNV-1a of the normalised text, matching the server's `block_hash`. */
  hash: string;
};

const MAX_TEXT = 4_000;

/** FNV-1a 32-bit over normalised text, as 8 lowercase hex chars. */
export function blockHash(text: string): string {
  const normalised = text
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ")
    .replace(/[.,;:!?]+$/u, "");
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(normalised)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Remove a `-`/`*`/`+`/`1.`/`1)` marker and the whitespace after it. */
function stripListMarker(line: string): string | null {
  const bullet = /^[-*+]\s+(.*)$/u.exec(line);
  if (bullet) return bullet[1] ?? "";
  const ordered = /^\d+[.)]\s+(.*)$/u.exec(line);
  if (ordered) return ordered[1] ?? "";
  return null;
}

/** Drop a checkbox or Logseq keyword from a task's text. */
function stripTaskMarker(value: string): string {
  const checkbox = /^\[[ xX-]\]\s*/u.exec(value);
  if (checkbox) return value.slice(checkbox[0].length);
  const keyword = /^(?:TODO|DOING|DONE|CANCELED|CANCELLED)\s+/u.exec(value);
  if (keyword) return value.slice(keyword[0].length);
  return value;
}

function blockText(lines: string[], kind: BlockKind): string {
  const parts: string[] = [];
  for (const line of lines) {
    let value = line.trimStart();
    if (kind === "quote") {
      value = value.replace(/^>\s?/u, "");
    } else if (kind === "list_item" || kind === "task") {
      value = stripListMarker(value) ?? value;
      if (kind === "task") value = stripTaskMarker(value);
    } else if (kind === "heading") {
      value = value.replace(/^#+\s*/u, "");
    }
    parts.push(value.trimEnd());
  }
  return parts.join("\n").slice(0, MAX_TEXT);
}

/**
 * Split a note body into blocks.
 *
 * The list comes from the shared `lutez` AST — the same rows the server
 * indexes — so handles, folding and drag targets cannot disagree with the
 * index. Before the WASM module is ready (or if it failed to load) there are no
 * blocks to draw; `main.tsx` loads it before the first render.
 *
 * `body` must start at the note's first line (the editor passes the whole
 * document; frontmatter is skipped by the caller).
 */
export function parseBlocks(body: string): NoteBlock[] {
  const shared = lutezContent(body);
  if (shared === null) return [];

  const lines = body.split("\n");
  return shared.blocks.map((block, index) => {
    const { startLine, endLine, kind, depth, parentSeq } = block;
    // A thematic break carries no text, exactly like the server's rows.
    const text =
      kind === "hr"
        ? ""
        : blockText(lines.slice(startLine - 1, endLine), kind);
    return {
      seq: index + 1,
      startLine,
      endLine,
      kind,
      depth,
      parentSeq,
      text,
      hash: blockHash(text),
    };
  });
}

/**
 * The innermost block containing a 1-based line.
 *
 * Block ranges can nest (a quote inside an item, an ordered sub-list), so the
 * smallest range wins: a click or drop on a nested line must target the child,
 * not its parent.
 */
export function innermostBlockAt(
  blocks: NoteBlock[],
  line: number,
): NoteBlock | null {
  let best: NoteBlock | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const block of blocks) {
    if (line < block.startLine || line > block.endLine) continue;
    const span = block.endLine - block.startLine;
    if (span < bestSpan) {
      best = block;
      bestSpan = span;
    }
  }
  return best;
}
