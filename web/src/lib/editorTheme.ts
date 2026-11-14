import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/**
 * The editor surface intentionally uses a fixed-width face: note bodies are
 * read like source, and aligned markup is easier to scan.
 */
export const noteEditorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--color-paper)",
      color: "var(--color-ink-soft)",
      fontFamily: "var(--font-editor)",
      fontSize: "16px",
    },
    ".cm-scroller": {
      backgroundColor: "var(--color-paper)",
      fontFamily: "var(--font-editor)",
      lineHeight: "1.8",
      overflow: "auto",
    },
    ".cm-content": {
      backgroundColor: "var(--color-paper)",
      maxWidth: "820px",
      margin: "0 auto",
      padding: "1.35rem 1.75rem 4rem",
      caretColor: "var(--color-accent-strong)",
    },
    ".cm-line": {
      padding: "2px 0",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--color-accent-strong)",
      borderLeftWidth: "2px",
    },
    ".cm-selectionBackground, ::selection": {
      backgroundColor:
        "color-mix(in srgb, var(--color-accent) 22%, transparent)",
    },
    ".cm-activeLine": {
      backgroundColor: "transparent",
    },
    ".cm-placeholder": {
      color: "var(--color-faint)",
      fontStyle: "normal",
    },
    ".cm-tooltip": {
      border: "1px solid var(--color-line)",
      borderRadius: "8px",
      backgroundColor: "var(--color-canvas)",
      boxShadow: "var(--shadow-panel)",
      overflow: "hidden",
    },
    ".cm-tooltip-autocomplete > ul": {
      fontFamily: "var(--font-mono)",
      fontSize: "14px",
      maxHeight: "17rem",
    },
    ".cm-tooltip-autocomplete > ul > li": {
      padding: "4px 10px",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--color-accent-soft)",
      color: "var(--color-accent-strong)",
    },
    ".cm-completionDetail": {
      color: "var(--color-faint)",
      fontStyle: "normal",
      marginLeft: "0.75rem",
    },
  },
  { dark: false },
);

const markdownHighlightStyle = HighlightStyle.define([
  {
    tag: [
      t.heading,
      t.heading1,
      t.heading2,
      t.heading3,
      t.heading4,
      t.heading5,
      t.heading6,
    ],
    color: "var(--color-ink)",
    fontWeight: "600",
  },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--color-accent-strong)" },
  { tag: t.url, color: "var(--color-muted)" },
  { tag: t.quote, color: "var(--color-muted)" },
  { tag: t.list, color: "var(--color-ink-soft)" },
  { tag: t.contentSeparator, color: "var(--color-line-strong)" },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: "var(--color-muted)",
    fontStyle: "italic",
  },
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.definitionKeyword,
      t.moduleKeyword,
      t.operatorKeyword,
      t.modifier,
      t.self,
    ],
    color: "var(--color-accent-strong)",
  },
  {
    tag: [t.string, t.special(t.string), t.regexp, t.escape],
    color: "var(--color-mint)",
  },
  {
    tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom],
    color: "var(--color-danger)",
  },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.variableName),
    ],
    color: "var(--color-accent)",
  },
  {
    tag: [t.typeName, t.className, t.namespace],
    color: "var(--color-muted)",
  },
  {
    tag: [t.propertyName, t.attributeName, t.attributeValue],
    color: "var(--color-accent-strong)",
  },
  { tag: t.tagName, color: "var(--color-danger)" },
  {
    tag: [
      t.operator,
      t.punctuation,
      t.bracket,
      t.brace,
      t.paren,
      t.squareBracket,
      t.angleBracket,
    ],
    color: "var(--color-muted)",
  },
  {
    tag: [t.meta, t.annotation, t.processingInstruction],
    color: "var(--color-faint)",
  },
  {
    tag: t.invalid,
    color: "var(--color-danger)",
    textDecoration: "underline wavy",
  },
]);

export const noteMarkdownHighlighting = syntaxHighlighting(
  markdownHighlightStyle,
);
