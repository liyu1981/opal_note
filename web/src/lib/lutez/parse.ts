/**
 * Adapter from the shared `lutez` AST to the client's derived rows.
 *
 * This mirrors `mod lutez_ast` in `src/store/markdown.rs` rule for rule: the
 * editor draws block handles from the same block list the server indexes, so a
 * difference here changes what a note's blocks *are* on one side only. When you
 * change one adapter, change the other and re-run the corpus harness
 * (`cargo test corpus_parity -- --ignored --nocapture`).
 */
import type { BlockKind } from "../blockKind";
import { headingLevel } from "../markdown";
import { decodeAst, EXT_KIND, NODE, NULL_NODE, walkAst, type WireNode } from "./wire";


/** One block, in 1-based source lines; `text` is filled by `blocks.ts`. */
export type AstBlock = {
  startLine: number;
  endLine: number;
  kind: BlockKind;
  /** Outline nesting for list items; heading level for headings. */
  depth: number;
  /** 1-based `seq` of the enclosing list item, or 0. */
  parentSeq: number;
};

export type AstTask = {
  /** 1-based line number in the note body. */
  line: number;
  text: string;
  status: "open" | "doing" | "done" | "cancelled";
};

export type AstContent = { blocks: AstBlock[]; tasks: AstTask[] };

/**
 * First byte offset of each line, so a raw byte offset from the AST maps to a
 * 1-based line without going through UTF-16. The AST speaks bytes; block text
 * is sliced from the string by line number, so no offset conversion is needed.
 */
function byteLineStarts(bytes: Uint8Array): number[] {
  const starts = [0];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 10) starts.push(index + 1);
  }
  return starts;
}

class Reader {
  readonly lines: string[];
  /** First byte offset of each line. */
  private readonly lineStarts: number[];

  constructor(body: string) {
    this.lines = body.split("\n");
    this.lineStarts = byteLineStarts(new TextEncoder().encode(body));
  }

  /** 1-based line number of a raw byte offset. */
  lineOf(offset: number): number {
    const value = Math.max(0, offset);
    let low = 0;
    let high = this.lineStarts.length - 1;
    let line = 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (this.lineStarts[middle]! <= value) {
        line = middle + 1;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return line;
  }

  /** 1-based line the node's last source byte sits on. */
  endLine(node: WireNode): number {
    return node.rawEnd > node.rawStart
      ? this.lineOf(node.rawEnd - 1)
      : this.lineOf(node.rawStart);
  }

  lineText(line: number): string {
    return this.lines[line - 1] ?? "";
  }
}

/** Derive blocks and tasks from a note body. `null` when the body has no AST. */
export function parseAstContent(astBytes: Uint8Array, body: string): AstContent | null {
  const nodes = decodeAst(astBytes);
  if (!nodes) return null;
  const reader = new Reader(body);
  const blocks: AstBlock[] = [];
  const tasks: AstTask[] = [];

  const pushBlock = (
    start: number,
    end: number,
    kind: BlockKind,
    depth: number,
    parentSeq: number,
  ): number => {
    const last = Math.max(1, reader.lines.length);
    const startLine = Math.min(Math.max(1, start), last);
    const endLine = Math.min(Math.max(startLine, end), last);
    blocks.push({ startLine, endLine, kind, depth, parentSeq });
    return blocks.length;
  };

  const pushLeaf = (node: WireNode) => {
    const start = reader.lineOf(node.rawStart);
    const end = reader.endLine(node);
    switch (node.kind) {
      case NODE.paragraph:
      case NODE.linkRefDefBlock:
        pushBlock(start, end, "paragraph", 0, 0);
        return;
      case NODE.heading:
        // The AST already decided this line is a heading; the level is the
        // number of `#` marks.
        pushBlock(start, end, "heading", headingLevel(reader.lineText(start)) ?? 1, 0);
        return;
      case NODE.codeBlock:
        pushBlock(start, end, "code", 0, 0);
        return;
      case NODE.blockquote:
        pushBlock(start, end, "quote", 0, 0);
        return;
      case NODE.table:
        pushBlock(start, end, "table", 0, 0);
        return;
      case NODE.thematicBreak:
        pushBlock(start, end, "hr", 0, 0);
        return;
      case NODE.htmlBlock:
        pushBlock(start, end, "html", 0, 0);
        return;
      case NODE.blockExtension:
        if (node.extKind === EXT_KIND.math) pushBlock(start, end, "math", 0, 0);
        return;
      default:
    }
  };

  const hoistChild = (node: WireNode, itemLine: number) => {
    const start = reader.lineOf(node.rawStart);
    const end = reader.endLine(node);
    if (node.kind === NODE.blockquote) {
      if (start > itemLine) {
        pushLeaf(node);
      } else if (end > itemLine) {
        // `- > quote` plus continuation lines: the marker line belongs to the
        // item, the rest is the quote block.
        pushBlock(itemLine + 1, end, "quote", 0, 0);
      }
      return;
    }
    // Only block-level containers are hoisted; a paragraph (or a nested list)
    // stays part of the item's own content.
    if (
      node.kind === NODE.codeBlock ||
      node.kind === NODE.table ||
      node.kind === NODE.heading ||
      node.kind === NODE.htmlBlock ||
      node.kind === NODE.thematicBreak ||
      node.kind === NODE.blockExtension
    ) {
      if (start > itemLine) pushLeaf(node);
    }
  };

  const pushItem = (node: WireNode, depth: number, parentSeq: number): number => {
    const start = reader.lineOf(node.rawStart);
    const first = nodes[node.firstChild];
    const firstKind = first?.kind;

    // A fence written as the item's content (`- ```js`) is a code block covering
    // the item, as the editor renders it.
    if (firstKind === NODE.codeBlock) {
      return pushBlock(start, reader.endLine(node), "code", 0, 0);
    }

    let end = start;
    if (firstKind === NODE.paragraph) {
      end = first ? reader.endLine(first) : start;
    } else if (firstKind === NODE.blockquote) {
      // Hoisted below; the item keeps its marker line.
      end = start;
    } else if (first && reader.lineOf(first.rawStart) === start) {
      end = reader.endLine(first);
    }

    const task = taskRow(reader.lineText(start));
    const seq = pushBlock(start, end, task ? "task" : "list_item", depth, parentSeq);
    if (task) tasks.push({ line: start, text: task.text, status: task.status });
    return seq;
  };

  const walk = (index: number, depth: number, parentSeq: number) => {
    const node = nodes[index];
    if (!node) return;
    if (node.kind === NODE.document || node.kind === NODE.list) {
      let child = node.firstChild;
      let guard = 0;
      while (child !== NULL_NODE && child < nodes.length && guard < nodes.length) {
        walk(child, depth, parentSeq);
        child = nodes[child]?.next ?? NULL_NODE;
        guard += 1;
      }
      return;
    }
    if (node.kind === NODE.listItem) {
      const itemLine = reader.lineOf(node.rawStart);
      const seq = pushItem(node, depth, parentSeq);
      let child = node.firstChild;
      let guard = 0;
      while (child !== NULL_NODE && child < nodes.length && guard < nodes.length) {
        const nested = nodes[child]!;
        if (nested.kind === NODE.list) walk(child, depth + 1, seq);
        else hoistChild(nested, itemLine);
        child = nested.next;
        guard += 1;
      }
      return;
    }
    pushLeaf(node);
  };

  walk(0, 0, 0);
  // Tags/links are read from the same AST by `tags.ts`/`links.ts` callers when
  // needed; this function only derives what the editor draws.
  return { blocks, tasks };
}

const BULLET = /^[-*+]\s+(.*)$/u;

/**
 * A task on a list item's own line: GFM checkbox or Logseq keyword, mirroring
 * `extract_tasks`/`task_row`. The AST says which lines are list items; the line
 * says which of them the editor renders as a task.
 */
function taskRow(
  line: string,
): { status: AstTask["status"]; text: string } | null {
  const trimmed = line.trimStart();
  const rest = BULLET.exec(trimmed)?.[1];
  if (rest === undefined) return null;

  let status: AstTask["status"] | null = null;
  let text = "";
  if (rest.startsWith("[ ]")) {
    status = "open";
    text = rest.slice(3);
  } else if (rest.startsWith("[x]") || rest.startsWith("[X]")) {
    status = "done";
    text = rest.slice(3);
  } else if (rest.startsWith("[-]")) {
    status = "cancelled";
    text = rest.slice(3);
  } else {
    for (const [keyword, mapped] of [
      ["TODO", "open"],
      ["DOING", "doing"],
      ["DONE", "done"],
      ["CANCELED", "cancelled"],
      ["CANCELLED", "cancelled"],
    ] as const) {
      if (!rest.startsWith(keyword)) continue;
      const after = rest.slice(keyword.length);
      if (after !== "" && !/^\s/u.test(after)) continue;
      status = mapped;
      text = after;
      break;
    }
  }
  if (status === null) return null;
  const cleaned = text.trim();
  if (cleaned === "") return null;
  return { status, text: cleaned };
}

/**
 * Inline `#tags` from the AST, deduplicated in document order.
 *
 * Kept beside the block adapter so the client never re-scans markdown with a
 * regex the server does not share.
 */
export function astTags(astBytes: Uint8Array): string[] {
  const nodes = decodeAst(astBytes);
  if (!nodes) return [];
  const tags: string[] = [];
  walkAst(nodes, (node) => {
    if (node.kind !== NODE.inlineExtension || node.extKind !== EXT_KIND.tag) return;
    const tag = normalizeTag(node.token);
    if (tag && !tags.includes(tag)) tags.push(tag);
  });
  return tags;
}

/** Raw `[[wikilink]]` payloads in document order (`Target|Alias`, `Page#H`). */
export function astWikilinks(astBytes: Uint8Array): string[] {
  const nodes = decodeAst(astBytes);
  if (!nodes) return [];
  const links: string[] = [];
  walkAst(nodes, (node) => {
    if (node.kind !== NODE.inlineExtension || node.extKind !== EXT_KIND.wikilink) return;
    if (node.token.includes("[") || node.token.includes("]")) return;
    if (!links.includes(node.token)) links.push(node.token);
  });
  return links;
}

/** Normalize a tag the same way `normalize_tag` does on the server. */
function normalizeTag(raw: string): string | null {
  const tag = raw
    .trim()
    .replace(/^#+/u, "")
    .trim()
    .replace(/[^\p{L}\p{N}_\-/.]/gu, "")
    .replace(/^[./]+|[./]+$/gu, "")
    .toLowerCase();
  return tag === "" || [...tag].length > 64 ? null : tag;
}
