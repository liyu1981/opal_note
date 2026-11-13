import {
  StateEffect,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import { normalizeLinkTarget, splitWikilink } from "./markdown";

export type LinkTarget = { title: string; path: string };

export type LivePreviewOptions = {
  linkKeys: Set<string>;
  onWikiLink: (target: string) => void;
  onOpenLink: (url: string) => void;
  onTag: (tag: string) => void;
  readOnly: boolean;
};

type OptionsRef = { current: LivePreviewOptions };

const CODE_FENCE_OPEN =
  /^(\s*)((?:[-*+]|\d+[.)])\s+)?(`{3,}|~{3,})(.*)$/u;
const CODE_FENCE_CLOSE = /^(\s*)(`{3,}|~{3,})\s*$/u;

type CodeBlockRange = {
  start: number;
  end: number;
  char: string;
  indent: number;
};

/** Locate fenced blocks so focusing any line can reveal the whole block. */
function findCodeBlocks(doc: Text): CodeBlockRange[] {
  const blocks: CodeBlockRange[] = [];
  let open: { start: number; char: string; indent: number } | null = null;

  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const text = doc.line(lineNumber).text;
    if (open) {
      const closing = CODE_FENCE_CLOSE.exec(text);
      if (closing && closing[2]?.[0] === open.char) {
        blocks.push({ ...open, end: lineNumber });
        open = null;
      }
      continue;
    }

    const opening = CODE_FENCE_OPEN.exec(text);
    if (!opening) continue;
    const marker = opening[3] ?? "```";
    open = {
      start: lineNumber,
      char: marker[0] ?? "`",
      indent:
        leadingIndentColumns(text) +
        (opening[2] ? columnsOf(opening[2]) : 0),
    };
  }

  if (open) blocks.push({ ...open, end: doc.lines });
  return blocks;
}

/** Ask the live decorations to rebuild even when the document did not change. */
export const refreshLivePreview = StateEffect.define<null>();

export function livePreview(optionsRef: OptionsRef): Extension {
  class LivePreviewPlugin {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view, optionsRef.current);
    }

    update(update: ViewUpdate) {
      const refreshed = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(refreshLivePreview)),
      );
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged ||
        refreshed
      ) {
        this.decorations = buildDecorations(update.view, optionsRef.current);
      }
    }
  }

  return [
    ViewPlugin.fromClass(LivePreviewPlugin, {
      decorations: (plugin) => plugin.decorations,
    }),
    EditorView.domEventHandlers({
      click(event) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return false;
        const tagElement = target.closest(".cm-live-tag");
        if (!tagElement) return false;
        const tag = tagElement.textContent?.replace(/^#/u, "").trim();
        if (!tag) return false;
        event.preventDefault();
        optionsRef.current.onTag(tag);
        return true;
      },
    }),
  ];
}

function buildDecorations(
  view: EditorView,
  options: LivePreviewOptions,
): DecorationSet {
  const doc = view.state.doc;
  const ranges: Range<Decoration>[] = [];
  const occupied: Array<[number, number]> = [];
  const claimed: Array<[number, number]> = [];

  // Show source only for the block(s) being edited. With focus elsewhere the
  // whole note reads as preview, like Obsidian's reading surface.
  const activeLines = new Set<number>();
  // Interactive widgets can receive DOM focus (checkbox, link). Revealing the
  // source of their line would replace the widget mid-click, so leave it in
  // preview while a widget has focus.
  const activeElement = document.activeElement;
  const widgetHasFocus =
    activeElement instanceof Element &&
    activeElement.closest(
      ".cm-live-task-box, .cm-live-wikilink, .cm-live-link",
    ) !== null;

  if (view.hasFocus && !widgetHasFocus) {
    for (const selection of view.state.selection.ranges) {
      const first = doc.lineAt(selection.from).number;
      const last = doc.lineAt(selection.to).number;
      for (let line = first; line <= last; line += 1) activeLines.add(line);
    }
  }

  const codeBlocks = findCodeBlocks(doc);
  const editingCodeLines = new Set<number>();
  for (const block of codeBlocks) {
    const touched = Array.from(activeLines).some(
      (line) => line >= block.start && line <= block.end,
    );
    if (!touched) continue;
    for (let line = block.start; line <= block.end; line += 1) {
      editingCodeLines.add(line);
    }
  }

  const overlaps = (from: number, to: number) =>
    occupied.some(([start, end]) => from < end && to > start);

  // A range fully inside a code span/link must not be reformatted. Container
  // formatting (e.g. bold around `code`) is still allowed.
  const insideClaimed = (from: number, to: number) =>
    claimed.some(([start, end]) => start <= from && end >= to);

  const addLine = (
    lineNumber: number,
    className: string,
    attributes?: Record<string, string>,
  ) => {
    const line = doc.line(lineNumber);
    ranges.push(Decoration.line({ class: className, attributes }).range(line.from));
  };

  const addMark = (from: number, to: number, className: string) => {
    if (to > from && !overlaps(from, to)) {
      ranges.push(Decoration.mark({ class: className }).range(from, to));
    }
  };

  const hide = (from: number, to: number) => {
    if (to > from && !overlaps(from, to)) {
      ranges.push(Decoration.replace({}).range(from, to));
      occupied.push([from, to]);
    }
  };

  const replace = (from: number, to: number, widget: WidgetType) => {
    if (to > from && !overlaps(from, to)) {
      ranges.push(Decoration.replace({ widget }).range(from, to));
      occupied.push([from, to]);
    }
  };

  const isEscaped = (text: string, index: number) => {
    let slashes = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) slashes += 1;
    return slashes % 2 === 1;
  };

  let fence: { char: string; indent: number } | null = null;

  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const line = doc.line(lineNumber);
    const text = line.text;
    const active = activeLines.has(lineNumber);
    if (active) {
      const indent = leadingIndentColumns(text);
      const pad = sourceContentColumns(text);
      addLine(
        lineNumber,
        `cm-live-active cm-live-edit${pad > 0 ? " cm-live-hang" : ""}`,
        {
          style: `--block-indent:${indent}${
            pad > 0 ? `;--block-pad:${pad}` : ""
          }`,
        },
      );
    }

    // Focusing any line of a fenced block reveals the entire source block:
    // both fences, original indentation and all code lines. Preview styling
    // resumes when focus leaves the block.
    if (editingCodeLines.has(lineNumber)) {
      const indent = leadingIndentColumns(text);
      addLine(
        lineNumber,
        `cm-live-code-edit${indent > 0 ? " cm-live-hang" : ""}`,
        indent > 0
          ? { style: `--block-indent:${indent};--block-pad:${indent}` }
          : undefined,
      );
      continue;
    }

    // A focused source line is plain markdown: no heading/list/quote styling,
    // no inline markup colors and no rendered widgets. The active-line tint
    // remains as the only focus cue.
    if (active) continue;

    // ---- fenced code -----------------------------------------------------
    const addCodeLine = (
      className: string,
      indent: number,
      hideWholeLine: boolean,
    ) => {
      addLine(lineNumber, className, {
        style: `--code-indent:${indent}`,
      });
      if (hideWholeLine) {
        hide(line.from, line.to);
      } else {
        const prefix = leadingWhitespaceChars(text, indent);
        if (prefix > 0) hide(line.from, line.from + prefix);
      }
    };

    if (fence) {
      const closing = CODE_FENCE_CLOSE.exec(text);
      if (closing && closing[2]?.[0] === fence.char) {
        addCodeLine(
          `cm-live-code-line cm-live-code-fence cm-live-code-end${
            active ? "" : " cm-live-code-fence-hidden"
          }`,
          fence.indent,
          !active,
        );
        fence = null;
      } else {
        addCodeLine("cm-live-code-line", fence.indent, false);
      }
      continue;
    }

    // A Logseq block may open its fence after a bullet or ordered marker:
    //   - ```javascript
    // Treat the marker as indentation so the code body aligns with the list
    // content rather than falling back to plain markdown lines.
    const opening = CODE_FENCE_OPEN.exec(text);
    if (opening) {
      const marker = opening[3] ?? "```";
      const indent =
        leadingIndentColumns(text) + (opening[2] ? columnsOf(opening[2]) : 0);
      fence = { char: marker[0] ?? "`", indent };
      addCodeLine(
        `cm-live-code-line cm-live-code-fence cm-live-code-start${
          active ? "" : " cm-live-code-fence-hidden"
        }`,
        indent,
        !active,
      );
      continue;
    }

    // Collapse blank source lines in preview; an active blank line stays
    // normal height so the caret remains easy to use.
    if (!active && text.trim() === "") {
      addLine(lineNumber, "cm-live-blank");
      continue;
    }

    // ---- HTML-only comment lines (Logseq export trailer) -----------------
    if (/^\s*<!--.*-->\s*$/u.test(text)) {
      if (!active) {
        addLine(lineNumber, "cm-live-blank");
        hide(line.from, line.to);
      }
      continue;
    }

    // ---- horizontal rule -------------------------------------------------
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/u.test(text)) {
      const hrIndent = leadingIndentColumns(text);
      addLine(
        lineNumber,
        "cm-live-hr",
        active ? undefined : { style: `--hr-indent:${hrIndent}` },
      );
      if (!active) {
        replace(line.from, line.to, new HorizontalRuleWidget());
      }
      continue;
    }

    const leadingIndent = leadingIndentColumns(text);
    const isListLine = /^(\s*)([-*+]|\d+[.)])\s+/u.test(text);
    const isQuoteLine = /^(\s*)>/u.test(text);
    if (leadingIndent > 0 && !isListLine && !isQuoteLine) {
      // Indented continuation blocks in Logseq files: keep wrapped lines at
      // the same content column as the first line.
      addLine(lineNumber, "cm-live-hang", {
        style: `--block-indent:${leadingIndent};--block-pad:${leadingIndent}`,
      });
    }

    // ---- block prefix ----------------------------------------------------
    const heading = /^(\s*)(#{1,6})\s+/u.exec(text);
    if (heading) {
      addLine(lineNumber, `cm-live-h${(heading[2] ?? "#").length}`);
      if (!active) {
        hide(
          line.from + (heading[1]?.length ?? 0),
          line.from + heading[0].length,
        );
      }
    }

    const quote = /^(\s*)((?:>\s?)+)/u.exec(text);
    if (quote) {
      addLine(lineNumber, "cm-live-quote");
      if (!active) {
        hide(line.from + (quote[1]?.length ?? 0), line.from + quote[0].length);
      }
    }

    const task = /^(\s*)([-*+])\s+\[([ xX])\]\s?/u.exec(text);
    if (task) {
      const checked = (task[3] ?? " ").toLowerCase() === "x";
      const taskIndent = leadingIndentColumns(text);
      // In preview the checkbox is ~2ch wide; while editing, reserve the full
      // source marker (`- [ ] `) so wrapped content stays under the text.
      const taskPad = active
        ? columnsOf(task[0])
        : taskIndent + 2;
      addLine(
        lineNumber,
        `${
          checked ? "cm-live-task cm-live-task-done" : "cm-live-task"
        } cm-live-hang`,
        {
          style: `--block-indent:${taskIndent};--block-pad:${taskPad}`,
        },
      );

      if (!active) {
        const markerStart = line.from + (task[1]?.length ?? 0);
        const checkIndex = text.indexOf("[", task[1]?.length ?? 0);
        if (checkIndex >= 0) {
          const checkFrom = line.from + checkIndex;
          const checkTo = checkFrom + 3;
          replace(
            markerStart,
            line.from + task[0].length,
            new TaskWidget(checked, checkFrom, checkTo, view, options.readOnly),
          );
        }
      }
    } else {
      const bullet = /^(\s*)([-*+])\s+/u.exec(text);
      if (bullet) {
        const bulletIndent = leadingIndentColumns(text);
        const nestedHeading = /^(\s*)([-*+])\s+(#{1,6})\s+/u.exec(text);
        const bulletPad =
          nestedHeading && active ? columnsOf(nestedHeading[0]) : columnsOf(bullet[0]);
        addLine(lineNumber, "cm-live-list cm-live-hang", {
          style: `--block-indent:${bulletIndent};--block-pad:${bulletPad}`,
        });
        if (nestedHeading) {
          addLine(lineNumber, `cm-live-h${nestedHeading[3]?.length ?? 1}`);
          if (!active) {
            const hashIndex = text.indexOf(
              "#",
              (bullet[1]?.length ?? 0) + (bullet[2]?.length ?? 0) + 1,
            );
            if (hashIndex >= 0) {
              hide(line.from + hashIndex, line.from + nestedHeading[0].length);
            }
          }
        }
        if (!active) {
          replace(
            line.from + (bullet[1]?.length ?? 0),
            line.from + bullet[0].length,
            new BulletWidget(),
          );
        }
      } else {
        const ordered = /^(\s*)(\d+[.)])\s+/u.exec(text);
        if (ordered) {
          const orderedIndent = leadingIndentColumns(text);
          const orderedPad = columnsOf(ordered[0]);
          addLine(lineNumber, "cm-live-list cm-live-list-ordered cm-live-hang", {
            style: `--block-indent:${orderedIndent};--block-pad:${orderedPad}`,
          });
          addMark(
            line.from + (ordered[1]?.length ?? 0),
            line.from + (ordered[1]?.length ?? 0) + (ordered[2] ?? "").length,
            "cm-live-list-marker",
          );
        }
      }
    }

    // ---- inline content --------------------------------------------------
    const process = (regex: RegExp, handler: (match: RegExpExecArray) => void) => {
      regex.lastIndex = 0;
      let match = regex.exec(text);
      while (match) {
        if (!isEscaped(text, match.index)) handler(match);
        match = regex.exec(text);
      }
    };

    // Inline code first: links/markup inside a code span must stay literal.
    const code = /`([^`\n]+)`/gu;
    process(code, (match) => {
      const start = line.from + match.index;
      const end = start + match[0].length;
      if (overlaps(start, end)) return;
      if (!active) {
        hide(start, start + 1);
        hide(end - 1, end);
      }
      addMark(start + 1, end - 1, "cm-live-inline-code");
      claimed.push([start, end]);
    });

    const wikilink = /\[\[([^\]\n]+)\]\]/gu;
    process(wikilink, (match) => {
      const start = line.from + match.index;
      const end = start + match[0].length;
      if (insideClaimed(start, end) || overlaps(start, end)) return;
      if (match.index > 0 && text[match.index - 1] === "!") return;

      const { target, label } = splitWikilink(match[1] ?? "");
      if (!target) return;
      const resolved = options.linkKeys.has(normalizeLinkTarget(target));

      if (active) {
        addMark(start + 2, end - 2, "cm-live-wikilink");
      } else {
        replace(
          start,
          end,
          new WikiLinkWidget(target, label, resolved, options.onWikiLink),
        );
      }
      claimed.push([start, end]);
    });

    const markdownLink = /(!?)\[([^\]\n]+)\]\(([^)\n]+)\)/gu;
    process(markdownLink, (match) => {
      if (match[1] === "!") return; // embedding is deliberately out of scope
      const start = line.from + match.index;
      const end = start + match[0].length;
      if (insideClaimed(start, end) || overlaps(start, end)) return;

      const label = match[2] ?? "";
      const url = match[3] ?? "";
      const labelFrom = start + 1;
      if (active) {
        addMark(labelFrom, labelFrom + label.length, "cm-live-link");
      } else {
        replace(
          start,
          end,
          new ExternalLinkWidget(label, url, options.onOpenLink),
        );
      }
      claimed.push([start, end]);
    });

    const bold = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/gu;
    process(bold, (match) => {
      const start = line.from + match.index;
      const end = start + match[0].length;
      if (insideClaimed(start, end)) return;
      const marker = match[1] !== undefined ? "**" : "__";
      const contentFrom = start + marker.length;
      const contentTo = end - marker.length;
      if (!active) {
        hide(start, contentFrom);
        hide(contentTo, end);
      }
      addMark(contentFrom, contentTo, "cm-live-bold");
    });

    const strike = /~~([^~\n]+)~~/gu;
    process(strike, (match) => {
      const start = line.from + match.index;
      const end = start + match[0].length;
      if (insideClaimed(start, end)) return;
      if (!active) {
        hide(start, start + 2);
        hide(end - 2, end);
      }
      addMark(start + 2, end - 2, "cm-live-strike");
    });

    const highlight = /==([^=\n]+)==/gu;
    process(highlight, (match) => {
      const start = line.from + match.index;
      const end = start + match[0].length;
      if (insideClaimed(start, end)) return;
      if (!active) {
        hide(start, start + 2);
        hide(end - 2, end);
      }
      addMark(start + 2, end - 2, "cm-live-highlight");
    });

    const italic = /\*([^*\n]+)\*|(?<![\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])/gu;
    process(italic, (match) => {
      const start = line.from + match.index;
      const end = start + match[0].length;
      if (insideClaimed(start, end)) return;
      const marker = match[1] !== undefined ? "*" : "_";
      const contentFrom = start + marker.length;
      const contentTo = end - marker.length;
      if (!active) {
        hide(start, contentFrom);
        hide(contentTo, end);
      }
      addMark(contentFrom, contentTo, "cm-live-italic");
    });

    const tag = /(^|[\s([{,])#([\p{L}\p{N}_./-]+)/gu;
    process(tag, (match) => {
      const prefixLength = match[1]?.length ?? 0;
      const start = line.from + match.index + prefixLength;
      const end = line.from + match.index + match[0].length;
      if (insideClaimed(start, end) || overlaps(start, end)) return;
      addMark(start, end, "cm-live-tag");
    });
  }

  return Decoration.set(ranges, true);
}

/** Column where a source block's content starts, including list markers. */
function sourceContentColumns(text: string): number {
  const task = /^(\s*)([-*+])\s+\[[ xX]\]\s?/u.exec(text);
  if (task) return columnsOf(task[0]);

  const bullet = /^(\s*)([-*+])\s+/u.exec(text);
  if (bullet) return columnsOf(bullet[0]);

  const ordered = /^(\s*)(\d+[.)])\s+/u.exec(text);
  if (ordered) return columnsOf(ordered[0]);

  const quote = /^(\s*)((?:>\s?)+)/u.exec(text);
  if (quote) return columnsOf(quote[0]);

  const heading = /^(\s*)(#{1,6})\s+/u.exec(text);
  if (heading) return columnsOf(heading[0]);

  return leadingIndentColumns(text);
}

function columnsOf(text: string, limit = 40): number {
  let columns = 0;
  for (const char of text) {
    if (char === "\t") columns += 4;
    else columns += 1;
    if (columns >= limit) break;
  }
  return Math.min(columns, limit);
}

function leadingIndentColumns(text: string): number {
  let columns = 0;
  for (const char of text) {
    if (char === " ") columns += 1;
    else if (char === "\t") columns += 4;
    else break;
  }
  return Math.min(columns, 40);
}

function leadingWhitespaceChars(text: string, columns: number): number {
  let count = 0;
  let seen = 0;
  for (const char of text) {
    if (char === " ") seen += 1;
    else if (char === "\t") seen += 4;
    else break;
    count += 1;
    if (seen >= columns) break;
  }
  return count;
}

class WikiLinkWidget extends WidgetType {
  constructor(
    private readonly target: string,
    private readonly label: string,
    private readonly resolved: boolean,
    private readonly onOpen: (target: string) => void,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof WikiLinkWidget &&
      other.target === this.target &&
      other.label === this.label &&
      other.resolved === this.resolved
    );
  }

  toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = this.resolved
      ? "cm-live-wikilink"
      : "cm-live-wikilink is-missing";
    element.textContent = this.label;
    element.title = this.resolved
      ? `Open “${this.target}”`
      : `No note yet: ${this.target}`;
    element.tabIndex = 0;
    element.setAttribute("role", "link");

    const open = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onOpen(this.target);
    };
    element.addEventListener("mousedown", open);
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") open(event);
    });
    return element;
  }
}

class ExternalLinkWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly url: string,
    private readonly onOpen: (url: string) => void,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof ExternalLinkWidget &&
      other.label === this.label &&
      other.url === this.url
    );
  }

  toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = "cm-live-link";
    element.textContent = this.label || this.url;
    element.title = this.url;
    element.tabIndex = 0;
    element.setAttribute("role", "link");

    const open = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onOpen(this.url);
    };
    element.addEventListener("mousedown", open);
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") open(event);
    });
    return element;
  }
}

class TaskWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly checkFrom: number,
    private readonly checkTo: number,
    private readonly view: EditorView,
    private readonly readOnly: boolean,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof TaskWidget &&
      other.checked === this.checked &&
      other.checkFrom === this.checkFrom &&
      other.checkTo === this.checkTo &&
      other.readOnly === this.readOnly
    );
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("label");
    wrapper.className = this.readOnly
      ? "cm-live-task-box is-readonly"
      : "cm-live-task-box";
    wrapper.addEventListener("mousedown", (event) => event.stopPropagation());

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-live-task-input";
    input.checked = this.checked;
    input.disabled = this.readOnly;
    input.setAttribute(
      "aria-label",
      this.checked ? "Mark task incomplete" : "Mark task complete",
    );

    const tick = document.createElement("span");
    tick.className = "cm-live-task-tick";

    input.addEventListener("mousedown", (event) => event.stopPropagation());
    if (!this.readOnly) {
      input.addEventListener("change", () => {
        const current = this.view.state.sliceDoc(this.checkFrom, this.checkTo);
        if (!/^\[[ xX]\]$/u.test(current)) return;
        this.view.dispatch({
          changes: {
            from: this.checkFrom,
            to: this.checkTo,
            insert: input.checked ? "[x]" : "[ ]",
          },
        });
      });
    }

    wrapper.append(input, tick);
    return wrapper;
  }
}

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = "cm-live-bullet";
    element.textContent = "•";
    return element;
  }
}

class HorizontalRuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = "cm-live-hr-line";
    element.setAttribute("aria-hidden", "true");
    return element;
  }
}
