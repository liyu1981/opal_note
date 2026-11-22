/**
 * Block affordances for the live editor (doc/blocks.md R1).
 *
 * Nothing here writes metadata into the markdown: a block is a line range, the
 * handle lives in the gutter, folding is a decoration and dragging is a normal
 * document edit. Blocks are re-derived from the document on every change, just
 * as the server derives them on save.
 */
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  StateEffect,
  StateField,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";

import { parseBlocks, type NoteBlock } from "../../lib/blocks";

export type BlockHandlesOptions = {
  readOnly: boolean;
  /** Copy a deep link to this block (`?p=…&block=<hash>&at=<seq>`). */
  onCopyLink: (block: NoteBlock) => void;
};

const toggleFolded = StateEffect.define<number>();

/**
 * CodeMirror rejects block decorations from a view plugin, so the decorations
 * live in a state field; widgets read the live view from here when they need to
 * dispatch (menu actions, drag).
 */
let currentView: EditorView | null = null;

const viewHolder = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      currentView = view;
    }

    update(update: ViewUpdate) {
      currentView = update.view;
    }

    destroy() {
      currentView = null;
    }
  },
);

function blocksOf(doc: Text): NoteBlock[] {
  return parseBlocks(doc.toString());
}

const foldedField = StateField.define<Set<number>>({
  create: () => new Set<number>(),
  update(value, transaction) {
    if (transaction.docChanged) {
      // Line numbers moved: keep only folds that still point at a block start.
      const starts = new Set(blocksOf(transaction.state.doc).map((block) => block.startLine));
      const kept = new Set<number>();
      for (const start of value) if (starts.has(start)) kept.add(start);
      return kept;
    }
    for (const effect of transaction.effects) {
      if (!effect.is(toggleFolded)) continue;
      const next = new Set(value);
      if (next.has(effect.value)) next.delete(effect.value);
      else next.add(effect.value);
      return next;
    }
    return value;
  },
});

class FoldChip extends WidgetType {
  constructor(readonly hiddenLines: number) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof FoldChip && other.hiddenLines === this.hiddenLines;
  }

  toDOM(): HTMLElement {
    const chip = document.createElement("span");
    chip.className = "cm-block-fold-chip";
    chip.textContent = `… ${this.hiddenLines} ${this.hiddenLines === 1 ? "line" : "lines"}`;
    return chip;
  }
}

class BlockHandle extends WidgetType {
  constructor(
    readonly block: NoteBlock,
    readonly folded: boolean,
    readonly options: BlockHandlesOptions,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof BlockHandle &&
      other.block.seq === this.block.seq &&
      other.block.hash === this.block.hash &&
      other.folded === this.folded
    );
  }

  toDOM(): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-block-handle";
    button.setAttribute("aria-label", `Block actions: ${this.block.kind}`);
    button.title = "Block actions — drag to move";
    button.textContent = this.folded ? "▸" : "⋮";
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const view = currentView;
      if (view) openBlockMenu(button, this.block, this.folded, this.options, view);
    });
    button.addEventListener("pointerdown", (event) => {
      const view = currentView;
      if (event.button !== 0 || this.options.readOnly || !view) return;
      startBlockDrag(event, button, this.block, view);
    });
    return button;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

type DragState = {
  pointerId: number;
  block: NoteBlock;
  startY: number;
  active: boolean;
  target: { line: number; after: boolean } | null;
  indicator: HTMLElement;
  handle: HTMLElement;
  view: EditorView;
  onMove: (event: PointerEvent) => void;
  onEnd: (event: PointerEvent) => void;
};

let dragState: DragState | null = null;

function startBlockDrag(
  event: PointerEvent,
  handle: HTMLElement,
  block: NoteBlock,
  view: EditorView,
): void {
  const indicator = document.createElement("div");
  indicator.className = "cm-block-drop";
  indicator.hidden = true;
  view.dom.appendChild(indicator);

  const onMove = (moveEvent: PointerEvent) => {
    const state = dragState;
    if (!state || state.pointerId !== moveEvent.pointerId) return;
    if (!state.active && Math.abs(moveEvent.clientY - state.startY) < 6) return;
    state.active = true;
    handle.classList.add("is-dragging");
    const target = dropTarget(view, moveEvent.clientY, block);
    state.target = target;
    if (target === null) {
      indicator.hidden = true;
      return;
    }
    const line = view.state.doc.line(
      Math.min(view.state.doc.lines, Math.max(1, target.line)),
    );
    const coords = view.coordsAtPos(line.from);
    const host = view.dom.getBoundingClientRect();
    indicator.hidden = false;
    indicator.style.top = `${(coords?.top ?? host.top) - host.top}px`;
    indicator.dataset.after = target.after ? "true" : "false";
  };

  const onEnd = (upEvent: PointerEvent) => {
    const state = dragState;
    if (!state || state.pointerId !== upEvent.pointerId) return;
    dragState = null;
    handle.classList.remove("is-dragging");
    indicator.remove();
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onEnd);
    handle.removeEventListener("pointercancel", onEnd);
    if (!state.active || state.target === null) return;
    moveBlock(view, block, state.target);
  };

  dragState = {
    pointerId: event.pointerId,
    block,
    startY: event.clientY,
    active: false,
    target: null,
    indicator,
    handle,
    view,
    onMove,
    onEnd,
  };
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // The pointer is already gone (or the event was synthesized).
  }
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onEnd);
  handle.addEventListener("pointercancel", onEnd);
}

/** The block boundary nearest to the pointer, or the drag is a no-op. */
function dropTarget(
  view: EditorView,
  clientY: number,
  source: NoteBlock,
): { line: number; after: boolean } | null {
  const pos = view.posAtCoords({ x: 24, y: clientY }, false);
  if (pos === null) return null;
  const line = view.state.doc.lineAt(pos).number;
  if (line >= source.startLine && line <= source.endLine) return null;
  // Ranges can nest (an ordered sub-list inside an item), so the innermost
  // block under the pointer is the one being dropped next to.
  let target: NoteBlock | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const block of blocksOf(view.state.doc)) {
    if (line < block.startLine || line > block.endLine) continue;
    const span = block.endLine - block.startLine;
    if (span < bestSpan) {
      target = block;
      bestSpan = span;
    }
  }
  if (!target) return null;
  const after = line > (target.startLine + target.endLine) / 2;
  return { line: after ? target.endLine : target.startLine, after };
}

/** Move a block's lines next to another block in one transaction. */
function moveBlock(
  view: EditorView,
  block: NoteBlock,
  target: { line: number; after: boolean },
): void {
  const doc = view.state.doc;
  const from = doc.line(block.startLine).from;
  const to = doc.line(block.endLine).to;
  const targetLine = doc.line(
    Math.min(doc.lines, Math.max(1, target.line)),
  );
  const insertAt = target.after ? targetLine.to : targetLine.from;
  if (insertAt >= from && insertAt <= to) return;

  const text = doc.sliceString(from, to);
  const insert = target.after ? `\n${text}` : `${text}\n`;
  view.dispatch({
    changes: [
      { from: insertAt, insert },
      { from, to, insert: "" },
    ],
    userEvent: "move",
  });
}

function openBlockMenu(
  anchor: HTMLElement,
  block: NoteBlock,
  folded: boolean,
  options: BlockHandlesOptions,
  view: EditorView,
): void {
  document.querySelector(".cm-block-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "cm-block-menu";

  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", dismiss, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const dismiss = (event: Event) => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    close();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  const item = (label: string, action: () => void) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      close();
      action();
    });
    menu.appendChild(button);
  };

  item("Copy link", () => options.onCopyLink(block));
  item(folded ? "Unfold" : "Fold", () => {
    view.dispatch({ effects: toggleFolded.of(block.startLine) });
  });
  item("Move up", () => {
    const previous = previousBlock(view.state.doc, block);
    if (previous) moveBlock(view, block, { line: previous.startLine, after: false });
  });
  item("Move down", () => {
    const next = nextBlock(view.state.doc, block);
    if (next) moveBlock(view, block, { line: next.endLine, after: true });
  });
  if (!options.readOnly) {
    item("Delete block", () => deleteBlock(view, block));
  }

  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 180))}px`;
  document.body.appendChild(menu);
  window.setTimeout(() => {
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
}

function previousBlock(doc: Text, block: NoteBlock): NoteBlock | null {
  const blocks = blocksOf(doc);
  return (
    blocks.find((candidate) => candidate.endLine < block.startLine) ?? null
  );
}

function nextBlock(doc: Text, block: NoteBlock): NoteBlock | null {
  const blocks = blocksOf(doc);
  return blocks.find((candidate) => candidate.startLine > block.endLine) ?? null;
}

/** Remove a block's lines together with one separating blank line. */
function deleteBlock(view: EditorView, block: NoteBlock): void {
  const doc = view.state.doc;
  const startLine = doc.line(block.startLine);
  let from = startLine.from;
  const endLine = doc.line(Math.min(doc.lines, block.endLine + 1));
  let to = endLine.to;
  // Collapse the separator on both sides so deleting a paragraph does not leave
  // two blank lines behind.
  const before = block.startLine > 1 ? doc.line(block.startLine - 1) : null;
  if (
    before !== null &&
    before.text.trim() === "" &&
    block.endLine < doc.lines &&
    doc.line(block.endLine + 1).text.trim() === ""
  ) {
    from = before.from;
  }
  view.dispatch({
    changes: { from, to, insert: "" },
    userEvent: "delete",
  });
}

/** Tab / Shift-Tab indent list blocks by two spaces. */
function indentListBlock(view: EditorView, outdent: boolean): boolean {
  const { from, to } = view.state.selection.main;
  const first = view.state.doc.lineAt(from).number;
  const last = view.state.doc.lineAt(to).number;
  const changes: Array<{ from: number; to?: number; insert: string }> = [];
  for (let lineNumber = first; lineNumber <= last; lineNumber += 1) {
    const line = view.state.doc.line(lineNumber);
    if (!/^(\s*)([-*+]|\d+[.)])\s+/u.test(line.text)) return false;
    if (outdent) {
      const spaces = /^ {1,2}/u.exec(line.text)?.[0].length ?? 0;
      const tabs = spaces === 0 && line.text.startsWith("\t") ? 1 : 0;
      const width = spaces || tabs;
      if (width > 0) {
        changes.push({ from: line.from, to: line.from + width, insert: "" });
      }
    } else {
      changes.push({ from: line.from, insert: "  " });
    }
  }
  if (changes.length === 0) return outdent;
  view.dispatch({ changes, userEvent: outdent ? "delete" : "input" });
  return true;
}

const blockTheme = EditorView.baseTheme({
  ".cm-line": { position: "relative" },
  ".cm-block-handle": {
    position: "absolute",
    left: "-1.35rem",
    top: "50%",
    transform: "translateY(-50%)",
    width: "1.1rem",
    height: "1.1rem",
    display: "none",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid var(--color-line)",
    borderRadius: "3px",
    background: "var(--color-paper)",
    color: "var(--color-faint)",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    lineHeight: "1",
    cursor: "grab",
    padding: "0",
    zIndex: "4",
  },
  ".cm-line:hover > .cm-block-handle, .cm-block-handle:focus-visible, .cm-block-handle.is-dragging":
    { display: "inline-flex" },
  ".cm-block-menu": {
    position: "fixed",
    zIndex: "80",
    minWidth: "10rem",
    display: "flex",
    flexDirection: "column",
    padding: "3px",
    gap: "1px",
    border: "1px solid var(--color-line)",
    borderRadius: "4px",
    background: "var(--color-paper)",
    boxShadow: "var(--shadow-panel, 0 8px 24px rgba(0,0,0,0.12))",
    fontFamily: "var(--font-sans, system-ui)",
    fontSize: "13px",
  },
  ".cm-block-menu button": {
    textAlign: "left",
    padding: "4px 8px",
    borderRadius: "3px",
    color: "var(--color-ink-soft)",
    background: "transparent",
    border: "0",
    cursor: "pointer",
  },
  ".cm-block-menu button:hover": {
    background: "var(--color-panel)",
    color: "var(--color-ink)",
  },
  ".cm-block-fold-chip": {
    display: "inline-block",
    marginLeft: "0.35rem",
    padding: "0 0.35rem",
    border: "1px solid var(--color-line)",
    borderRadius: "3px",
    background: "var(--color-panel)",
    color: "var(--color-faint)",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
  },
  ".cm-block-drop": {
    position: "absolute",
    left: "0",
    right: "0",
    height: "2px",
    background: "var(--color-accent)",
    pointerEvents: "none",
    zIndex: "6",
  },
});

export function blockHandles(options: BlockHandlesOptions): Extension {
  const blockField = StateField.define<DecorationSet>({
    create: (state) => buildDecorations(state.doc, state.field(foldedField), options),
    update(value, transaction) {
      if (
        transaction.docChanged ||
        transaction.effects.some((effect) => effect.is(toggleFolded))
      ) {
        return buildDecorations(
          transaction.state.doc,
          transaction.state.field(foldedField),
          options,
        );
      }
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  return [
    foldedField,
    viewHolder,
    blockField,
    blockTheme,
    keymap.of([
      {
        key: "Tab",
        run: (view) => indentListBlock(view, false),
        shift: (view) => indentListBlock(view, true),
      },
    ]),
  ];
}

function buildDecorations(
  doc: Text,
  folded: Set<number>,
  options?: BlockHandlesOptions,
): DecorationSet {
  const blocks = blocksOf(doc);
  const ranges: Range<Decoration>[] = [];
  const foldedRanges = blocks
    .filter((block) => folded.has(block.startLine) && block.endLine > block.startLine)
    .map((block) => ({ start: block.startLine, end: block.endLine }));

  for (const block of blocks) {
    const hidden = foldedRanges.some(
      (range) => block.startLine > range.start && block.startLine <= range.end,
    );
    // Fenced blocks start with a collapsed fence line, so their handle hangs on
    // the first visible line — except while folded, where that line is hidden
    // and the handle has to stay on the block's first line so it can unfold.
    const isFenceBlock = block.kind === "code" || block.kind === "math";
    const handleLineNumber =
      isFenceBlock && block.endLine > block.startLine && !folded.has(block.startLine)
        ? block.startLine + 1
        : block.startLine;
    const handleLine = doc.line(
      Math.min(doc.lines, Math.max(1, handleLineNumber)),
    );
    if (!hidden && options) {
      ranges.push(
        Decoration.widget({
          widget: new BlockHandle(block, folded.has(block.startLine), options),
          side: -1,
        }).range(handleLine.from),
      );
    }

    if (folded.has(block.startLine) && block.endLine > block.startLine) {
      // Block decorations must cover whole lines: keep the block's first line
      // and replace the rest with the fold chip.
      const hiddenFrom = doc.line(
        Math.min(doc.lines, Math.max(1, block.startLine + 1)),
      );
      const hiddenTo = doc.line(
        Math.min(doc.lines, Math.max(1, block.endLine)),
      );
      ranges.push(
        Decoration.replace({
          block: true,
          widget: new FoldChip(block.endLine - block.startLine),
        }).range(hiddenFrom.from, hiddenTo.to),
      );
    }
  }

  return Decoration.set(ranges, true);
}
