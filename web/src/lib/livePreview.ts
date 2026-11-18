import {
  StateEffect,
  StateField,
  type EditorState,
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

import { assetKindFromPath } from "./assets";
import { extensionOfPath, viewerTheme } from "../plugins/viewers";
import { mountViewer, type ViewerMount } from "../plugins/viewerMount";
import { MAX_MATH_CHARS, renderMath } from "./latex";
import { normalizeLinkTarget, splitWikilink } from "./markdown";

export type LinkTarget = { title: string; path: string };

export type LivePreviewOptions = {
  linkKeys: Set<string>;
  onWikiLink: (target: string) => void;
  onOpenLink: (url: string) => void;
  onTag: (tag: string) => void;
  onOpenAsset: (assetPath: string) => void;
  /** Viewer plugin for an extension, or null when no plugin handles it. */
  viewerFor: (
    extension: string,
  ) => { id: string; src: string; sandbox: "opaque" | "same-origin" } | null;
  /** Open the lightbox for a viewer-backed asset. */
  onOpenViewer: (assetPath: string, extension: string) => void;
  /** Open an embedded image in the image lightbox. */
  onOpenImage: (target: {
    path: string | null;
    src: string | null;
    alt: string;
  }) => void;
  /** Changes when a text asset is saved, so viewer widgets re-mount. */
  assetRevision: number;
  readOnly: boolean;
  notePath: string;
  loadAsset: (path: string) => Promise<Blob>;
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

/**
 * Last rendered height of an image line, keyed by note + source line. Capped so
 * a long session across many notes cannot grow it without bound.
 */
const imageLineHeights = new Map<string, number>();
const IMAGE_HEIGHT_CACHE_LIMIT = 500;

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

type MathBlockRange = { start: number; end: number; source: string };

const BLOCK_MATH_FENCE = /^\s*\$\$\s*$/u;

/**
 * `$$` fences that sit on their own line, outside fenced code. Anything
 * unclosed stays plain source, so a half-typed block never swallows the note.
 */
function findMathBlocks(
  doc: Text,
  codeBlocks: CodeBlockRange[],
): MathBlockRange[] {
  const inCode = new Set<number>();
  for (const block of codeBlocks) {
    for (let line = block.start; line <= block.end; line += 1) inCode.add(line);
  }

  const blocks: MathBlockRange[] = [];
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    if (inCode.has(lineNumber)) continue;
    if (!BLOCK_MATH_FENCE.test(doc.line(lineNumber).text)) continue;

    let close = 0;
    for (let next = lineNumber + 1; next <= doc.lines; next += 1) {
      if (inCode.has(next)) break;
      if (BLOCK_MATH_FENCE.test(doc.line(next).text)) {
        close = next;
        break;
      }
    }
    if (!close) continue;

    const lines: string[] = [];
    for (let inner = lineNumber + 1; inner < close; inner += 1) {
      lines.push(doc.line(inner).text.trim());
    }
    const source = lines.join("\n");
    if (!source) continue;

    blocks.push({ start: lineNumber, end: close, source });
    lineNumber = close;
  }
  return blocks;
}

/** Mirrors editor focus into the state; block widgets follow it. */
const editorFocus = StateEffect.define<boolean>();

const editorFocusField = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(editorFocus)) return effect.value;
    }
    return value;
  },
});

/**
 * Display-math blocks replace whole lines, and CodeMirror rejects block
 * decorations from a view plugin, so they live in this state field while every
 * inline decoration stays in the plugin below.
 */
function buildMathBlockDecorations(
  state: EditorState,
  focused: boolean,
): DecorationSet {
  const doc = state.doc;
  const editing = new Set<number>();
  if (focused) {
    for (const selection of state.selection.ranges) {
      const first = doc.lineAt(selection.from).number;
      const last = doc.lineAt(selection.to).number;
      for (let line = first; line <= last; line += 1) editing.add(line);
    }
  }

  const ranges: Range<Decoration>[] = [];
  for (const block of findMathBlocks(doc, findCodeBlocks(doc))) {
    let touched = false;
    for (let line = block.start; line <= block.end; line += 1) {
      if (editing.has(line)) touched = true;
    }
    if (touched) continue;
    ranges.push(
      Decoration.replace({
        widget: new MathWidget(block.source, true),
        block: true,
      }).range(doc.line(block.start).from, doc.line(block.end).to),
    );
  }
  return Decoration.set(ranges, true);
}

const mathBlockField = StateField.define<DecorationSet>({
  create: (state) => buildMathBlockDecorations(state, false),
  update(value, transaction) {
    const focusChanged = transaction.effects.some((effect) =>
      effect.is(editorFocus),
    );
    if (
      transaction.docChanged ||
      transaction.selection ||
      focusChanged ||
      transaction.effects.some((effect) => effect.is(refreshLivePreview))
    ) {
      // `editorFocusField` is configured first, so its value is already the
      // new one here.
      return buildMathBlockDecorations(
        transaction.state,
        transaction.state.field(editorFocusField),
      );
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

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
    editorFocusField,
    mathBlockField,
    ViewPlugin.fromClass(LivePreviewPlugin, {
      decorations: (plugin) => plugin.decorations,
    }),
    EditorView.domEventHandlers({
      focus(_event, view) {
        view.dispatch({ effects: editorFocus.of(true) });
        return false;
      },
      blur(_event, view) {
        view.dispatch({ effects: editorFocus.of(false) });
        return false;
      },
      // A tag is a mark, so CodeMirror would move the selection on mousedown
      // and re-render that line as plain source, destroying the mark before a
      // click event could land on it. Open the tag on mousedown instead; the
      // line that is currently being edited shows source rather than a
      // `.cm-live-tag` mark, so its tags stay clickable as text and the cursor
      // still lands there. Modifier clicks fall through so text selection and
      // range operations keep working.
      mousedown(event) {
        if (
          event.button !== 0 ||
          event.shiftKey ||
          event.altKey ||
          event.metaKey ||
          event.ctrlKey
        ) {
          return false;
        }
        return openTagFromEvent(event, optionsRef.current);
      },
    }),
  ];
}

function openTagFromEvent(
  event: MouseEvent,
  options: LivePreviewOptions,
): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  const tagElement = target.closest(".cm-live-tag");
  if (!tagElement) return false;
  const tag = tagElement.textContent?.replace(/^#/u, "").trim();
  if (!tag) return false;
  event.preventDefault();
  event.stopPropagation();
  options.onTag(tag);
  return true;
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
  const codeTextByStart = new Map<number, string>();
  for (const block of codeBlocks) {
    const lines: string[] = [];
    for (let lineNumber = block.start + 1; lineNumber < block.end; lineNumber += 1) {
      lines.push(doc.line(lineNumber).text);
    }
    codeTextByStart.set(block.start, lines.join("\n"));
  }
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

  const mathBlocks = findMathBlocks(doc, codeBlocks);
  const mathBlockByLine = new Map<number, MathBlockRange>();
  for (const block of mathBlocks) {
    for (let line = block.start; line <= block.end; line += 1) {
      mathBlockByLine.set(line, block);
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
      const hasImage = /!\[[^\]\n]*\]\([^)\n]+\)/u.test(text);
      const imageHeight = imageLineHeights.get(
        `${options.notePath}:${line.from}`,
      );
      addLine(
        lineNumber,
        `cm-live-active cm-live-edit${pad > 0 ? " cm-live-hang" : ""}${
          hasImage ? " cm-live-image-edit" : ""
        }`,
        {
          style: `--block-indent:${indent}${
            pad > 0 ? `;--block-pad:${pad}` : ""
          }${imageHeight ? `;--image-block-height:${imageHeight}px` : ""}`,
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

    // Display-math blocks belong to `mathBlockField` (see above): either a
    // rendered block widget or plain source while it is being edited.
    if (mathBlockByLine.has(lineNumber)) continue;

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
      if (!active) {
        ranges.push(
          Decoration.widget({
            widget: new CodeCopyWidget(codeTextByStart.get(lineNumber) ?? ""),
            side: 1,
          }).range(line.to),
        );
      }
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

    // KaTeX typesets `$…$` and `$$…$$`; the source returns as soon as the line
    // is being edited. Inline code ran first, so a `$` inside backticks stays
    // literal, and emphasis runs later, so `_`/`*` inside a formula are kept.
    const math = (
      match: RegExpExecArray,
      content: string,
      display: boolean,
    ) => {
      const start = line.from + match.index;
      const end = start + match[0].length;
      if (insideClaimed(start, end) || overlaps(start, end)) return;
      if (content.length > MAX_MATH_CHARS) return;
      if (!display) {
        // Pandoc's rules keep prose such as "$5 and $10" out of math mode.
        if (/^\s/u.test(content) || /\s$/u.test(content)) return;
        const after = text[match.index + match[0].length] ?? "";
        if (/^[0-9]/u.test(after)) return;
      }
      replace(start, end, new MathWidget(content, display));
      claimed.push([start, end]);
    };

    process(/\$\$([^$\n]+?)\$\$/gu, (match) =>
      math(match, match[1] ?? "", true),
    );
    process(/\$([^$\n]+?)\$/gu, (match) => math(match, match[1] ?? "", false));

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
      const start = line.from + match.index;
      const end = start + match[0].length;
      if (insideClaimed(start, end) || overlaps(start, end)) return;

      const label = match[2] ?? "";
      const url = match[3] ?? "";
      const assetPath = resolveAssetPath(options.notePath, url);
      const assetKind = assetPath ? assetKindFromPath(assetPath) : null;
      const isEmbed = match[1] === "!";

      const viewer = assetPath
        ? options.viewerFor(extensionOfPath(assetPath))
        : null;
      if (isEmbed && assetPath && viewer) {
        if (!active) {
          replace(
            start,
            end,
            new ViewerWidget(
              assetPath,
              extensionOfPath(assetPath),
              viewer,
              options.loadAsset,
              options.onOpenViewer,
              options.assetRevision,
            ),
          );
        }
        claimed.push([start, end]);
        return;
      }

      if (
        assetPath &&
        (!isEmbed || assetKind === "document" || assetKind === "other")
      ) {
        // Files (and plain links to any asset) open in the asset view instead
        // of being embedded; keeps pdfs, office docs and archives out of the
        // editor surface.
        if (!active) {
          replace(
            start,
            end,
            new AssetFileWidget(
              assetPath,
              label || assetPath.split("/").pop() || assetPath,
              assetKind ?? "other",
              options.onOpenAsset,
            ),
          );
        } else {
          addMark(start, end, "cm-live-link");
        }
        claimed.push([start, end]);
        return;
      }

      if (isEmbed) {
        if (!active) {
          const media = assetPath
            ? mediaWidget(assetPath, assetKind, label, options, view, line)
            : null;
          replace(
            start,
            end,
            media ??
              new ImageWidget(
                url,
                label,
                assetPath,
                options.loadAsset,
                view,
                options.notePath,
                line.from,
                line.to,
                options.onOpenImage,
              ),
          );
        }
        claimed.push([start, end]);
        return;
      }

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

    // ---- bare URLs -------------------------------------------------------
    // Recognize typed links the way Obsidian does: `https://…` and `www.…`
    // become clickable without wrapping them in markdown. Markdown links,
    // images, wikilinks and code spans were claimed above, so their URLs are
    // never matched twice.
    if (!active) {
      const bareUrl = /(?:https?:\/\/|www\.)[^\s<>"'`\]]+/giu;
      process(bareUrl, (match) => {
        const start = line.from + match.index;
        const end = start + match[0].length;
        if (insideClaimed(start, end) || overlaps(start, end)) return;
        const display = trimUrlTrailing(match[0]);
        if (!display) return;
        const trimmedEnd = start + display.length;
        const url = /^www\./iu.test(display) ? `https://${display}` : display;
        replace(
          start,
          trimmedEnd,
          new ExternalLinkWidget(display, url, options.onOpenLink),
        );
        claimed.push([start, trimmedEnd]);
      });
    }

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

function normalizePosixPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/** Drop sentence punctuation glued to the end of a bare URL. */
function trimUrlTrailing(value: string): string {
  let url = value;
  for (;;) {
    const trimmed = url.replace(/[.,;:!?…"'”’]+$/u, "");
    // A closing paren/bracket only belongs to the URL when it is balanced.
    const last = trimmed.at(-1);
    if (last === ")" || last === "]" || last === "}") {
      const open = last === ")" ? "(" : last === "]" ? "[" : "{";
      const opens = trimmed.split(open).length - 1;
      const closes = trimmed.split(last).length - 1;
      if (closes > opens) {
        url = trimmed.slice(0, -1);
        continue;
      }
    }
    return trimmed;
  }
}

function resolveAssetPath(notePath: string, src: string): string | null {
  const raw = src.trim().replace(/^<|>$/gu, "");
  if (/^(https?:|data:|blob:)/iu.test(raw)) return null;
  let path = raw.split(/[?#]/u)[0] ?? "";
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw path if it is not valid percent-encoding.
  }
  if (path.startsWith("/assets/")) return path.slice("/assets/".length);
  if (path.startsWith("assets/")) return path.slice("assets/".length);
  const base = notePath.split("/").slice(0, -1).join("/");
  const resolved = normalizePosixPath(`${base}/${path}`);
  return resolved.startsWith("assets/")
    ? resolved.slice("assets/".length)
    : null;
}

type MediaKind = ReturnType<typeof assetKindFromPath>;

/** Video/audio embeds; other asset kinds fall back to the file row widget. */
function mediaWidget(
  assetPath: string,
  kind: MediaKind | null,
  label: string,
  options: LivePreviewOptions,
  view: EditorView,
  line: { from: number; to: number },
): WidgetType | null {
  if (kind === "video") {
    return new MediaWidget(
      "video",
      assetPath,
      label,
      options.loadAsset,
      view,
      line.to,
    );
  }
  if (kind === "audio") {
    return new MediaWidget(
      "audio",
      assetPath,
      label,
      options.loadAsset,
      view,
      line.to,
    );
  }
  return null;
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

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly assetPath: string | null,
    readonly loadAsset: (path: string) => Promise<Blob>,
    readonly view: EditorView,
    readonly notePath: string,
    readonly lineFrom: number,
    readonly lineTo: number,
    readonly onOpenImage: (target: {
      path: string | null;
      src: string | null;
      alt: string;
    }) => void,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof ImageWidget &&
      other.src === this.src &&
      other.alt === this.alt &&
      other.assetPath === this.assetPath &&
      other.notePath === this.notePath &&
      other.lineFrom === this.lineFrom &&
      other.lineTo === this.lineTo
    );
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-live-image";
    // A plain click enlarges the picture; Alt/Option-click keeps the old
    // behaviour of dropping the caret into the source for editing, which is the
    // only way into an image-only line.
    wrapper.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.altKey) {
        this.onOpenImage({
          path: this.assetPath,
          src: this.assetPath ? null : this.src,
          alt: this.alt,
        });
        return;
      }
      reportHeight();
      this.view.dispatch({ selection: { anchor: this.lineTo } });
      this.view.focus();
    });
    wrapper.title = "Click to enlarge · Alt-click to edit the source";
    const image = document.createElement("img");
    image.alt = this.alt;
    image.loading = "lazy";
    wrapper.appendChild(image);

    const reportHeight = () => {
      if (!wrapper.isConnected) return;
      const line = wrapper.closest<HTMLElement>(".cm-line");
      if (!line || line.classList.contains("cm-live-active")) return;
      const height = line.getBoundingClientRect().height;
      const key = `${this.notePath}:${this.lineFrom}`;
      if (height > (imageLineHeights.get(key) ?? 0)) {
        if (imageLineHeights.size >= IMAGE_HEIGHT_CACHE_LIMIT) {
          imageLineHeights.clear();
        }
        imageLineHeights.set(key, height);
      }
    };
    image.addEventListener("load", () => {
      window.requestAnimationFrame(reportHeight);
    });
    window.requestAnimationFrame(reportHeight);

    if (/^(https?:|data:|blob:)/iu.test(this.src)) {
      image.src = this.src;
    } else if (this.assetPath) {
      void this.loadAsset(this.assetPath)
        .then((blob) => {
          if (!wrapper.isConnected) return;
          const url = URL.createObjectURL(blob);
          wrapper.dataset.objectUrl = url;
          image.src = url;
        })
        .catch(() => {
          image.remove();
          wrapper.classList.add("is-error");
          wrapper.textContent = this.alt || "Image unavailable";
        });
    } else {
      image.remove();
      wrapper.classList.add("is-error");
      wrapper.textContent = this.alt || "Image unavailable";
    }

    return wrapper;
  }

  destroy(dom: HTMLElement): void {
    const url = dom.dataset.objectUrl;
    if (url) URL.revokeObjectURL(url);
  }
}

/**
 * Video/audio embed. The player keeps its native controls, so pointer events
 * stop at the wrapper instead of reaching CodeMirror's selection handling;
 * clicking the line outside the player still reveals the markdown source.
 */
class MediaWidget extends WidgetType {
  constructor(
    readonly tag: "video" | "audio",
    readonly assetPath: string,
    readonly label: string,
    readonly loadAsset: (path: string) => Promise<Blob>,
    readonly view: EditorView,
    readonly lineTo: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof MediaWidget &&
      other.tag === this.tag &&
      other.assetPath === this.assetPath &&
      other.label === this.label &&
      other.lineTo === this.lineTo
    );
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = `cm-live-media cm-live-${this.tag}`;
    wrapper.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });

    const media = document.createElement(this.tag);
    media.controls = true;
    media.preload = "metadata";
    media.setAttribute("aria-label", this.label || this.tag);
    if (this.tag === "audio") media.className = "cm-live-audio-player";
    else (media as HTMLVideoElement).playsInline = true;
    wrapper.appendChild(media);

    void this.loadAsset(this.assetPath)
      .then((blob) => {
        if (!wrapper.isConnected) return;
        const url = URL.createObjectURL(blob);
        wrapper.dataset.objectUrl = url;
        media.src = url;
      })
      .catch(() => {
        media.remove();
        wrapper.classList.add("is-error");
        wrapper.textContent = this.label || `${this.tag} unavailable`;
      });

    return wrapper;
  }

  destroy(dom: HTMLElement): void {
    const media = dom.firstElementChild;
    if (media instanceof HTMLMediaElement) media.pause();
    const url = dom.dataset.objectUrl;
    if (url) URL.revokeObjectURL(url);
  }
}

const ASSET_ICONS: Record<string, string> = {
  image:
    '<path d="M3 5h18v14H3z"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m5 17 4.5-4.5L13 16l2.5-2.5L21 19"/>',
  video:
    '<path d="M3 6h13v12H3z"/><path d="m16 12 5-3v6l-5-3"/>',
  audio:
    '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  document:
    '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  other:
    '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
};

function assetIcon(kind: MediaKind): string {
  const path = ASSET_ICONS[kind] ?? ASSET_ICONS.other;
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

const ASSET_KIND_LABELS: Record<string, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  document: "File",
  other: "File",
};

/**
 * Non-media asset reference (pdf, office docs, archives, and plain links to any
 * asset). Renders an icon plus the file name and opens the asset view.
 */
class AssetFileWidget extends WidgetType {
  constructor(
    readonly assetPath: string,
    readonly label: string,
    readonly kind: MediaKind,
    readonly onOpenAsset: (assetPath: string) => void,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof AssetFileWidget &&
      other.assetPath === this.assetPath &&
      other.label === this.label &&
      other.kind === this.kind
    );
  }

  ignoreEvent(): boolean {
    return false;
  }

  toDOM(): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-live-file";
    button.title = `Open assets/${this.assetPath}`;
    const label = document.createElement("span");
    label.className = "cm-live-file-name";
    label.textContent = this.label;
    const kind = document.createElement("span");
    kind.className = "cm-live-file-kind";
    kind.textContent = ASSET_KIND_LABELS[this.kind] ?? "File";
    button.insertAdjacentHTML("afterbegin", assetIcon(this.kind));
    button.append(label, kind);
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onOpenAsset(this.assetPath);
    });
    return button;
  }
}

/**
 * Sandboxed viewer embed (`viewer` plugin, read mode). The iframe mounts lazily
 * when it scrolls into view, sizes itself from `resize` messages, and asks the
 * host to open the lightbox on click.
 */
class ViewerWidget extends WidgetType {
  constructor(
    readonly assetPath: string,
    readonly extension: string,
    readonly viewer: {
      id: string;
      src: string;
      sandbox: "opaque" | "same-origin";
    },
    readonly loadAsset: (path: string) => Promise<Blob>,
    readonly onOpenViewer: (assetPath: string, extension: string) => void,
    readonly revision: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof ViewerWidget &&
      other.assetPath === this.assetPath &&
      other.extension === this.extension &&
      other.viewer.id === this.viewer.id &&
      other.revision === this.revision
    );
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-live-viewer";
    wrapper.dataset.state = "loading";
    wrapper.style.height = "9rem";

    let mount: ViewerMount | null = null;
    let observer: IntersectionObserver | null = null;
    let destroyed = false;
    let appliedWidth = 0;

    const start = () => {
      void this.loadAsset(this.assetPath)
        .then((blob) => blob.text())
        .then((content) => {
          if (destroyed || !wrapper.isConnected) return;
          wrapper.dataset.state = "ready";
          mount = mountViewer(wrapper, {
            src: this.viewer.src,
            sandbox: this.viewer.sandbox,
            mode: "read",
            content,
            extension: this.extension,
            theme: viewerTheme(),
            onResize: (height, width) => {
              wrapper.style.height = `${Math.min(height, 520)}px`;
              // Constrain the frame to the diagram's own width instead of
              // spanning the whole line; `max-width: 100%` clamps wider ones.
              if (width > 0 && Math.abs(width - appliedWidth) > 4) {
                appliedWidth = width;
                wrapper.style.width = `${width + 2}px`;
              }
            },
            onOpen: () => this.onOpenViewer(this.assetPath, this.extension),
            onError: (message, reason) => {
              wrapper.dataset.state = "error";
              wrapper.title = message;
              // Pele renders parser errors inside the frame; only a frame that
              // never started needs a host-side message.
              if (reason === "timeout") wrapper.textContent = message;
            },
          });
        })
        .catch((cause) => {
          if (destroyed) return;
          wrapper.dataset.state = "error";
          wrapper.textContent =
            cause instanceof Error ? cause.message : "Could not load the drawing";
        });
    };

    observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer?.disconnect();
        observer = null;
        start();
      },
      { rootMargin: "400px" },
    );
    // CodeMirror inserts the wrapper after `toDOM` returns.
    window.requestAnimationFrame(() => {
      if (wrapper.isConnected) observer?.observe(wrapper);
    });

    const cleanup = () => {
      destroyed = true;
      observer?.disconnect();
      observer = null;
      mount?.destroy();
      mount = null;
    };
    (wrapper as HTMLElement & { viewerCleanup?: () => void }).viewerCleanup =
      cleanup;
    return wrapper;
  }

  destroy(dom: HTMLElement): void {
    (dom as HTMLElement & { viewerCleanup?: () => void }).viewerCleanup?.();
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly display: boolean,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof MathWidget &&
      other.source === this.source &&
      other.display === this.display
    );
  }

  toDOM(): HTMLElement {
    const host = document.createElement(this.display ? "div" : "span");
    host.className = `cm-live-math${this.display ? " cm-live-math-display" : ""}`;
    const rendered = renderMath(this.source, this.display);
    if (rendered.error) {
      host.classList.add("is-error");
      host.title = rendered.error;
      host.textContent = this.display
        ? `$$\n${this.source}\n$$`
        : `$${this.source}$`;
      return host;
    }
    host.innerHTML = rendered.html;
    return host;
  }

  /** A click places the caret in the source, which reveals it for editing. */
  ignoreEvent(): boolean {
    return false;
  }
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

  ignoreEvent(): boolean {
    return false;
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
    element.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const down = { x: event.clientX, y: event.clientY };
      const onUp = (up: MouseEvent) => {
        if (
          up.button !== 0 ||
          Math.hypot(up.clientX - down.x, up.clientY - down.y) > 5
        ) {
          return;
        }
        open(up);
      };
      window.addEventListener("mouseup", onUp, { once: true, capture: true });
    });
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

  ignoreEvent(): boolean {
    return false;
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
    element.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const down = { x: event.clientX, y: event.clientY };
      const onUp = (up: MouseEvent) => {
        if (
          up.button !== 0 ||
          Math.hypot(up.clientX - down.x, up.clientY - down.y) > 5
        ) {
          return;
        }
        open(up);
      };
      window.addEventListener("mouseup", onUp, { once: true, capture: true });
    });
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

class CodeCopyWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof CodeCopyWidget && other.code === this.code;
  }

  toDOM(): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-code-copy";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy code");
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(this.code);
        button.textContent = "Copied";
        window.setTimeout(() => {
          button.textContent = "Copy";
        }, 1200);
      } catch {
        button.textContent = "Failed";
        window.setTimeout(() => {
          button.textContent = "Copy";
        }, 1200);
      }
    });
    return button;
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
