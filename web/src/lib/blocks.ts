/**
 * Client-side block parser.
 *
 * The block list comes from the shared `lutez` AST (`./lutez`, the same parse the
 * server indexes), so the editor can draw handles, folding and drag targets
 * without a round-trip and still agree with `src/store/markdown.rs`. The legacy
 * line scanner at the bottom is only the fallback for the moment before the WASM
 * module is ready or if it cannot load at all.
 */

import { lutezContent, lutezReady } from "./lutez";
import { closesFence, fenceOpener } from "./markdown";

export type BlockKind =
  | "paragraph"
  | "heading"
  | "list_item"
  | "task"
  | "code"
  | "quote"
  | "table"
  | "hr"
  | "math"
  | "html";

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

function isDisplayMathFence(line: string): boolean {
  const rest = line.startsWith("$$") ? line.slice(2) : null;
  return rest !== null && rest.trim() === "";
}

function isThematicBreak(line: string): boolean {
  const marker = line[0];
  if (!marker || !"-*_".includes(marker)) return false;
  const compact = line.slice(1).replace(/\s+/gu, "");
  return compact.length >= 2 && [...compact].every((ch) => ch === marker);
}

function headingLevel(line: string): number | null {
  const hashes = /^#+/u.exec(line)?.[0].length ?? 0;
  if (hashes === 0 || hashes > 6) return null;
  return /\s/u.test(line[hashes] ?? "") ? hashes : null;
}

type ListMarker = { isTask: boolean };

function listMarker(line: string): ListMarker | null {
  const rest = stripListMarker(line);
  if (rest === null) return null;
  const isTask =
    /^\[[ xX-]\]/u.test(rest) || /^(?:TODO|DOING|DONE|CANCELED|CANCELLED)\s/u.test(rest);
  return { isTask };
}

function stripListMarker(line: string): string | null {
  const bullet = /^[-*+]\s+(.*)$/u.exec(line);
  if (bullet) return bullet[1] ?? "";
  const ordered = /^\d+[.)]\s+(.*)$/u.exec(line);
  if (ordered) return ordered[1] ?? "";
  return null;
}

function stripTaskMarker(value: string): string {
  const checkbox = /^\[[ xX-]\]\s*/u.exec(value);
  if (checkbox) return value.slice(checkbox[0].length);
  const keyword = /^(?:TODO|DOING|DONE|CANCELED|CANCELLED)\s+/u.exec(value);
  if (keyword) return value.slice(keyword[0].length);
  return value;
}

function indentColumns(line: string): number {
  let columns = 0;
  for (const ch of line) {
    if (ch === " ") columns += 1;
    else if (ch === "\t") columns += 4;
    else break;
  }
  return columns;
}

function startsNewBlock(line: string): boolean {
  return (
    line.startsWith(">") ||
    line.startsWith("|") ||
    line.startsWith("<!--") ||
    isDisplayMathFence(line) ||
    isThematicBreak(line) ||
    headingLevel(line) !== null ||
    listMarker(line) !== null ||
    fenceOpener(line) !== null
  );
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
 * The block list comes from the shared `lutez` AST when the parser is loaded, so
 * the editor's handles, folding and drag targets line up with the rows the
 * server indexes. The hand-written scanner below stays as the fallback for the
 * moment before the WASM module is ready (and as a safety net if it fails).
 *
 * `body` must start at the note's first line (the editor passes the whole
 * document; frontmatter is skipped by the caller or treated as a paragraph).
 */
export function parseBlocks(body: string): NoteBlock[] {
  const shared = lutezReady() ? lutezContent(body) : null;
  if (shared === null) return legacyParseBlocks(body);

  const lines = body.split("\n");
  return shared.blocks.map((block, index) => {
    const { startLine, endLine, kind, depth, parentSeq } = block;
    // A thematic break carries no text, exactly like the server's rows.
    const text =
      kind === "hr"
        ? ""
        : blockText(lines.slice(startLine - 1, endLine), kind as BlockKind);
    return {
      seq: index + 1,
      startLine,
      endLine,
      kind: kind as BlockKind,
      depth,
      parentSeq,
      text,
      hash: blockHash(text),
    };
  });
}

/** Legacy line-based scanner (see `legacyParseBlocks` in the header comment). */
function legacyParseBlocks(body: string): NoteBlock[] {
  const lines = body.split("\n");
  const blocks: NoteBlock[] = [];
  let index = 0;
  let listStack: Array<{ start: number; indent: number }> = [];

  const push = (
    start: number,
    end: number,
    kind: BlockKind,
    depth: number,
    parentSeq: number,
    text: string,
  ) => {
    blocks.push({
      seq: blocks.length + 1,
      startLine: start + 1,
      endLine: end + 1,
      kind,
      depth,
      parentSeq,
      text,
      hash: blockHash(text),
    });
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trimStart();

    if (trimmed === "") {
      index += 1;
      continue;
    }

    const fence = fenceOpener(trimmed);
    if (fence !== null) {
      let end = lines.length - 1;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        if (closesFence(lines[cursor] ?? "", fence)) {
          end = cursor;
          break;
        }
      }
      push(index, end, "code", 0, 0, blockText(lines.slice(index, end + 1), "code"));
      listStack = [];
      index = end + 1;
      continue;
    }

    if (isDisplayMathFence(trimmed)) {
      let end = lines.length - 1;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        if (isDisplayMathFence((lines[cursor] ?? "").trimStart())) {
          end = cursor;
          break;
        }
      }
      push(index, end, "math", 0, 0, blockText(lines.slice(index, end + 1), "math"));
      listStack = [];
      index = end + 1;
      continue;
    }

    if (trimmed.startsWith("|")) {
      let end = index;
      while (end + 1 < lines.length && (lines[end + 1] ?? "").trimStart().startsWith("|")) {
        end += 1;
      }
      push(index, end, "table", 0, 0, blockText(lines.slice(index, end + 1), "table"));
      listStack = [];
      index = end + 1;
      continue;
    }

    if (isThematicBreak(trimmed)) {
      push(index, index, "hr", 0, 0, "");
      listStack = [];
      index += 1;
      continue;
    }

    const level = headingLevel(trimmed);
    if (level !== null) {
      let end = index;
      while (
        end + 1 < lines.length &&
        (lines[end + 1] ?? "").trimStart() !== "" &&
        !startsNewBlock((lines[end + 1] ?? "").trimStart())
      ) {
        end += 1;
      }
      push(index, end, "heading", level, 0, blockText(lines.slice(index, end + 1), "heading"));
      listStack = [];
      index = end + 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      let end = index;
      while (end + 1 < lines.length) {
        const next = (lines[end + 1] ?? "").trimStart();
        if (next.startsWith(">")) {
          end += 1;
          continue;
        }
        if (next !== "" && !startsNewBlock(next)) {
          end += 1;
          continue;
        }
        break;
      }
      push(index, end, "quote", 0, 0, blockText(lines.slice(index, end + 1), "quote"));
      listStack = [];
      index = end + 1;
      continue;
    }

    if (trimmed.startsWith("<!--")) {
      let end = index;
      while (end + 1 < lines.length && !(lines[end] ?? "").includes("-->")) {
        end += 1;
        if ((lines[end] ?? "").includes("-->")) break;
      }
      push(index, end, "html", 0, 0, blockText(lines.slice(index, end + 1), "html"));
      listStack = [];
      index = end + 1;
      continue;
    }

    const item = listMarker(trimmed);
    if (item !== null) {
      const indent = indentColumns(line);
      let end = index;
      while (end + 1 < lines.length) {
        const next = lines[end + 1] ?? "";
        const nextTrimmed = next.trimStart();
        if (nextTrimmed === "") break;
        if (nextTrimmed.startsWith(">") || nextTrimmed.startsWith("|")) break;
        if (listMarker(nextTrimmed) !== null) break;
        if (indentColumns(next) <= indent) break;
        if (fenceOpener(nextTrimmed) !== null) break;
        end += 1;
      }
      while (listStack.length > 0 && (listStack[listStack.length - 1]?.indent ?? 0) >= indent) {
        listStack.pop();
      }
      const parentSeq = listStack[listStack.length - 1]?.start ?? 0;
      const kind: BlockKind = item.isTask ? "task" : "list_item";
      push(index, end, kind, Math.floor(indent / 2), parentSeq, blockText(lines.slice(index, end + 1), kind));
      listStack.push({ start: blocks.length, indent });
      index = end + 1;
      continue;
    }

    let end = index;
    while (end + 1 < lines.length) {
      const next = (lines[end + 1] ?? "").trimStart();
      if (next === "" || startsNewBlock(next)) break;
      end += 1;
    }
    push(index, end, "paragraph", 0, 0, blockText(lines.slice(index, end + 1), "paragraph"));
    listStack = [];
    index = end + 1;
  }

  return blocks;
}

/**
 * The innermost block containing a 1-based line.
 *
 * Block ranges can nest (an item's quote, an ordered sub-list), so the smallest
 * range wins: clicking a nested line must select the child, not its parent.
 */
export function blockAtLine(
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
