import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";

import type { TagCount } from "../api/types";

type TagsRef = { current: TagCount[] };
type SyntaxCursor = { name: string; parent: SyntaxCursor | null };

/** Syntax the tag picker must stay out of. */
const SKIPPED_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "Link",
  "Image",
  "Autolink",
  "URL",
]);

function insideSkippedSyntax(context: CompletionContext): boolean {
  let node = syntaxTree(context.state).resolveInner(
    context.pos,
    -1,
  ) as unknown as SyntaxCursor | null;
  while (node) {
    if (SKIPPED_NODES.has(node.name)) return true;
    node = node.parent;
  }
  return false;
}

/**
 * `#` completion over the notebook's tags, like the `/` command menu.
 *
 * Tags only start at the beginning of a line or after whitespace/opening
 * punctuation (mirroring the live-preview tag rule), so `url#fragment` and
 * `[[Page#Heading]]` never open the picker. A bare `#` at the start of a line
 * is a markdown heading, so there we wait for the first tag character.
 */
export function tagCompletionSource(
  tagsRef: TagsRef,
): (context: CompletionContext) => CompletionResult | null {
  return (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const match = /(^|[\s([{,])#([\p{L}\p{N}_./-]*)$/u.exec(before);
    if (!match) return null;

    const query = match[2] ?? "";
    const atLineStart = (match[1] ?? "") === "";
    if (atLineStart && query.length === 0) return null;

    const tagStart = context.pos - query.length - 1;
    const prefix = context.state.sliceDoc(line.from, tagStart);
    if (prefix.lastIndexOf("[[") > prefix.lastIndexOf("]]")) return null;
    if (insideSkippedSyntax(context)) return null;

    const needle = query.toLowerCase();
    const options: Completion[] = tagsRef.current
      .filter((tag) => !needle || tag.tag.toLowerCase().includes(needle))
      .sort(
        (left, right) =>
          right.count - left.count || left.tag.localeCompare(right.tag),
      )
      .slice(0, 30)
      .map((tag) => ({
        label: `#${tag.tag}`,
        detail: `${tag.count} ${tag.count === 1 ? "page" : "pages"}`,
        type: "keyword",
        apply: applyTag(tag.tag),
      }));

    if (options.length === 0) return null;
    return {
      from: tagStart,
      options,
      // Labels start with `#`, so CodeMirror's own fuzzy filter narrows the
      // list while the query keeps matching `validFor` (no re-query per key).
      filter: true,
      validFor: /^#[^\s#]*$/u,
    };
  };
}

function applyTag(tag: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const insert = `#${tag}`;
    // Keep the cursor ready for the next word unless punctuation follows.
    const after = view.state.sliceDoc(to, to + 1);
    const needsSpace = after === "" || !/^[\s)\]},.;:!?]/u.test(after);
    const text = needsSpace ? `${insert} ` : insert;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: "input.complete",
      scrollIntoView: true,
    });
  };
}
