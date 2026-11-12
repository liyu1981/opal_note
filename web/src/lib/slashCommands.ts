import type { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import {
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";

type SlashCommand = {
  label: string;
  detail: string;
  keywords: string;
  apply: (view: EditorView, from: number, to: number) => void;
};

function applyPrefix(prefix: string) {
  return (view: EditorView, from: number, to: number) => {
    view.dispatch({
      changes: { from, to, insert: prefix },
      selection: { anchor: from + prefix.length },
      scrollIntoView: true,
    });
  };
}

function applyWrapped(open: string, close: string, innerOffset = 0) {
  return (view: EditorView, from: number, to: number) => {
    const insert = `${open}${close}`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + open.length + innerOffset },
      scrollIntoView: true,
    });
  };
}

function applyCodeBlock(view: EditorView, from: number, to: number) {
  const insert = "```\n\n```";
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + 4 },
    scrollIntoView: true,
  });
}

function applyWikiLink(view: EditorView, from: number, to: number) {
  view.dispatch({
    changes: { from, to, insert: "[[" },
    selection: { anchor: from + 2 },
    scrollIntoView: true,
  });
  // Let the wiki-link source take over after the slash menu closes.
  window.setTimeout(() => startCompletion(view), 0);
}

const COMMANDS: SlashCommand[] = [
  {
    label: "Heading 1",
    detail: "Block",
    keywords: "h1 title heading",
    apply: applyPrefix("# "),
  },
  {
    label: "Heading 2",
    detail: "Block",
    keywords: "h2 title heading",
    apply: applyPrefix("## "),
  },
  {
    label: "Heading 3",
    detail: "Block",
    keywords: "h3 title heading",
    apply: applyPrefix("### "),
  },
  {
    label: "Bullet list",
    detail: "List",
    keywords: "ul unordered bullet list",
    apply: applyPrefix("- "),
  },
  {
    label: "Numbered list",
    detail: "List",
    keywords: "ol ordered number list",
    apply: applyPrefix("1. "),
  },
  {
    label: "Task",
    detail: "List",
    keywords: "todo checkbox task",
    apply: applyPrefix("- [ ] "),
  },
  {
    label: "Quote",
    detail: "Block",
    keywords: "blockquote quote",
    apply: applyPrefix("> "),
  },
  {
    label: "Code block",
    detail: "Block",
    keywords: "code fence pre",
    apply: applyCodeBlock,
  },
  {
    label: "Divider",
    detail: "Block",
    keywords: "hr horizontal rule divider",
    apply: applyPrefix("---"),
  },
  {
    label: "Link to page",
    detail: "Inline",
    keywords: "wikilink link page",
    apply: applyWikiLink,
  },
  {
    label: "Inline code",
    detail: "Inline",
    keywords: "code inline backtick",
    apply: applyWrapped("`", "`"),
  },
];

/**
 * `/` block menu. It deliberately only opens at the start of a source line
 * (after indentation), so slashes inside URLs and prose do not interrupt
 * editing.
 */
type SyntaxCursor = { name: string; parent: SyntaxCursor | null };

function insideFencedCode(context: CompletionContext): boolean {
  let node = syntaxTree(context.state).resolveInner(
    context.pos,
    -1,
  ) as unknown as SyntaxCursor | null;
  while (node) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") return true;
    node = node.parent;
  }
  return false;
}

export function slashCommandSource(
  context: CompletionContext,
): CompletionResult | null {
  if (insideFencedCode(context)) return null;

  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const match = /^(\s*)\/([^/\n]*)$/u.exec(before);
  if (!match) return null;

  const query = (match[2] ?? "").trim().toLowerCase();
  if (query.includes(" ")) return null;

  const options: Completion[] = COMMANDS.filter((command) => {
    if (!query) return true;
    return `${command.label} ${command.keywords}`.toLowerCase().includes(query);
  }).map((command) => ({
    label: command.label,
    detail: command.detail,
    apply: (view, _completion, from, to) => command.apply(view, from, to),
    type: "text",
  }));

  if (options.length === 0) return null;

  return {
    from: line.from + (match[1]?.length ?? 0),
    options,
    filter: false,
  };
}
