# Blocks: identification and indexing

Design for a Notion-style **typed block** model built on plain markdown. It is
split into two releases because they carry very different costs:

- **R1 — blocks without identity (committed scope).** Blocks are derived from the
  body and indexed by position, with handles, folding, dragging, block search and
  hash-based deep links. **Nothing is ever written into the markdown**, so there is
  zero syntax pollution and no new authoring rules.
- **R2 — persistent references (deferred).** `((refs))`, embeds and block-level
  backlinks need a stable identity, and every placement of that identity token has
  a real cost (see [R2](#r2--persistent-references-deferred)). Needs its own
  design review before any of it ships.

Status: **R1 is implemented** — parser, `block` index relation, the three read
routes, gutter handles with fold / drag / delete, Tab indentation, and
`?block=<hash>&at=<seq>` deep links all ship, and the OmniBar lists block hits
under its note hits. R2 (references) is untouched and still
needs its own review.

## Why blocks

Today nothing in OpalNote is a block. The index has five relations —
`notebook`, `note`, `note_tag`, `link`, `task` — and only `task` is even
line-scoped: it is keyed by `(notebook_id, note_path, line)` and rebuilt on every
save, so inserting a line renumbers every task below it. There is no block parser
(`src/store/markdown.rs` parses titles, wikilinks, tags, frontmatter, summaries
and tasks only), no `/blocks` endpoint and no block syntax anywhere in the tree.

R1 adds the interaction layer people know from Notion/Obsidian — drag a block,
fold it, delete it, link to it, search it — while leaving the file exactly as the
author wrote it.

## What R1 needs identity for (nothing)

| Feature | R1 mechanism |
| --- | --- |
| gutter handle, fold, drag, delete | line range in the open document |
| block search, jump to block | derived `seq` + content hash |
| deep link to a block | content hash resolved through the index |
| block backlinks, `((refs))`, embeds | **out of scope — R2** |

## 1. Block grammar

A block is `(start_line, end_line)` **inside the note body** (frontmatter is not
part of any block), plus `kind`, `depth` and `parent`.

- **Doc mode** — one CommonMark leaf-or-container element: paragraph, heading,
  fenced code, table, blockquote, thematic break, and **each list item**
  (indented children become separate child blocks).
- **Outline mode** — one bullet line (`- `, `* `, `+ `) = one block, children by
  indentation (`depth`), `parent` = nearest preceding bullet with smaller indent.
  A blank line ends the current block's *content*, not the tree (Logseq's rule).
- **Mode detection** — per note, a note whose bullet lines exceed ~60% is an
  outline. The imported corpus splits 64 outline / 127 doc notes.
- **Delimiter — one blank line**, not two. Measured over the 196 notes in
  `data/notebooks`:

  | rule | blocks | median/note | notes with >1 block |
  | --- | --- | --- | --- |
  | a **double** blank line ends a block | 191 | 1 | **0** |
  | one blank line ends a unit; each bullet its own block; fences whole | 1672 | 5 | **187** |

  Paragraph breaks in that corpus: **79 use one blank line, 0 use two**. A
  double-blank rule would leave every existing note a single block, and importers
  (Notion, Obsidian, Logseq exports) all use one blank line.
- **Atomic constructs** — never split inside a fenced code block, table,
  blockquote or HTML block. 20 corpus notes contain fenced code; 128 contain
  nested bullets.
- **One grammar, two runtimes (since the shared parser landed).** The block list
  is derived from the `lutez` CommonMark/GFM AST — the same parse the browser gets
  from `lutez.wasm` — by the adapters in `src/store/markdown.rs`
  (`mod lutez_ast`) and `web/src/lib/lutez/parse.ts`. They must be changed
  together and re-checked with `cargo test corpus_parity -- --ignored
  --nocapture`. Concretely:
  - one block per **list item at any depth** (a child item is its own block and
    does not overlap its parent), plus one per top-level paragraph, heading,
    fenced/indented code block, blockquote, table, thematic break, HTML block and
    `$$` math block;
  - a fence written as a list item's content (`- ```js … ``` `) is that item's
    `code` block, spanning the item;
  - a blockquote that starts on the item's marker line (`- > quote`) splits into
    the item (marker line) plus a `quote` block for the continuation lines;
  - a fence/quote/table/heading that starts on a **continuation** line under an
    item is hoisted to its own block, as the editor renders it outside the item;
  - CommonMark decides the edge cases the old line scanner guessed at: a bare
    `-` is an empty `list_item` (not a paragraph), 4-space indented text is a
    `code` block (not prose), and `- 1) x` nests an ordered sub-list;
  - `parent_seq` is the enclosing item's **`seq`** (the client always meant
    this; the legacy server wrote the parent's start line);
  - block `text` and `hash` are still produced from the raw line range with
    `block_text`, so a block whose range and kind did not move keeps its hash
    (and its deep links).

## 2. Index model

Derived and disposable — no migration of user data, and `DELETE data/index/` stays
safe.

```datalog
:create block {
    notebook_id: String, note_path: String, seq: Int
    =>
    start_line: Int, end_line: Int,
    kind: String, depth: Int, parent_seq: Int,
    text: String, hash: String,
    updated_at: Float
}
```

- `seq` is the block's 1-based position in the note; `parent_seq` links outline
  children (0 for top-level blocks).
- `hash` is a short digest (32-bit FNV-1a, 8 hex chars) of the block text with
  whitespace collapsed and markup-insensitive trailing punctuation removed — the
  identity used by deep links and by drift detection. `web/src/lib/blocks.ts`
  implements the same function, so a link can be built without a round-trip.
- Built in `sync_notebook_locked` beside `task`, through the same `run_atomic`
  batch (delete the note's rows, insert the parsed ones). One `parse_content()`
  pass in `src/store/markdown.rs` supplies blocks, tasks, tags and links
  (`parse_blocks()` is the test-facing view of its `blocks` field); all CozoScript
  stays in `src/store/queries.rs`.
- Indexes: `block:by_note {notebook_id, note_path}` and `block:by_hash
  {notebook_id, note_path, hash}`.
- Rule changes bump a `blocks.rules` marker under `data/index/`, exactly like
  `tasks.rules`, forcing one full re-read. `BLOCK_RULES_VERSION` is **2** since
  the AST grammar replaced the line scanner.
- Scale: 1.7k blocks for 196 notes today; parsing is linear and per-save, the same
  order of work as tasks.

## 3. API

| Route | Purpose |
| --- | --- |
| `GET /notebooks/{id}/blocks?path={path}` | ordered blocks (seq, range, kind, depth, parent, hash) for the editor and external tools |
| `GET /notebooks/{id}/block?path={path}&hash={hash}&seq={seq}` | resolve a deep link: exact block, or the block at the recorded position with `exact: false` when the text drifted |
| `GET /notebooks/{id}/block-search?q={q}&limit={n}` | block hits across the notebook, for search rows |
| `GET /notebooks/{id}/notes/{path}` | unchanged; blocks are fetched separately so the note payload stays lean |

No write routes: R1 never mutates a note on behalf of a block operation except
through the normal editor save (drag and fold are document edits).

## 4. Client

- **Shared parser** — `web/src/lib/blocks.ts` mirrors the Rust rules, kept in step
  by a parity corpus like the one guarding `taskSignature` (same fixture through
  both, compared row by row).
- **Gutter handle** — hover reveals a handle left of the block (drag, fold, copy
  link, delete). Decorations come from a `StateField` (`blockField`), the pattern
  already used for display math, because CodeMirror rejects block decorations from
  view plugins.
- **Fold** — `Decoration.replace({ block: true, widget })` with a `…` chip;
  clicking or Enter on a line inside the range unfolds it.
- **Drag** — pointer drag with a drop indicator, applied as one CodeMirror
  transaction moving a line range (undo is free). The save carries
  `base_updated_at` so a move cannot silently overwrite a remote edit.
- **Outline helpers** — Tab/Shift-Tab indent, Enter continuation, collapse; this
  is also the groundwork for Logseq-style authoring.
- **Copy link to block** — `/<notebook>/page?p=<path>&block=<hash>`; opening it
  scrolls to the resolved block and flashes its range. If the block changed, the
  nearest candidate is shown with a "block moved" hint instead of failing.
- **Block search rows** — search results can point at `path + hash`; the OmniBar
  opens the note and jumps to the block.

Nothing in this list writes metadata into the markdown.

## 5. R1 phases

| Phase | Scope | Effort |
| --- | --- | --- |
| **P0 spike** | `parse_blocks` + debug endpoint + parity corpus; run over the deployed notebook and report counts/edge cases | 0.5–1 day |
| **P1 index + API** | `block` relation, sync integration, `blocks.rules` marker, `GET …/blocks`, `GET …/block`, tests | 1 day |
| **P2 handles + fold** | `blockField`, gutter handle, fold/unfold, copy link | 2 days |
| **P3 drag + outline** | drag-reorder with drop indicator and conflict guard, Tab/Enter helpers | 2–3 days |
| **P4 deep links + search** | hash resolution with drift fallback, block rows in search results | 1 day |

P0–P4 are implemented.

## 6. Compatibility

R1 is invisible to other tools: no syntax, no ids, notes stay plain markdown, and
Obsidian/Logseq keep working with our files unchanged. Deep links are an OpalNote
URL convention.

## 7. Risks

- **Two parsers drifting** (Rust and TypeScript) — mitigate with the parity corpus,
  as already done for `taskSignature`.
- **Atomic constructs** — tables, callouts and HTML blocks must be single blocks or
  folding and dragging will corrupt them.
- **Concurrent moves** — a drag is a multi-line rewrite; without `base_updated_at`
  a phone PWA edit and a desktop drag interleave silently.
- **Mode detection** — a mostly-bullet note is treated as an outline; the heuristic
  must be reported in the spike so it can be tuned (or overridden) before P2.
- **Large notes** — folding a 5k-line range is fine; dragging must stay a single
  transaction, not a per-line edit.

## R2 — persistent references (deferred)

References, embeds and block backlinks need a stable identity, and the only real
question is *where* that token lives. Every option costs something, which is why
R2 needs its own review.

| Placement | Body pollution | Survives external edits | Resolvable without the server | Obsidian-compatible |
| --- | --- | --- | --- | --- |
| **A. On the target block** (`^k7f2qd`, Obsidian's convention) | every referenced block | best | yes | **yes** |
| **B. Frontmatter map** (`blocks: { id: hash }`) | none (frontmatter is hidden in the editor) | hash-linked, drifts on hand edits | yes, file stays self-contained | no |
| **C. Durable server map** (`opalnote.db`) | none | hash-linked | **no** | no |
| **D. Reference-site only** (`((note#hash))` or a text-quote anchor) | none at the target | depends on the anchor kind | yes | no |

Observed pollution of option A, measured on a running instance: a `- [ ] task
^t5m1zz` line yields `task.text = "write the block doc ^t5m1zz"`, appears in note
excerpts and search results, and words counts; ids cannot be appended to fenced
code, `$$` blocks or table rows without breaking those constructs. That is the
reason R2 is not bundled into R1.

R2's design review has to settle:

1. storage policy (A vs B vs D — the recommendation on the table is **B** as the
   default, with A available per notebook for Obsidian interop);
2. reference syntax and how it degrades in other editors;
3. re-anchoring UX when a referenced block's text changed;
4. duplicate-id handling for copy/paste;
5. whether `[[note#^id]]` anchors (Obsidian) are read as an input format.

## Decisions settled for R1

- **Outline granularity**: a bullet line is a block; indented children are
  separate blocks with `parent_seq` (single-line granularity, Logseq-style).
- **Delimiter**: one blank line (double-blank produces zero multi-block notes in
  the corpus).
- **Scope**: positional identity only; no ids, no refs, no embeds, no block
  backlinks.
- **No migration**: the index stays disposable; rule changes re-derive via
  `blocks.rules`.
