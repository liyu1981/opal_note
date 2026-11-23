/**
 * The browser half of OpalNote's shared markdown parse (`doc/lutez-parser.md`).
 *
 * `lutez.wasm` is the same CommonMark/GFM parser the server links statically, so
 * the editor's block list, task rows and tags come from the AST the index uses.
 * The hand-written scanners in `blocks.ts`/`tasks.ts` stay as a fallback for the
 * window before the module loads (or if it cannot load at all).
 */
import { fetchLutezEngine, type LutezEngine } from "./glue";
import { parseAstContent, type AstContent } from "./parse";

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

