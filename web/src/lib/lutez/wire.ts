/**
 * Reader for lutez's serialized AST (wire format 2, `doc/WIRE_FORMAT.md` in the
 * vendored submodule).
 *
 * Layout: a 40-byte header, a node array (`node_count × node_stride`, 56 bytes
 * in v2), then `extras`, `input`, `pool` and `source map` sections, each padded
 * to 8 bytes. Tokens live in the pool; spans are half-open **raw byte offsets**
 * into the original markdown.
 *
 * This mirrors `src/store/lutez.rs`: the two decoders must accept and reject the
 * same bytes, so a note cannot parse differently in the editor and the index.
 */

const HEADER_LEN = 40;
const NODE_STRIDE_MIN = 56;
/** Wire sentinel for an absent parent/child/sibling/token/ext blob. */
export const NULL_NODE = 0xffffffff;

/** Node types (`include/lutez.h` / `doc/AST_SCHEMA.md`). */
export const NODE = {
  document: 0,
  paragraph: 1,
  heading: 2,
  thematicBreak: 4,
  blockquote: 5,
  list: 7,
  listItem: 8,
  htmlBlock: 9,
  codeBlock: 11,
  linkRefDefBlock: 45,
  taskListItemMarker: 100,
  table: 106,
  blockExtension: 500,
  inlineExtension: 501,
} as const;

/** Extension kinds carried in a 500/501 node's ext blob. */
export const EXT_KIND = {
  math: 1,
  wikilink: 2,
  tag: 3,
  frontmatter: 4,
  logseqProperty: 5,
  obsidianBlockId: 6,
  keyword: 7,
} as const;

export type WireNode = {
  /** Node type (`NODE.*`). */
  kind: number;
  flags: number;
  parent: number;
  firstChild: number;
  next: number;
  /** Half-open raw byte offsets into the parsed markdown. */
  rawStart: number;
  rawEnd: number;
  /** Extension kind for `*Extension` nodes, else -1. */
  extKind: number;
  /**
   * Payload of an extension node with its delimiters stripped (`TODO`, `tag`,
   * `Page|alias`, `x`). Empty for every other node: text tokens are never read.
   */
  token: string;
};

function align8(value: number): number {
  return (value + 7) & ~7;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

const MAGIC = [76, 85, 84, 69, 65, 83, 84, 49]; // "LUTEAST1"

/** Decode a wire-format-2 AST. `null` means the bytes are not an AST v2. */
export function decodeAst(bytes: Uint8Array): WireNode[] | null {
  if (bytes.length < HEADER_LEN) return null;
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) return null;
  }
  if (readU32(bytes, 8) !== 2) return null;
  const nodeCount = readU32(bytes, 16);
  const stride = readU32(bytes, 20);
  const inputLen = readU32(bytes, 24);
  const poolLen = readU32(bytes, 28);
  const extLen = readU32(bytes, 32);
  const mapLen = readU32(bytes, 36);
  if (nodeCount === 0 || stride < NODE_STRIDE_MIN) return null;

  const nodesOff = HEADER_LEN;
  const extrasOff = align8(nodesOff + nodeCount * stride);
  const inputOff = align8(extrasOff + extLen);
  const poolOff = align8(inputOff + inputLen);
  const mapOff = align8(poolOff + poolLen);
  if (mapOff + mapLen > bytes.length) return null;

  const decoder = new TextDecoder();
  const nodes: WireNode[] = new Array(nodeCount);
  for (let index = 0; index < nodeCount; index += 1) {
    const base = nodesOff + index * stride;
    const flags = readU16(bytes, base + 2);
    const tokRef = readU32(bytes, base + 24);
    const tokLen = readU32(bytes, base + 28);
    const extRef = readU32(bytes, base + 48);
    const extLenHere = readU32(bytes, base + 52);
    let extKind = -1;
    if (extRef !== NULL_NODE && extLenHere > 0) {
      const offset = extrasOff + extRef;
      if (offset + 4 <= bytes.length) extKind = readU32(bytes, offset) | 0;
    }
    // Wire v2 keeps every token in the pool (flags bit 0 set). Only extension
    // payloads are read; decoding every text node would allocate per keystroke.
    let token = "";
    if (extKind >= 0 && tokRef !== NULL_NODE && tokLen > 0 && (flags & 1) !== 0) {
      const start = poolOff + tokRef;
      if (start + tokLen <= bytes.length) {
        token = decoder.decode(bytes.subarray(start, start + tokLen));
      }
    }
    nodes[index] = {
      kind: readU16(bytes, base),
      flags,
      parent: readU32(bytes, base + 4),
      firstChild: readU32(bytes, base + 8),
      next: readU32(bytes, base + 20),
      rawStart: readU32(bytes, base + 40),
      rawEnd: readU32(bytes, base + 44),
      extKind,
      token,
    };
  }

  return nodes;
}

/** Depth-first walk in document order. */
export function walkAst(
  nodes: WireNode[],
  visit: (node: WireNode) => void,
): void {
  const guardLimit = nodes.length + 1;
  const rec = (index: number) => {
    const node = nodes[index];
    if (!node) return;
    visit(node);
    let child = node.firstChild;
    let guard = 0;
    while (child !== NULL_NODE && child < nodes.length && guard < guardLimit) {
      rec(child);
      child = nodes[child]?.next ?? NULL_NODE;
      guard += 1;
    }
  };
  rec(0);
}
