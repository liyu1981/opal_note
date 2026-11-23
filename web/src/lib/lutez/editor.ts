/**
 * The AST the editor renders from.
 *
 * `livePreview` keeps the CodeMirror document as the source of truth, but the
 * *structure* (where a fenced block starts and ends, which lines are a display
 * formula) comes from the shared parse — the same AST `blocks.ts` and the index
 * use. One parse per doc-changing transaction, cached in a state field.
 *
 * `null` while the WASM parser is unavailable: callers then fall back to the
 * line scanners that `doc/lutez-parser.md` (P4) retires.
 */
import { StateField } from "@codemirror/state";

import { lutezDocument, lutezReady } from "./index";
import type { AstDocument } from "./parse";
import { span16 } from "./spans";
import { EXT_KIND, NODE, type WireNode } from "./wire";

/** Wide enough for any sensible indentation, matching `columnsOf` in the editor. */
const MAX_COLUMNS = 40;

export const noteAstField = StateField.define<AstDocument | null>({
  create: (state) => parseDocument(state.doc.toString()),
  update: (value, transaction) =>
    transaction.docChanged
      ? parseDocument(transaction.state.doc.toString())
      : value,
});

function parseDocument(body: string): AstDocument | null {
  return lutezReady() ? lutezDocument(body) : null;
}

/** A fenced block, in 1-based lines, as the editor styles it. */
export type AstCodeBlock = {
  start: number;
  end: number;
  /** Fence character, so a closing fence only matches its own kind. */
  char: "`" | "~";
  /** Columns between the line start and the fence (bullet markers included). */
  indent: number;
};

/** A display-math block (`$$` fences), in 1-based lines. */
export type AstMathBlock = { start: number; end: number; source: string };

/** 1-based line lookup over the normalized document text. */
function lineMap(text: string): {
  starts: number[];
  lineAt(offset: number): number;
} {
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    let found = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (starts[middle]! <= offset) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found + 1;
  };
  return { starts, lineAt };
}

/** Tab-aware column width, capped like the editor's `columnsOf`. */
function columns(text: string): number {
  let width = 0;
  for (const character of text) {
    width += character === "\t" ? 4 : 1;
    if (width >= MAX_COLUMNS) break;
  }
  return Math.min(width, MAX_COLUMNS);
}

/** Every fenced block, in document order. Indented code stays plain prose. */
export function astCodeBlocks(document: AstDocument): AstCodeBlock[] {
  const { starts, lineAt } = lineMap(document.text);
  const blocks: AstCodeBlock[] = [];
  for (const node of document.nodes) {
    if (node.kind !== NODE.codeBlock) continue;
    const [from, to] = span16(node, document.mapper);
    const fence = document.text.slice(from, from + 3);
    if (!fence.startsWith("```") && !fence.startsWith("~~~")) continue;
    const start = lineAt(from);
    blocks.push({
      start,
      end: to > from ? lineAt(to - 1) : start,
      char: fence.startsWith("~~~") ? "~" : "`",
      indent: columns(document.text.slice(starts[start - 1] ?? 0, from)),
    });
  }
  return blocks;
}

/** Inline nodes that fit on one line, bucketed by their 1-based line. */
export function astInlineNodes(document: AstDocument): Map<number, WireNode[]> {
  const { lineAt } = lineMap(document.text);
  const byLine = new Map<number, WireNode[]>();
  const inline = new Set<number>([
    NODE.emphasis,
    NODE.strong,
    NODE.strikethrough,
    NODE.codeSpan,
    NODE.link,
    NODE.image,
    NODE.inlineExtension,
  ]);
  for (const node of document.nodes) {
    if (!inline.has(node.kind)) continue;
    const [from, to] = span16(node, document.mapper);
    if (to <= from) continue;
    const start = lineAt(from);
    // A construct that wraps a line break renders as source, exactly like the
    // per-line scanners it replaces.
    if (lineAt(to - 1) !== start) continue;
    const bucket = byLine.get(start);
    if (bucket === undefined) byLine.set(start, [node]);
    else bucket.push(node);
  }
  return byLine;
}

/** Every `$$` display block, in document order, with its payload. */
export function astMathBlocks(document: AstDocument): AstMathBlock[] {
  const { lineAt } = lineMap(document.text);
  const blocks: AstMathBlock[] = [];
  for (const node of document.nodes) {
    if (node.kind !== NODE.blockExtension || node.extKind !== EXT_KIND.math) {
      continue;
    }
    // The payload excludes the fences; trim each line like the old scanner did
    // so the rendered formula is unchanged.
    const source = node.token
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");
    if (!source) continue;
    const [from, to] = span16(node, document.mapper);
    const start = lineAt(from);
    blocks.push({ start, end: to > from ? lineAt(to - 1) : start, source });
  }
  return blocks;
}
