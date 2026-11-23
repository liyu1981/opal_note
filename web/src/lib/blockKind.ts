/**
 * The block kinds the index, the API and the editor share (`doc/blocks.md` §1).
 *
 * One definition for both parsers so the AST adapter cannot drift from the
 * editor's glyph map.
 */
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
