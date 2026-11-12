# AGENTS.md

Guidance for coding agents working in this repository.

## Commit policy (mandatory)

- **Never commit on your own initiative.** Only create a commit when the user
  explicitly asks you to commit.
- When asked, use a concise subject line and put the details in the body.
- After committing, return to the "waiting for the next instruction" state —
  do not continue making commits, tags, or pushes unless asked again.
- Never amend, rebase, force-push, or rewrite history unless the user asks for
  that specific operation.

## What this project is

Opal Note is a **server-first, file-first** note app.

- Markdown files under `data/notebooks/<notebook>/pages|journals/` are
  canonical.
- MnesticDB (Datalog) is a **disposable index** under `data/index/`, rebuilt
  from files and reconciled before reads.
- The browser holds no notebook state; it queries the server.

Production is a **single binary** with the built web client embedded via
`rust-embed`.

## Stack

- Server: Rust 2021, Axum 0.8, Tokio, rquickjs for sandboxed journal plugins
- Database: `mnestic` crate (MnesticDB, a maintained CozoDB fork); the library
  target is still imported as `cozo`. SQLite backend (bundled SQLite).
- Client: React 19, TanStack Router, CodeMirror 6, TypeScript 7 (`tsc`
  native), Vite 8, Tailwind CSS 4, Jotai 3
- Package manager: pnpm

## Commands

```bash
pnpm dev               # build, then watch web/src + src and rebuild/restart
pnpm build             # web build → asset sync → release binary (embedded assets)
pnpm start             # run target/release/opalnote
pnpm test              # cargo test + web typecheck
pnpm check             # cargo check + web typecheck
pnpm --dir web build   # web assets only
cargo test             # Rust unit tests (Datalog store + markdown parsing)
```

The root `package.json` is the only task runner. Do not add a Makefile,
justfile, or shell-script entry points — add a script there and, if
orchestration is needed, a Node entry under `scripts/`.

`pnpm dev` is a **single command**: it builds the client, syncs the bundle into
the server, rebuilds and runs the server (bound to `0.0.0.0:7827`), then watches
`web/src`/`web/public`/web config files and `src`/`Cargo.toml`/`Cargo.lock`/
`build.rs`. Changes are debounced (220 ms), rebuilt, and the server is
restarted. A failed build keeps the previous server alive. There is no separate
Vite dev server or HMR — reload the browser tab for a new client bundle.

`build.rs` builds `web/dist` on demand if it is missing/stale, so a plain
`cargo build` also works. Set `OPALNOTE_SKIP_WEB_BUILD=1` to compile Rust
without Node (a placeholder page is embedded if no bundle exists).

## Layout

```
package.json       dev / build / start / test scripts (the only task runner)
scripts/           dev orchestration, asset sync, release launcher
src/
  main.rs          startup, logging, graceful shutdown
  config.rs        clap/env configuration
  state.rs         AppState (Store + auth token)
  auth.rs          optional bearer-token middleware
  assets.rs        rust-embed static/SPA handler
  routes/          HTTP API; all handlers run DB work via spawn_blocking
  plugins.rs       sandboxed QuickJS journal plugin runner
  store/
    mod.rs         filesystem ↔ index sync, file-first CRUD, Datalog queries
    files.rs       folder layout, atomic writes, scanning, path safety, trash
    queries.rs     CozoScript statements (single source of truth)
    markdown.rs    wikilinks, tags, frontmatter, summaries + unit tests
    model.rs       API-facing serde models
web/
  package.json     build + typecheck only (no dev server)
  src/api/         typed fetch client + shared types
  src/router.tsx   TanStack route tree and URL/view synchronization
  src/state/       Jotai atoms (async read atoms invalidated by revisionAtom)
  src/components/  workspace shell, journal/plugin rails, pages, graph, panels
  src/components/editor/  CodeMirror live editor + link completion
  src/lib/         app navigation, live preview, editor theme, graph layout
```

## Conventions

### Server

- Keep **all** CozoScript in `src/store/queries.rs`. Bind user data as
  parameters (`$name`), never interpolate strings into scripts.
- Store methods are synchronous and must only be called inside
  `routes::db_call` (`tokio::task::spawn_blocking`).
- A MnesticDB `run_script` accepts **one Datalog query per payload**. Group
  related writes (note + tags + links) with `Store::run_atomic`, which uses
  `multi_transaction`; do not concatenate `?[...]` queries.
- **Files are the source of truth.** Never write note content only to the
  index. All mutations write the markdown file atomically, then re-index the
  affected notebook.
- The index is disposable and keyed by `(notebook_id, path)`. Deleting
  `data/index/` must always be safe.
- Reads call `Store::ensure_synced`; writes hold `fs_lock` for the whole
  read-modify-write. Do not call public store methods while holding the lock —
  use the `*_locked` internals.
- Note paths must resolve inside `pages/`/`journals/` via
  `files::resolve_note_path`; reject traversal and escapes.
- Notes are titled by filename stem. Renames move files. Deletes go to
  `data/.trash/`.
- Explicit tags live in YAML frontmatter (`tags:`), inline `#tags` are derived
  from the body. Preserve other frontmatter keys when rewriting.
- Legacy `Pages/` and `Journal/` folders are migrated to lowercase during sync.
- Every note write must keep the derived index consistent: `summary`, `tag`,
  `link`, and the `note:fts` index (maintained automatically by the engine).
- Validate input in `routes/mod.rs` helpers before hitting the store.
- Generic `/api/query` is read-only: reject `::` and pass
  `ScriptMutability::Immutable` with a timeout and memory limit.

### Client

- Server state is the source of truth. Read atoms live in `src/state/atoms.ts`
  and are invalidated by bumping `revisionAtom` via `refreshAtom`. Ordinary note
  autosaves must bump only `notesRevisionAtom` via `refreshNotesAtom`;
  `revisionAtom` also invalidates notebook/shell atoms and will suspend the
  root workspace mid-edit. Keep `ActiveNote` outside Jotai Suspense and retain
  its last loaded note while refreshing.
- Structural changes (new/deleted notes or notebooks, notebook switches,
  reindex) use `refreshAtom`; note content/title/tag saves use
  `refreshNotesAtom`. Do not call global refresh from the autosave path.
- Keep API types in `src/api/types.ts` in sync with `src/store/model.rs`.
- The server embeds `web/dist` via `rust-embed`; `scripts/lib.mjs` owns the
  build/sync step. Any new asset location must be wired through both.
- Use Tailwind theme tokens (`text-ink`, `bg-panel`, `border-line`, …) defined
  in `src/index.css`; do not hard-code new hex colors.
- The note body is a **live block editor**, not a split preview. Keep source
  marks visible while the cursor is on a block and render them elsewhere.
  Editor internals live in `src/lib/livePreview.ts`,
  `src/lib/wikiCompletion.ts` and `src/components/editor/`.
- Note text, titles and note lists use the fixed-width `--font-mono` stack;
  chrome labels may stay proportional. Keep the `.cm-live-*` styles in
  `src/index.css` as the single source of editor styling.
- `[[` completion resolves titles and paths from the current notebook. Keep
  clickable wikilinks, missing-page creation and the backlinks panel working
  together; bidi linking is a core feature, not a plugin.
- The editor has a **read-only lock** for presentations: reconfigures
  CodeMirror with `readOnly`/`editable(false)`, disables task toggles, hides
  save/delete and keeps wikilinks clickable. Do not reintroduce a separate
  source-mode switcher; focusing a block already reveals its source.
- A focused source line is plain markdown: `.cm-live-edit` suppresses token
  colors, heading sizes/weights, inline emphasis and list/quote styling, while
  the active-line tint remains the focus cue. Keep the source hanging indent
  (`.cm-live-hang` + content-column `--block-pad`) so wrapped focused list and
  paragraph lines stay under their content, not at the editor edge.
- Slash commands live in `src/lib/slashCommands.ts` and are a second
  CodeMirror completion source after wikilinks. They trigger only when `/` is
  the first non-whitespace character of a source line and are suppressed inside
  fenced code blocks. Use `apply` callbacks to edit the line, keep Escape and
  arrow/Enter selection behavior from CodeMirror, and keep the wiki-link source
  working after the "Link to page" command.
- Fenced code is block-scoped: `findCodeBlocks` scans the document so focusing
  any line (not just the opening fence) reveals the entire fenced source and
  restores the rendered block on blur. While editing, `.cm-live-code-edit`
  deliberately removes the code surface, syntax colors and active-line tint:
  source mode should read as plain markdown. Keep code lines hanging-indented
  so wrapped source remains aligned.
- Code blocks use the light code surface (`--color-panel` plus theme syntax
  colors) and `@codemirror/language-data` for lazy language highlighting. Use
  theme tokens for token colors; do not bring back the dark code surface.
- The single-page editor uses `autoHeight`: the page/main pane scrolls and
  the editor grows with its content. Do not put the editor back in a fixed
  height container with an internal `.cm-scroller` scrollbar. Journal cards
  use the same auto-height renderer and the same `--note-ch` hanging indent.
- The workspace opens on the journal feed, which is **Home**. The top bar has
  a search button next to the left-sidebar toggle, back/forward history
  controls, and a Home button on the right. Search is a centered in-page
  dialog (`SearchDialog`, `searchOpenAtom`), not a left-sidebar filter; do not
  put search back into `LeftSidebar` or make `notesAtom` query-dependent.
- The workspace has collapsible left/right panels (`leftPanelOpenAtom`,
  `rightPanelOpenAtom`), **default collapsed**. The left sidebar owns Journals,
  Pages, Favorites, Recent and Graph view. The right panel is wider and tabbed
  Context / Info / Graph. Keep it that way rather than adding new permanent
  side panels.
- Client routing is TanStack Router with browser history, not hashes. Canonical
  paths are `/journal`, `/pages`, `/graph` and `/page?p=<note-path-or-title>`.
  All in-app destinations go through `useAppNavigate`; notes set the `p` search
  param and journal/pages/graph are path segments. A title-only `p` resolves to
  an existing note and replaces the URL with the canonical path. A filename
  rename uses `navigate(..., { replace: true })`, not a second history entry.
  Back/forward controls use TanStack history, not a custom atom history.
- `JournalFeed` pages through `GET /notebooks/{id}/journals` newest-first
  (7 at a time) and appends older pages on scroll. Journal entries are editable
  `JournalCard`s built on `LiveMarkdownEditor` with per-card debounced
  autosave; keep them editable rather than reverting to a read-only renderer.
  `Today` opens or creates `journals/YYYY-MM-DD.md`.
- `Pages` opens the All-pages directory (`pagesViewAtom`, `PagesView`), not a
  scroll target. It covers both `pages/` and `journals/` and paginates through
  `GET /notebooks/{id}/pages` (default 20/page, user-selectable 10/20/50/100/200)
  with server-side q/tag/sort/order parameters. `PageOverview` carries the resolved backlink count, tags,
  timestamps and an `is_orphan` flag; the view supports sortable columns, tag
  filtering, text filtering, table/cards modes and page controls.
  Journal/Pages/Graph/note views are mutually exclusive. Use
  `api.createNote(..., { section: "journals" })` for journal pages. Search
  calls `GET /notebooks/{id}/search` and opens results with `useAppNavigate`.
  Search returns match-centered plain-text excerpts; `SearchDialog` highlights
  query terms in titles, excerpts and paths with the `--color-mark` token.
- Graph view (`graphViewAtom`, `GraphView`) and the right-panel Graph tab use
  `GET /notebooks/{id}/graph`. Nodes are all notes; edges only resolved
  wikilinks. `GraphPanel` defaults to the active note's 1-hop neighborhood with
  a Full toggle; `fill` mode is the full-page whole-notebook graph. Keep graph
  data out of the editor's Suspense path.
- `GraphCanvas` owns view state: live force simulation, wheel/button zoom,
  background pan, node drag, reset, and single-click selection. Connected
  nodes animate from `createLiveSimulation`; anchors keep the Logseq seed shape,
  and dragging a node sets its `fx/fy` so link forces pull its neighbours.
  Auto-fit follows the simulation until the user pans or zooms; Reset restores
  the initial seed, fit and simulation. Double-clicking (or Enter on) a node
  uses `useAppNavigate`; a single click only highlights that node's connections.
  Preserve this distinction and the ResizeObserver-driven full-page sizing.
- Journal plugins live in `src/plugins.rs`: a fresh QuickJS runtime per run,
  a read-only `__queryHost` bridge backed by `Store::run_query`, and a
  per-plugin deadline that interrupts JS and bounds Datalog queries. Plugins
  return a generic `{items: [...]}` JSON payload. Do not add filesystem or
  network host APIs. The endpoint is `GET /notebooks/{id}/plugins` and uses
  `OPALNOTE_PLUGIN_TIMEOUT_SECS`.
- Tasks are derived during filesystem sync into the `task` relation from
  markdown checkboxes and Logseq TODO/DOING/DONE/CANCELED keywords. Keep task
  rows in sync with note insert/update/delete and notebook deletion.
- `JournalPluginsPanel` is the right-hand journal rail (desktop only). It loads
  the plugin endpoint, renders generic items, and opens item pages through
  `useAppNavigate`. Journal card saves refresh `notesRevisionAtom` so task
  widgets update after checkbox edits.
- Sidebar section expansion is persisted in `sidebarSectionsAtom`
  (`opalnote.sidebar-sections.v1`), keyed by section title. Panel
  expand/collapse is persisted separately by `leftPanelOpenAtom` and
  `rightPanelOpenAtom`.
- Graph colors are theme tokens in `src/index.css`:
  `--color-graph-bg`, `--color-graph-node`, `--color-graph-node-journal`,
  `--color-graph-edge`, `--color-graph-label`. Keep the SVG using these
  variables rather than hard-coded graph colors; nodes and labels must stay
  readable against the near-white graph surface.
- `graphLayout.ts` follows Logseq's all-pages approach: `d3-force` with
  link distance 82/strength .82, many-body charge -140/distanceMax 420,
  collision radius +10, center force and Logseq's tick-count schedule. Isolated
  pages are placed in deterministic rings around the connected cluster rather
  than being force-simulated. The initial layout is synchronous and
  deterministic; connected nodes then run a live anchored simulation for
  movement and linked-node dragging.
- Backlink counts for the pages table are computed in one pass over
  `NOTEBOOK_LINK_EDGES` and resolved with `note_link_keys`; do not issue a
  backlink query per row.
- An orphan page is an empty body with zero resolved backlinks. The Clean
  action loads `GET /notebooks/{id}/orphans`, shows a custom confirmation
  dialog and deletes selected files through the normal note DELETE route (so
  they land in `data/.trash/`). Do not bypass the trash path.
- New user-visible strings should be plain English; keep the UI quiet and
  keyboard-friendly (⌘K search dialog, ⌘S save).

### Tests

- Pure derivation logic → unit tests in `src/store/markdown.rs`
  (including frontmatter round-trips and malformed wikilinks).
- Store behavior → tests in `src/store/mod.rs` using `tempfile`: folder/file
  layout, external file create/edit/delete, legacy folder migration, cross-
  notebook path collisions, trash behavior.
- Run `pnpm test` before handing work back.

## API contract

Base path `/api`. All routes except `/health` and `/meta` require the bearer
token when `OPALNOTE_TOKEN` is set. Errors are
`{"error":{"code":"...","message":"..."}}`.

Notes are scoped to a notebook and identified by their relative path:

```
GET|PATCH|DELETE /api/notebooks/{notebook}/notes/{*path}
GET /api/notebooks/{notebook}/journals?before=<path>&limit=7
GET /api/notebooks/{notebook}/pages?limit=&offset=&q=&tag=&sort=&dir=
GET /api/notebooks/{notebook}/orphans
GET /api/notebooks/{notebook}/graph
GET /api/notebooks/{notebook}/plugins
```

`POST /api/notebooks/{notebook}/notes` accepts `section: "pages" | "journals"`.
`GET /journals` is a cursor-paginated, newest-first feed. `GET /pages` returns
one page of all notes (pages and journals) with resolved backlink counts;
`total` is the filtered row count. `GET /orphans` returns empty pages with no
backlinks. `GET /graph` returns graph nodes and resolved link edges.

`POST /api/reindex` forces a full filesystem read. The ad-hoc `/api/query`
endpoint is read-only and must keep rejecting `::` system commands.
