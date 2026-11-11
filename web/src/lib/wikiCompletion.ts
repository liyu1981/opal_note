import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";

import type { LinkTarget } from "./livePreview";
import { normalizeTitle } from "./markdown";

type TargetsRef = { current: LinkTarget[] };

/**
 * `[[` completion over the current notebook's page titles and paths.
 * Paths are offered when the query contains `/` (journal links, namespaces).
 */
export function wikiLinkCompletionSource(
  targetsRef: TargetsRef,
): (context: CompletionContext) => CompletionResult | null {
  return (context) => {
    const match = context.matchBefore(/\[\[([^\]|\n]*)$/u);
    if (!match) return null;

    const query = match.text.slice(2).trim();
    const needle = query.toLowerCase();
    const targets = targetsRef.current;
    const options: Completion[] = [];
    const seen = new Set<string>();

    const add = (label: string, detail: string, value: string) => {
      const key = normalizeTitle(label);
      if (!key || seen.has(key)) return;
      seen.add(key);
      options.push({
        label,
        detail,
        apply: applyLink(value || label),
        type: "text",
      });
    };

    for (const target of targets) {
      if (target.title.toLowerCase().includes(needle)) {
        add(target.title, target.path, target.title);
      }
    }

    if (needle.includes("/")) {
      for (const target of targets) {
        if (target.path.toLowerCase().includes(needle)) {
          add(target.path, target.title, target.path);
        }
      }
    }

    if (options.length === 0) return null;
    return {
      from: match.from + 2,
      options: options.slice(0, 30),
      filter: false,
    };
  };
}

function applyLink(value: string) {
  return (
    view: EditorView,
    _completion: Completion,
    from: number,
    to: number,
  ) => {
    const after = view.state.sliceDoc(to, to + 2);
    const insert = after === "]]" ? value : `${value}]]`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
  };
}
