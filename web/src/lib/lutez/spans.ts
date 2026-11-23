/**
 * Editor-side spans: lutez reports **byte** offsets, CodeMirror indexes
 * **UTF-16 code units** of a line-break-normalized document.
 *
 * Three offset spaces are in play (see `wire.ts`):
 *
 * | Space | Used for |
 * |---|---|
 * | raw bytes | line numbers, server rows, block hashes |
 * | normalized bytes (CRLF/CR → LF, NUL → U+FFFD) | this module's input |
 * | UTF-16 units of the normalized text | `Decoration.range`, selections |
 *
 * CodeMirror splits its document on `/\r\n?|\n/`, so it never holds a `\r` — the
 * same normalization lutez applies before recording `src_norm_*`. That is why a
 * decoration must be built from `normStart/normEnd` and not from the raw span:
 * on a CRLF file every line after the first would drift by one unit.
 */
import type { WireNode } from "./wire";

/**
 * Text in lutez's normalized space: CRLF and lone CR become LF, NUL becomes
 * U+FFFD (the same substitutions its source map records).
 *
 * This is the string the mapper maps into, and the string whose `slice()` a
 * decoration covers. Unit offsets stay valid for the editor's own text too —
 * U+FFFD and NUL are both one UTF-16 unit — so only that one character differs.
 */
export function normalizeText(body: string): string {
  return body.replace(/\r\n?/gu, "\n").replace(/\0/gu, "\uFFFD");
}

export type UnitMapper = {
  /** True when every character is one byte and one unit (pure ASCII). */
  readonly identity: boolean;
  /** Length of the mapped text in UTF-16 units. */
  readonly length: number;
  /** Editor offset for a **normalized byte** offset. */
  toUnit(byteOffset: number): number;
};

/**
 * Build the normalized-byte → UTF-16 mapper for `normalizeText(body)`.
 *
 * Each non-ASCII code point shifts the two spaces apart by
 * `utf8Length − utf16Length` (`é` +1, `中` +2, `🎉` +2), so the mapper records
 * one entry per such code point and answers lookups with a binary search:
 * `unit = byte − delta(byte)`. Pure ASCII documents take the identity path.
 *
 * Offsets are expected on code-point boundaries, which is all the parser emits;
 * an offset inside a multi-byte code point maps to the position after the last
 * complete one.
 */
export function utf16Mapper(text: string): UnitMapper {
  if (!/[^\x00-\x7f]/u.test(text)) {
    return {
      identity: true,
      length: text.length,
      toUnit(byteOffset: number): number {
        return Math.min(Math.max(0, byteOffset), text.length);
      },
    };
  }

  const boundary: number[] = [];
  const delta: number[] = [];
  let bytes = 0;
  let shift = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    const units = character.length;
    bytes += size;
    if (size !== units) {
      shift += size - units;
      boundary.push(bytes);
      delta.push(shift);
    }
  }

  const total = bytes;
  const length = text.length;
  return {
    identity: false,
    length,
    toUnit(byteOffset: number): number {
      if (byteOffset <= 0) return 0;
      if (byteOffset >= total) return length;
      let low = 0;
      let high = boundary.length - 1;
      let found = -1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (boundary[middle]! <= byteOffset) {
          found = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      return byteOffset - (found >= 0 ? delta[found]! : 0);
    },
  };
}

/** Editor `[from, to)` range for a node, clamped and ordered. */
export function span16(node: WireNode, mapper: UnitMapper): [number, number] {
  const from = mapper.toUnit(node.normStart);
  const to = mapper.toUnit(node.normEnd);
  return from <= to ? [from, to] : [to, from];
}

/** Source text a node covers, in normalized space. */
export function text16(
  text: string,
  node: WireNode,
  mapper: UnitMapper,
): string {
  const [from, to] = span16(node, mapper);
  return text.slice(from, to);
}
