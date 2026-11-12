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
      backgroundColor: "transparent",
      color: "var(--color-ink-soft)",
      fontFamily: "var(--font-mono)",
      fontSize: "14.5px",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.8",
      overflow: "auto",
    },
    ".cm-content": {
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
      borderRadius: "10px",
      backgroundColor: "var(--color-canvas)",
      boxShadow: "var(--shadow-panel)",
      overflow: "hidden",
    },
    ".cm-tooltip-autocomplete > ul": {
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
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
    fontWeight: "700",
  },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--color-accent-strong)" },
  { tag: t.url, color: "var(--color-muted)" },
  { tag: t.quote, color: "var(--color-muted)" },
  { tag: t.list, color: "var(--color-ink-soft)" },
  { tag: t.contentSeparator, color: "var(--color-line-strong)" },
]);

export const noteMarkdownHighlighting = syntaxHighlighting(
  markdownHighlightStyle,
);
