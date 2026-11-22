# Plan: one markdown parser for both sides (`lutez`)

Research plan for replacing OpalNote's hand-written markdown scanners with
[`liyu1981/lutez`](https://github.com/liyu1981/lutez) — a CommonMark 0.31.2 + GFM
parser in Zig exposed as a C library **and** an import-free WASM module — so the Rust
indexer and the browser editor share one parse of the same document.

Status: **implemented for the data path (P0–P2 + the client mirrors).** The
parser is vendored as the `vendor/lutez` submodule (pinned `a8a81bb`: 0.3.0 plus
the Logseq keyword preset and the tightened tag rule), built by
`node scripts/build-lutez.mjs` into `liblutez.a` and `web/public/lutez.wasm`, and
both runtimes now derive blocks, tasks, tags and wikilinks from its AST:

| Piece | Where |
|---|---|
| FFI + wire-2 decoder | `src/store/lutez.rs` (server, `cfg(lutez_ffi)`) |
| AST → blocks/tasks/tags/links | `mod lutez_ast` in `src/store/markdown.rs` |
| WASM glue + wire decoder + adapter | `web/src/lib/lutez/` (`glue.ts`, `wire.ts`, `parse.ts`) |
| Build + delivery | `scripts/build-lutez.mjs`, `build.rs`, `.wasm` asset route + CSP |
| Parity harness | `pnpm check:parse` (server vs browser) and `cargo test corpus_parity -- --ignored --nocapture` (AST vs the legacy scanners) |

**Still open:** P3 (re-target `livePreview.ts` from per-line regexes to AST
ranges), P4 (delete `parse_blocks`/`extract_*` and the client mirrors — they are
the fallback today), `outlinerBlocks` (`key::`, `^block-id`) until blocks R2.
`OPALNOTE_PARSER=legacy` and a missing `liblutez.a` both fall back to the legacy
scanners; `GET /meta` reports `parser: "lutez" | "legacy"`.

Measured parity after the swap (§5 has the method): the two adapters produce
**identical block, task, tag and link output on all 198 corpus notes**, and the
shared AST matches the legacy scanners on every note except the documented
classes below (empty bullets, quote-in-item, indented code, nested ordered lists,
`parent_seq` semantics).

Re-reviewed four times: `c560ba4` (0.2.0) shipped the source spans this plan
asked for, `891cb5f` fixed the two defects the second review found (empty input,
BOM), `ce9213a` (0.3.0) added the opt-in dialect presets (ABI 3), and
**`a8a81bb`** (on `master` after 0.3.0, still unreleased) closed the last two
asks: a **Logseq `TODO`/`DOING` preset** (inline extension kind 7, preset bit
`1<<5`) and a **tightened tag rule** (64-char cap, `.` terminates, all-digit
rejected, `)` allowed before). ABI stays **3**, wire stays **2**, `lutez_opts`
stays 16 bytes. HEAD checked: `5352c3e` (docs-only commit on top of `a8a81bb`).

Related: [`architecture.md`](architecture.md) (storage, editor internals),
[`blocks.md`](blocks.md) (block model, rules versioning).

---

## 1. Verdict

Both original blockers (positions, dialect) stay closed, and the two follow-ups this
plan still listed as "open upstream" are now answered by `a8a81bb` — one fully, one
with a scope we have to finish on our side:

1. **Positions** — 0.2.0 emits exact source spans (raw *and* normalised byte offsets) for
   every node, plus a source map for CRLF/NUL/BOM/newline normalisation. Re-verified at
   HEAD on empty / BOM / CRLF / NUL / multi-byte UTF-8 documents: raw offsets index the
   caller's original bytes, including a BOM at offset 0 (`NodeDocument [0, len)`, first
   block at raw 3).
2. **Dialect** — the six presets now cover tags, math, wikilinks, frontmatter,
   Logseq `key::`/Obsidian `^block-id`, and **Logseq task keywords**. Verified on a
   Logseq-shaped document: `- TODO x` → kind 7 payload `TODO` at the paragraph start,
   `#idea` → tag node, `[[Page One|alias]]` → raw payload, `$x^2$` → math flag 0,
   `$$y$$` → math flag 1, fenced `$$` → flag 3 (display|block), `$5 and $10` stays prose.

Measured on our now-195-note corpus (details in §5):

| Question | Answer |
|---|---|
| Do all notes parse? | **195/195** |
| Task line numbers vs. `extract_tasks` | **195/195 identical** (68 tasks in 29 notes) |
| Corpus shape | 168 notes with inline tags, 157 with frontmatter tags, 30 with wikilinks (77 nodes), 1 with math, 4 frontmatter-only bodies, 0 Logseq keyword lines |
| Inline tag sets vs. our extracted tags | **194/195 identical** (one `)#hg` case, §5.3) |
| Block sequence after the adapter | **103/198 notes identical** to the legacy scanner; the rest are the five documented classes (§5.2) |
| Rust-side link | `liblutez.a` exports all 21 `lutez_*` symbols, ABI 3; linked from Rust with `cargo:rustc-link-lib=static=lutez` + `c` (Zig's std pulls libc) — verified, `lutez_parse_presets` + wire decode from a release build |

What is still ours to do:

- **`TODO`/`DOING` only.** The preset does not recognise `DONE`, `CANCELED`,
  `CANCELLED`, and it fires on *any* paragraph that starts with the keyword (a plain
  top-level paragraph, an ordered item, a quote item, a non-first paragraph of an
  item), not just the first paragraph of a `-`/`*`/`+` bullet. Our `extract_tasks`
  requires a bullet and maps five keywords. Adapter-side scoping plus a tiny post-pass
  closes the gap; asking upstream to widen the keyword set is the alternative (§6.8).
- **Tag grammar** now matches our `)` boundary (the one corpus diff, and it goes in
  *their* favour), but diverges on `.` (they terminate, we keep it) and all-digit tags
  (they reject, we accept). **Decided in the implementation (§6.5):** we adopt their
  grammar; no corpus note is affected, and the client's `normalizeTag` mirrors the
  server's `normalize_tag`.

Recommendation: **proceed, unchanged in shape.** Enable `tags`, `math`, `wikilinks`,
`outlinerKeywords` in P2; keep frontmatter splitting on our side; leave
`outlinerBlocks` off until blocks R2 wants `^id`s. The remaining gap is the editor, not
the parser.

---

## 2. What changed since the previous review

### 2.1 `a8a81bb` — the two follow-ups (this review)

| Area | 0.3.0 (`ce9213a`) | HEAD (`a8a81bb`) |
|---|---|---|
| Presets | 5 bits (`frontmatter`, `math`, `wikilinks`, `tags`, `outlinerBlocks`) | **6 bits** — adds `LUTEZ_EXT_OUTLINER_KEYWORDS = 1<<5` / JS `outlinerKeywords`, included in the `opal-note` bundle |
| Kind registry | 6 kinds (1 math, 2 wikilink, 3 tag, 4 frontmatter, 5 `key::`, 6 `^block-id`) | **7 kinds** — kind 7 `outliner_keyword`, payload `TODO` or `DOING`, span covers just the keyword |
| Tag rule | `#` + alnum/`_`/`-`/`/`; boundary before not alnum/`_`/`/`/`.`/`:` | **+** 64-char cap (over the cap: no tag at all), `.` terminates the run, a preceding `)` allowed, `#` before the marker rejected, all-digit still rejected |
| Task keywords | absent (plain `Text`) | `TODO`/`DOING` at the start of a paragraph's tokens, followed by whitespace or end of block |
| Docs / tests | — | README, `AST_SCHEMA`, `WIRE_FORMAT`, `EXTENSIONS_DESIGN`, `OPALNOTE_INTEGRATION_PLAN`, header, `js/lutez.d.ts`/`mjs`, site pages, WASM smoke, extension corpus all updated · `zig build test` **61/61**, CM **652/652**, GFM **672/672** |
| ABI / wire / opts / WASM size | 3 / 2 / 16 B / 243 KB | **unchanged** (243,720 B) |

`5352c3e` on top is docs-only (site `llms.txt` generation). No release tag exists in the
repo, and `build.zig.zon` still says `0.3.0` — so **pin a commit** (`a8a81bb` or
`5352c3e`), and version-check `lutez_abi_version()`/`lutez_wire_format_version()` at
startup.

### 2.2 Earlier history (unchanged, kept for context)

| Area | v0.1.0 | v0.2.0 | v0.3.0 |
|---|---|---|---|
| Source positions | none | **wire v2**: 56-byte records, `src_raw_*` + `src_norm_*`, `span_derived`, source map | unchanged |
| Accessors | none | `lutez_node_span*`, WASM `lutez_node_span*`, JS `doc.span(i)` | + `lutez_node_ext_kind/flags`, JS `doc.extension(i)` |
| BOM / empty input | broken | fixed (`strip_bom` default on, `parse("")` → one node) | unchanged |
| ABI / wire | 1 / 1 | 2 / 2 | **3** / 2 |
| Extension nodes | rejected (≥ 500) | rejected | `NodeBlockExtension` 500 / `NodeInlineExtension` 501, preset-gated |

---

## 3. lutez at HEAD as it stands (verified)

| Property | Value |
|---|---|
| Language / toolchain | Zig **0.17.0** (pinned), no other build deps for `zig build` / `zig build wasm` |
| Scope | CommonMark 0.31.2 + GFM (tables, task lists, strikethrough, extended autolinks) + **six opt-in dialect presets**; rendering out of scope |
| Upstream | port of [`88250/lute`](https://github.com/88250/lute) @ `v1.7.8` |
| Output | binary AST, wire format **v2**, self-contained buffer, O(1) free |
| ABI | **3** — `lutez_parse_presets`, `lutez_node_ext_kind/flags`; `lutez_opts` still 16 bytes |
| Spans | half-open **raw byte offsets** (primary contract) + normalised offsets + derived flag + source map (`4 + 20×n` bytes) |
| Runtimes | `liblutez.a` (8.3 MB ReleaseSafe) / `.so` (4.9 MB) + `include/lutez.h`; `lutez.wasm` (243,720 B, zero imports) + `js/lutez.mjs` / `lutez.d.ts`; Zig API |
| Parity | CommonMark 652/652, GFM 672/672, HTML oracle byte-identical (their CI) |
| Threading | reentrant; no mutable globals except the thread-local error string and the WASM slot table (1024 docs) |
| Licence | **Mulan PSL v2** (permissive, NOTICE attribution to Lute) |
| CI | `mlugg/setup-zig@v2`; `zig build` / `zig build wasm` need no Go, `zig build check` (parity) does |

Preset mask (`include/lutez.h`, `js/lutez.mjs` `PRESETS`):

```
1<<0 frontmatter   1<<1 math        1<<2 wikilinks
1<<3 tags          1<<4 outlinerBlocks (key::, ^block-id)
1<<5 outlinerKeywords (TODO/DOING)  ·  "opal-note" = all six
```

Span semantics (their `AST_SCHEMA.md` §6.1): containers include their markers
(`#`, `>`, list markers, fences); leaves cover their source bytes; synthesised nodes are
zero-width and flagged derived; lazy continuation lines extend the ancestor span. Raw
offsets are measured on the caller's original bytes — exactly what CodeMirror needs.

Verified on a Logseq-shaped document (byte-accurate probe, HEAD):

```
- [ ] task #tag
  - ```
    code
    ```
List          raw=[0,40)
  ListItem    raw=[0,40)
    Paragraph raw=[2,15)          # excludes the "- " marker
      TaskMarker raw=[2,5)        # "[ ]"  → task line = 1
    List      raw=[18,40)
      ListItem
        CodeBlock raw=[20,40)     # includes both fences
café 🎉 **bold** tail
  Strong raw=[11,19)              # byte offsets, not UTF-16
```

Math flags: inline `$x$` → 0, same-line `$$y$$` → 1 (`display_math`), fenced `$$` block
→ 3 (`display_math | block_math`), which the 0.3.0-era note in this doc got wrong.

---

## 4. What OpalNote needs, and where lutez stands

| Need | Where | lutez HEAD | Remaining work |
|---|---|---|---|
| Source ranges for blocks/tasks/links | `src/store/markdown.rs`, `block`/`task` relations, deep links | **done** — spans convert to lines by counting `\n` in the body | adapter only |
| Editor mapping (document offsets) | `web/src/lib/livePreview.ts` | **done** — raw spans; bridge UTF-16↔bytes once per document | adapter + editor work |
| Frontmatter split + tags block rewrite | `split_frontmatter`, `render_page` | available (kind 4, payload **without** fences, fires only at document start) | we keep pre-splitting and parse the body (the editor never shows frontmatter), so this preset stays off; `render_page` unchanged |
| BOM handling | `parse_page` strips `\uFEFF` | **resolved**: `strip_bom` (default on) drops it; verified `\uFEFF- a\n- b\n` → 2-item list, blocks starting at raw 3 | set the option explicitly in the FFI so a NULL opts cannot change behaviour |
| Empty body | 4 of 195 corpus notes are frontmatter-only | **resolved**: `parse("")` returns a one-node document spanning `[0,0)` with a 1-segment source map | none |
| GFM task lists | `extract_tasks` | `NodeTaskListItemMarker` + marker byte; **195/195 notes agree on line numbers** | adapter |
| Logseq keywords | `extract_tasks` | **preset exists but partial**: kind 7 for `TODO`/`DOING` only, any paragraph start, no bullet scoping | adapter guard + post-pass for `DONE`/`CANCELED`/`CANCELLED` (§5.4) |
| Bullet fences (`- ``` `, `  - ``` `) | `parse_blocks`, live preview | correct CommonMark: `ListItem > CodeBlock` | decide whether to adopt nesting (§5.2) |
| 4-space indented code | `parse_blocks` (treats it as prose) | `NodeCodeBlock` (indented), no fence needed | decide whether to adopt (§5.2) |
| Inline `#tags` | `extract_tags`, tag view, completion | **done**: kind 3, payload without `#`, span includes `#`; rule tightened in `a8a81bb` | enable `LUTEZ_EXT_TAGS`; settle two grammar differences (§6.5) |
| `$$math$$`, `$x$` | KaTeX in the editor | **done**: kind 1, flags 0/1/3; `$5 and $10` stays prose | enable `LUTEZ_EXT_MATH`; keep KaTeX `trust: false` |
| `[[wikilinks]]` | links, backlinks, completion | **done**: kind 2, payload raw including `\|` | enable `LUTEZ_EXT_WIKILINKS`; split target/alias in our adapter |
| Blocks (kind/depth/parent/text/hash) | `parse_blocks`, handles/fold/drag | structure + spans exist | adapter; ranges come from spans |
| Summary / excerpts | `summarize` | text nodes carry the text | small walker |
| Rendering | CodeMirror decorations | out of scope by design (fine — we render) | P3 re-target of `livePreview` |
| Incremental parse | per-keystroke decorations | full reparse per call | measure P3; full note is p50 0.14 ms |
| Wire size | worker transfer / caching | 4.5 KB per note, median 6.58× source | transfer cost is fine; do not cache many ASTs |

---

## 5. Measurements (this review, lutez `a8a81bb`)

Corpus: `data/notebooks/sb-import`, **195 notes / 161,696 bytes** (168 notes with inline
`#tags`, 157 with explicit frontmatter tags, 30 with wikilinks, 1 with math, 29 with
tasks, 0 Logseq keyword lines, 4 frontmatter-only bodies). Frontmatter stripped before
parsing, as the server does. Presets `["opal-note"]` (all six on, so every construct is
exercised).

### 5.1 Speed and size

| Metric | Value |
|---|---|
| Parse + wire encode, whole corpus (WASM, warmed) | 43.7 ms total (195/195 parsed) |
| Per note | p50 **0.140 ms**, p95 **0.752 ms**, max **4.07 ms** (first-call warm-up) |
| Wire bytes | 873,144 B total · **4,478 B** per note · median **6.58×** source (p90 11.7×) |
| WASM size | **243,720 B** (ReleaseSmall, zero imports) |

Typing budget: a full reparse of a corpus note is ~0.2–0.75 ms typical — affordable per
keystroke, and trivial from a Worker. Nothing regressed versus 0.3.0.

### 5.2 Block parity with the implemented adapter

Method: `parse_ast` (the adapter that ships) versus the legacy line scanner, on
every note body in `data/notebooks` (frontmatter stripped): compare the
`(kind, start_line, end_line, depth, parent_seq)` sequence.

| Result | Count |
|---|---|
| Notes with an **identical block sequence** | **103 / 198** |
| Different only in `parent_seq` (legacy resets its list stack at a fence) | 6 |
| Empty bullet `-` → `list_item` instead of `paragraph` | 85 |
| Quote-first item (`- > quote`) splits into item + quote | 2 |
| `- 1) x` nests an ordered sub-list (3 blocks instead of 1) | 1 |
| 4-space indented text → `code` instead of `paragraph` | 1 |
| Task **line numbers** identical (`extract_tasks` vs. the AST) | **198 / 198** (68 tasks) |

Inside those classes the block **text and hash** stay identical whenever the
range and kind did not move (the adapter still builds text from the raw lines
with `block_text`), so deep links survive everywhere except the moved blocks.

The remaining differences are decisions the grammar now records in
`doc/blocks.md` §1, not defects:

- a bare `-` is an empty list item (CommonMark) rather than a paragraph;
- a 4-space indented block is code, not prose;
- `- 1) x` is an ordered sub-list, not one bullet;
- `- > quote` keeps the marker line on the item and the continuation in a quote
  block;
- `parent_seq` is a `seq` (the legacy server wrote the parent's start line; the
  client always meant the `seq`, so the two sides had disagreed).

The two adapters (`mod lutez_ast` in `src/store/markdown.rs` and
`web/src/lib/lutez/parse.ts`) are **byte-identical** on the corpus: comparing a
per-note dump of blocks, tasks, tags and link targets from the Rust FFI and from
the WASM build produces zero differences on all 198 notes.

### 5.3 Dialect parity with presets on

| Construct | Result on the corpus |
|---|---|
| Inline tag sets (preset `tags`) vs. `tags − explicit_tags` from the API | **194 / 195 notes identical** · 533 tag nodes, **494** distinct tags inside their note (vs. **493** distinct inline tags we extract; the extra one is the `#hg` below — the rest of the node/count gap is repetition) |
| The one diff | `journals/2022-07-19.md`: `…/edit)#hg` — the old scanner required whitespace or `([{,"'` before `#`, so it missed this tag; the AST finds it. Nothing else changes: the corpus has no dotted tags (`#a.b`) and no all-digit tags (`#123`) |
| Links | The AST finds one link the old scanner missed (`CAPIG UI Build Project.md`: a line with an odd number of backticks leaked `strip_code`'s "in code" state into the rest of the note) |
| Tag rule deltas, verified on synthetic input | `)#hg` → `hg` (they accept, we reject) · `#a.b` → `a` (we take `a.b`) · `#123` → no tag (we take `123`) · `#tag.` → `tag` (we trim, same result) · `#foo/` → payload `foo/` (we trim the `/`) · 64 chars ok / 65 → no tag (same outcome as our drop, different node: they leave plain text) · `C#`, `x#y` → no tag (same) · `[#link](u)` → tag inside link text (same as ours) · `- #heading` → tag `heading` (same as ours; not an ATX heading) |
| Math (preset `math`) | 1 inline math node (`$f(y)=\sin(x)$`); `$20`, `$logseq-…`, shell `$f` stay text; `$$y$$` → flag 1, fenced `$$` → flag 3 |
| Wikilinks (preset `wikilinks`) | 77 nodes across 30 notes, payload raw (`Page One\|alias`, `Page Two#Heading`) |
| Frontmatter (preset `frontmatter`) | kind 4 block with the payload **without** `---` fences — works when parsing the raw document; we strip frontmatter ourselves and parse the body, so we leave that bit off |
| Outliner blocks (preset `outlinerBlocks`) | `key:: value` → kind 5, trailing `^abc-123` → kind 6 (`abc-123`); unused by us today (blocks R2) |
| Outliner keywords (preset `outlinerKeywords`) | 0 nodes in this corpus — see §5.4 for the behaviour on synthetic Logseq input |

### 5.4 Logseq task keyword preset — what it actually does

Measured on synthetic documents (HEAD):

| Input | Result |
|---|---|
| `- TODO buy milk` | kind 7 `TODO` at span `[2,6)`, then `Text " buy milk"` |
| `- DOING thing` | kind 7 `DOING` |
| `- DONE finished` / `- CANCELED nope` / `- CANCELLED nope` | **no node** — plain text |
| `TODO plain paragraph` (no bullet) | **kind 7 fires** — their own test asserts this; scoping is the host's job |
| `1. TODO ordered` | kind 7 fires (ordered item) — our `extract_tasks` only accepts `-`/`*`/`+` |
| `- first\n\n  TODO second` | kind 7 fires in the item's **second** paragraph (docs say "first paragraph") |
| `> - TODO quoted` | kind 7 fires inside a blockquote list item |
| `- TODO` (no text) | kind 7 fires, nothing after it — our extractor requires non-empty task text |
| `- [ ] TODO both` | **no keyword node**: the GFM checkbox marker wins, text becomes `" TODO both"` |
| `- TODOING x`, `TODO: colon`, `- # TODO heading` | no node (needs whitespace/end after the keyword, paragraphs only) |

So the adapter must (a) accept a keyword node only when its paragraph is inside a
`-`/`*`/`+` list item, (b) map `TODO`→open, `DOING`→doing, and keep a ~10-line post-pass
for `DONE`/`CANCELED`/`CANCELLED`, (c) keep the "text after the keyword must be
non-empty" rule, and (d) decide whether ordered items become tasks (they already count as
`task` blocks via `list_marker`, but never reach the todo list).

---

## 6. Decisions OpalNote owes lutez

Answering `doc/OPALNOTE_INTEGRATION_PLAN.md` §6:

| # | Question | Our decision |
|---|---|---|
| 1 | Offset units | **Raw UTF-8 byte offsets** as the contract, as shipped. The client converts to UTF-16 once per document (CodeMirror indexes UTF-16); line numbers are derived by counting newlines in the body. |
| 2 | Span semantics | As shipped: containers include markers, leaves cover source bytes, derived = zero-width. Good for blocks, tasks and deep links. |
| 3 | Container spans | List items include nested children, exclude trailing blank lines — matches our `end_line` (last non-blank line). |
| 4 | Frontmatter shape | As shipped (kind 4, payload without fences) for hosts that parse the raw document. **We keep pre-splitting** and parse only the body — the editor never shows frontmatter, and our `render_page` rewrites just the `tags:` block. `LUTEZ_EXT_FRONTMATTER` stays off. |
| 5 | Tag alphabet | `a8a81bb` closed the boundary half in their favour (`)` allowed, `#` still rejected before the marker, 64-char cap confirmed). **Two differences remain** and both are "adopt theirs": `.` terminates a tag (`#a.b` → `a`) and all-digit tags (`#123`) are rejected. Measured corpus impact: **zero notes** for both; the only tag change anywhere is the `)#hg` note, which now gains a tag we missed. So we adopt their grammar in P1 instead of asking for an option byte, and keep `normalize_tag`'s `./` trimming in the adapter because their payload can keep a trailing `/`. |
| 6 | Math syntax | As shipped (inline `$…$`, `$$…$$` on one line → flags 1, fenced `$$` block → flags 3, space guards, escapes). We keep KaTeX `trust: false` and our "no digit right after the closing `$`" guard in the renderer if their rule lets `$x$2` through. |
| 7 | Wikilink payload | As shipped (raw payload including `|`). We split target/alias in our adapter, and `[[Page#Heading]]` → target `Page` with the heading kept for display. No library change needed. |
| 8 | Logseq keywords | Preset exists (kind 7) but covers **`TODO`/`DOING` only** and is paragraph-scoped, not item-scoped. We accept that shape (host scoping is cleaner than a parser that knows about bullets) and keep our post-pass for `DONE`/`CANCELED`/`CANCELLED`. **Ask upstream (optional, small):** widen the keyword list to the Logseq five; we will not block on it. |
| 9 | Compatibility | We move to **wire v2 / ABI 3** directly — both decoders are written by us; no v1 mode needed. Keep `format_version`/`abi_version` in the header so a stale client fails loudly, and keep `presets = 0` behaving exactly like `lutez_parse`. |
| 10 | Extension ownership | As shipped: **per-call preset mask** (`lutez_parse_presets` / JS `extensions`), no global profile — good for concurrent parses in `spawn_blocking`. The named bitmask is enough; the data-driven spec builder planned for 0.4 is not needed. |

Earlier asks that are **done and verified**: empty input (one-node document, span
`[0,0)`), `strip_bom` default on, presets for tags/math/wikilinks/frontmatter/`key::`/
`^block-id`, and now the keyword preset plus the tightened tag rule.

Still open upstream (neither blocks P0–P3):

1. `DONE`/`CANCELED`/`CANCELLED` in the keyword preset (and either bullet scoping or an
   explicit "paragraph-start only" contract — the docs say "first paragraph", the code
   matches every paragraph).
2. A data-driven tag option (charset/boundary) — only if a notebook ever needs the `.`
   or digit forms back.

---

## 7. Integration design

### 7.1 One AST, two runtimes

```
                       ┌───────────── OpalNote backend ──────────────┐
  markdown file ──────►│ Rust: FFI → liblutez.a                      │──► index rows
                       │   wire v2 decoder → adapter → ParsedPage    │    note/tag/link/
                       │   (frontmatter split around the call)        │    task/block
                       └─────────────────────────────────────────────┘
                       ┌───────────── browser ───────────────────────┐
  same markdown ──────►│ wasm lutez.wasm (Worker) + TS wire decoder  │──► CodeMirror
                       │   raw spans → UTF-16 offsets                 │    decorations
                       └─────────────────────────────────────────────┘
```

- **Adapters, not rewrites.** `src/store/model.rs` and all relations stay as they are. A
  new `parse` module turns the AST into the existing `ParsedPage` / `ParsedTask` /
  `ParsedBlock` structs, so the store, API, deep links and plugin host are untouched.
  `OPALNOTE_PARSER=lutez|legacy` selects the implementation until the corpus diff is zero.
- **Preset mask used by both runtimes**: `tags | math | wikilinks | outlinerKeywords`
  (`.md` + WASM must be identical, or the editor and the index disagree).
- **Two decoders, both small**: Rust and TS read the same 56-byte records, validate
  `format_version`/`node_stride`/section bounds (the invariants in `WIRE_FORMAT.md` §6),
  and honour the `span_derived` flag. Fuzz both on the corpus and on random bytes.
- **Source map use**: only needed when comparing normalised offsets; the raw spans are the
  contract, so the decoders can expose raw spans and derive line numbers by newline
  counting on the raw body. Decoders must accept map kinds 1–4 (BOM strip included) even
  if they only read the segment count.
- **Frontend**: `livePreview` keeps every widget (task/bullet/image/media/file/wikilink/
  external link/KaTeX/code-copy/viewer embeds) and its active-line source reveal; only its
  input changes from per-line regexes to AST nodes + ranges. `blocks.ts` and `tasks.ts`
  (mirrors) are deleted in P4.
- **WASM delivery**: build in CI for the pinned commit, serve with `application/wasm`,
  instantiate in a Worker, allow `wasm-unsafe-eval` in the asset CSP (verify
  `assets.rs`).
- **Task adapter order**: checkbox marker first (authoritative), then keyword scoping
  (`TODO`/`DOING` from kind 7, `DONE`/`CANCELED`/`CANCELLED` from the post-pass), then the
  "non-empty text" rule.

### 7.2 Where the dialect is resolved

| Construct | Resolution |
|---|---|
| Frontmatter | OpalNote pre-split (already exists); no dependency on lutez |
| Logseq `TODO/DOING` | kind 7 node, adapter keeps it only for `-`/`*`/`+` list items |
| Logseq `DONE/CANCELED/CANCELLED` | post-pass over the item's first paragraph text (unambiguous, tiny) — until upstream widens the preset |
| `#tags` | lutez preset (context-aware: code spans, links, escapes); adapter lowercases and trims `./` |
| `$$math$$` / `$x$` | lutez preset — marker pairing across emphasis/code cannot be recovered after the fact |
| `[[wikilinks]]` | lutez preset — `[` is structurally owned by CommonMark links |

---

## 8. Phased plan

| Phase | Work | Exit criteria | Est. |
|---|---|---|---|
| **P0 — accept spans** ✅ | pin lutez `a8a81bb` (no release tag: pin the commit, record the ABI check); `build.rs` FFI — static link (`cargo:rustc-link-lib=static=lutez` + `c`, verified from a scratch crate) with `liblutez.a` cross-compiled or vendored per target; `pnpm build:wasm`; Rust + TS wire-v2 decoders; span acceptance test on the 195-note corpus; parity harness reporting block/task/tag diffs | decoders round-trip the corpus; harness reproduces the §5 tables from our own data; nothing shipped | 2 d |
| **P1 — model decisions** ✅ | settle the six difference classes (§5.2): adopt CommonMark nesting or model our quirks; adopt their tag grammar (`.`, all digits, trailing `/`); set `strip_bom` explicitly in the FFI; decide ordered-item tasks | decision recorded per class; rules markers planned; adapter contract written | 1–2 d |
| **P2 — backend swap** ✅ (+ client mirrors) | adapter → `ParsedPage/ParsedTask/ParsedBlock` (spans → lines, list nesting, empty bullets, indented code, extension kinds 1/2/3/7); `OPALNOTE_PARSER` flag; presets `tags|math|wikilinks|outlinerKeywords`; bump `TASK_RULES_VERSION`/`BLOCK_RULES_VERSION`; measure a full sync | corpus diff zero (or every diff explained and accepted); tag sets match §5.3; task rows match §5.2/§5.4; sync time within ±10% | 3–5 d |
| **P3 — editor on the AST** | re-target `livePreview` (ranges + node kinds), keep widgets/KaTeX/embeds; completion sources use AST nodes instead of regexes; UTF-16 bridge; Worker plumbing | visual + interaction parity on a screenshot corpus; block handles/fold/drag/deep links intact; typing p95 < 16 ms for a 5 KB note | 1.5–2.5 w |
| **P4 — retire the mirrors** | delete `parse_blocks`/`extract_*`/`summarize`, `blocks.ts`/`tasks.ts`/fence helpers; docs; third-party notices | one parser, one rule set, docs updated | 2–3 d |
| **P5 — dialect** ✅ | presets `tags`/`math`/`wikilinks`/`outlinerKeywords` arrive with P2; keep the `DONE`/`CANCELED`/`CANCELLED` post-pass; adopt the tag-grammar deltas; only `outlinerBlocks` stays off (blocks R2) | dialect nodes carry spans for all five; corpus matches §5.3/§5.4 | 1–2 d (was 2–3) |

✅ = shipped in this implementation. P0/P1/P2/P5 and the client-side mirrors are in
`main`; `livePreview.ts` still scans lines (P3), and the legacy scanners / client
fallbacks are deleted in P4.

Gates: the corpus diff and the Rust test suite between every phase; no phase ships a
semantic change it cannot explain line by line.

---

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| No released tag for the keyword/tag work | a pinned commit can move under us | pin the SHA (`a8a81bb`), record it in `build.rs`/docs, check `lutez_abi_version()==3` and `lutez_wire_format_version()==2` at startup |
| Block-model change for ~106 of 195 notes | block rows, tag cards, deep links shift | decide per class in P1; adapter can model today's quirks first, adopt nesting later behind a rules-version bump |
| Keyword preset is partial (`TODO`/`DOING`, any paragraph) | `DONE` items vanish from Todos; non-bullet prose becomes a task | adapter guard (bullet + first-paragraph) + small post-pass; covered by tests in P2 |
| Adopting the new tag rule silently retags a notebook | tags appear/disappear | measured: one note gains `#hg` in our corpus; verify with the tag-set diff before flipping `TASK_RULES_VERSION`/reindex |
| Editor rewrite regressions | the editor is the product | keep the widget inventory fixed; screenshot corpus; ship behind `?parser=lutez` for one release |
| Zig in the build pipeline | second toolchain in `pnpm build`/release | build once per target per release, cache, or vendor static libs (Zig cross-compiles all 7 targets). Measured: `-Doptimize=ReleaseSafe` builds in 20 s; a Rust release binary linking the static archive lands at 1.7 MB unstripped (~1.2 MB stripped C equivalent), so embedding is not a size problem |
| **Native CPU features baked into the archive** | `zig build` defaults to the host CPU, so a CI runner's newer features (AVX-512 on x86; `dotprod`/`i8mm`/`sve` on ARM) make the binary die with `Illegal instruction (core dumped)` on an older server — observed on an ARM VM from a GitHub `ubuntu-24.04-arm` build | `scripts/build-lutez.mjs` always builds with **`-Dcpu=baseline`** (override `OPALNOTE_LUTEZ_CPU=native` only for a same-machine build) and stamps `zig-out/lib/lutez-build-flags` so a flag change forces a rebuild. `OPALNOTE_PARSER=legacy` is the runtime workaround until a portable binary is installed |
| Wire size 6.6× source | worker payload per keystroke | send only the note being edited; do not cache ASTs; measure in P3 |
| Decoder drift (Rust vs TS) | wrong offsets in one runtime | both decoders version-checked and fuzzed on the same corpus; cross-check in P0 |

---

## 10. Alternatives

| Option | Why not (or when) |
|---|---|
| Keep the hand parsers | two implementations that already drifted three times (bullet fences, ordered fences, tag view) |
| `cmark-gfm` / `md4c` | spec-complete but no Lute/Logseq tolerance, no shared AST with the browser, and (unless we build a second bridge) no spans |
| `comrak` (Rust) | mature, but the browser needs a second parser (or a Rust→wasm build, ~1 MB + a second toolchain) |
| `markdown-it` / `micromark` | browser-only; the Rust indexer would need another parser |
| `lutez` (this plan) | one AST, one grammar, spans, 243 KB wasm, permissive licence, plenty of typing headroom |

---

## 11. Appendix — reproducing this review

```sh
git clone https://github.com/liyu1981/lutez /tmp/lutez
cd /tmp/lutez && git checkout a8a81bb        # HEAD is 5352c3e (docs only); ABI 3, wire 2
zig build && zig build wasm && zig build test   # 61/61 tests, CM 652/652, GFM 672/672

rm -rf /tmp/pd && mkdir -p /tmp/pd/notebooks && cp -r data/notebooks/* /tmp/pd/notebooks/
target/debug/opalnote serve --data-dir /tmp/pd --bind 127.0.0.1:7906 \
  --no-tls --no-self-update
```

Probes (scratch scripts in `/tmp/probe`, not committed): a ~60-line wire-v2 decoder; span
inspection on synthetic Logseq/CRLF/BOM/NUL/emoji/empty documents; extension-node
inspection with `["opal-note"]`; tag-rule and keyword-rule synthetic matrices; the
block-sequence diff against `GET /notebooks/{id}/blocks` with first-divergence
classification; the task-line diff against `GET /notebooks/{id}/tasks`; the inline-tag
diff against `tags − explicit_tags`; parse timing/size over the corpus; and a link probe
(`cc` and `cargo` against `liblutez.a`, checking `lutez_abi_version()==3` and decoding a
`TODO`/`#tag`/`[[wiki]]` document through the wire).

Numbers in §5 are from those runs on 2026-11-22 with Zig 0.17.0 and lutez `a8a81bb`
(0.3.0 + keyword preset + tightened tags): wire v2 unchanged, ABI 3, opts 16 bytes,
243,720 B WASM.
