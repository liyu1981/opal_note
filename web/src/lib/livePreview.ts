import {
  StateEffect,
  type Extension,
  type Range,
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
};

type OptionsRef = { current: LivePreviewOptions };

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

  return ViewPlugin.fromClass(LivePreviewPlugin, {
    decorations: (plugin) => plugin.decorations,
  });
}

function buildDecorations(
  view: EditorView,
  options: LivePreviewOptions,
): DecorationSet {
  const doc = view.state.doc;
  const ranges: Range<Decoration>[] = [];
  const occupied: Array<[number, number]> = [];

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

  const overlaps = (from: number, to: number) =>
    occupied.some(([start, end]) => from < end && to > start);

  const addLine = (lineNumber: number, className: string) => {
    const line = doc.line(lineNumber);
    ranges.push(Decoration.line({ class: className }).range(line.from));
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

  let fence: { char: string } | null = null;

  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const line = doc.line(lineNumber);
    const text = line.text;
    const active = activeLines.has(lineNumber);
    if (active) addLine(lineNumber, "cm-live-active");

    // ---- fenced code -----------------------------------------------------
    if (fence) {
      const closing = /^(\s*)(`{3,}|~{3,})\s*$/.exec(text);
      if (closing && closing[2]?.[0] === fence.char) {
        addLine(
          lineNumber,
          `cm-live-code-line cm-live-code-fence cm-live-code-end${
            active ? "" : " cm-live-code-fence-hidden"
          }`,
        );
        if (!active) hide(line.from + (closing[1]?.length ?? 0), line.from + closing[0].length);
        fence = null;
      } else {
        addLine(lineNumber, "cm-live-code-line");
      }
      continue;
    }

    const opening = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(text);
    if (opening) {
      const marker = opening[2] ?? "```";
      fence = { char: marker[0] ?? "`" };
      addLine(
        lineNumber,
        `cm-live-code-line cm-live-code-fence cm-live-code-start${
          active ? "" : " cm-live-code-fence-hidden"
        }`,
      );
      if (!active) hide(line.from + (opening[1]?.length ?? 0), line.from + opening[0].length);
      continue;
    }

    // ---- horizontal rule -------------------------------------------------
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/u.test(text)) {
      addLine(lineNumber, "cm-live-hr");
      if (!active) {
        replace(line.from, line.to, new HorizontalRuleWidget());
      }
      continue;
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
      addLine(
        lineNumber,
        checked ? "cm-live-task cm-live-task-done" : "cm-live-task",
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
            new TaskWidget(checked, checkFrom, checkTo, view),
          );
        }
      }
    } else {
      const bullet = /^(\s*)([-*+])\s+/u.exec(text);
      if (bullet) {
        addLine(lineNumber, "cm-live-list");
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
          addLine(lineNumber, "cm-live-list cm-live-list-ordered");
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
      occupied.push([start, end]);
    });

    const wikilink = /\[\[([^\]\n]+)\]\]/gu;
    process(wikilink, (match) => {
      const start = line.from + match.index;
      const end = start + match[0].length;
      if (overlaps(start, end)) return;
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
      occupied.push([start, end]);
    });

    const markdownLink = /(!?)\[([^\]\n]+)\]\(([^)\n]+)\)/gu;
    process(markdownLink, (match) => {
      if (match[1] === "!") return; // embedding is deliberately out of scope
      const start = line.from + match.index;
      const end = start + match[0].length;
      if (overlaps(start, end)) return;

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
      occupied.push([start, end]);
    });

    const bold = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/gu;
    process(bold, (match) => {
      const start = line.from + match.index;
      const end = start + match[0].length;
      if (overlaps(start, end)) return;
      const marker = match[1] !== undefined ? "**" : "__";
      const contentFrom = start + marker.length;
      const contentTo = end - marker.length;
      if (!active) {
        hide(start, contentFrom);
        hide(contentTo, end);
      }
      addMark(contentFrom, contentTo, "cm-live-bold");
      occupied.push([start, end]);
    });

    const strike = /~~([^~\n]+)~~/gu;
    process(strike, (match) => {
      const start = line.from + match.index;
      const end = start + match[0].length;
      if (overlaps(start, end)) return;
      if (!active) {
        hide(start, start + 2);
        hide(end - 2, end);
      }
      addMark(start + 2, end - 2, "cm-live-strike");
      occupied.push([start, end]);
    });

    const highlight = /==([^=\n]+)==/gu;
    process(highlight, (match) => {
      const start = line.from + match.index;
      const end = start + match[0].length;
      if (overlaps(start, end)) return;
      if (!active) {
        hide(start, start + 2);
        hide(end - 2, end);
      }
      addMark(start + 2, end - 2, "cm-live-highlight");
      occupied.push([start, end]);
    });

    const italic = /\*([^*\n]+)\*|(?<![\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])/gu;
    process(italic, (match) => {
      const start = line.from + match.index;
      const end = start + match[0].length;
      if (overlaps(start, end)) return;
      const marker = match[1] !== undefined ? "*" : "_";
      const contentFrom = start + marker.length;
      const contentTo = end - marker.length;
      if (!active) {
        hide(start, contentFrom);
        hide(contentTo, end);
      }
      addMark(contentFrom, contentTo, "cm-live-italic");
      occupied.push([start, end]);
    });

    const tag = /(^|[\s([{,])#([\p{L}\p{N}_./-]+)/gu;
    process(tag, (match) => {
      const prefixLength = match[1]?.length ?? 0;
      const start = line.from + match.index + prefixLength;
      const end = line.from + match.index + match[0].length;
      if (overlaps(start, end)) return;
      addMark(start, end, "cm-live-tag");
      occupied.push([start, end]);
    });
  }

  return Decoration.set(ranges, true);
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
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof TaskWidget &&
      other.checked === this.checked &&
      other.checkFrom === this.checkFrom &&
      other.checkTo === this.checkTo
    );
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("label");
    wrapper.className = "cm-live-task-box";
    wrapper.addEventListener("mousedown", (event) => event.stopPropagation());

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-live-task-input";
    input.checked = this.checked;
    input.setAttribute(
      "aria-label",
      this.checked ? "Mark task incomplete" : "Mark task complete",
    );

    const tick = document.createElement("span");
    tick.className = "cm-live-task-tick";

    input.addEventListener("mousedown", (event) => event.stopPropagation());
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
