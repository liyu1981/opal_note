import katex from "katex";

export type MathRender = {
  /** KaTeX markup, or "" when the formula could not be typeset. */
  html: string;
  error: string | null;
};

/** Formulae longer than this are left as source: no note needs more. */
export const MAX_MATH_CHARS = 2000;

const CACHE_LIMIT = 300;
const cache = new Map<string, MathRender>();

/**
 * Typeset one formula. `trust: false` keeps `\href`, `\url` and `\html*`
 * commands inert, so a note body can never inject links or markup through a
 * formula, and rendering happens once per distinct source.
 */
export function renderMath(source: string, displayMode: boolean): MathRender {
  const key = `${displayMode ? "D" : "I"}\u0000${source}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let result: MathRender;
  try {
    result = {
      html: katex.renderToString(source, {
        displayMode,
        throwOnError: true,
        strict: "ignore",
        trust: false,
        maxExpand: 1000,
        maxSize: 60,
        output: "htmlAndMathml",
      }),
      error: null,
    };
  } catch (error) {
    result = {
      html: "",
      error: error instanceof Error ? error.message : "Invalid LaTeX",
    };
  }

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, result);
  return result;
}
