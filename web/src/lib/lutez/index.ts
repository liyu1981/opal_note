/**
 * The browser half of OpalNote's shared markdown parse (`doc/lutez-parser.md`).
 *
 * `lutez.wasm` is the same CommonMark/GFM parser the server links statically, so
 * the editor's block list, task rows and tags come from the AST the index uses.
 * The hand-written scanners in `blocks.ts`/`tasks.ts` stay as a fallback for the
 * window before the module loads (or if it cannot load at all).
 */
import { fetchLutezEngine, type LutezEngine } from "./glue";
import { parseAstContent, parseDocument, type AstContent, type AstDocument } from "./parse";

export type { AstBlock, AstContent, AstDocument, AstTask } from "./parse";
export { normalizeText, span16, text16, utf16Mapper, type UnitMapper } from "./spans";

let engine: LutezEngine | null = null;
let loadFailed = false;

/** True once the WASM parser is available. */
export function lutezReady(): boolean {
  return engine !== null;
}

/**
 * Compile `lutez.wasm` (served from the app root, copied there by
 * `scripts/build-lutez.mjs`). Called once at startup; a failure is logged and
 * leaves the legacy scanners in place.
 */
export async function loadLutez(): Promise<boolean> {
  if (engine !== null) return true;
  if (loadFailed) return false;
  try {
    engine = await fetchLutezEngine();
    return true;
  } catch (error) {
    loadFailed = true;
    console.warn(
      "lutez: the shared markdown parser did not load; using the hand-written scanners",
      error,
    );
    return false;
  }
}

/** Blocks and tasks for a note body, or `null` before the parser is ready. */
export function lutezContent(body: string): AstContent | null {
  if (!engine) return null;
  return engine.withAst(body, (bytes) => parseAstContent(bytes, body));
}

/**
 * The editor's view of a note: normalized text, every AST node with its span in
 * both spaces, the byte→UTF-16 mapper, and the derived block/task rows.
 *
 * One call per document version — the parser is not incremental, so a caller
 * that reacts to several CodeMirror update flags should parse once and reuse.
 */
export function lutezDocument(body: string): AstDocument | null {
  if (!engine) return null;
  return engine.withAst(body, (bytes) => parseDocument(bytes, body));
}

