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

OpalNote is a **server-first, file-first** note app.

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

`pnpm dev` is a **single command**: it builds the client and runs the debug
server (bound to `0.0.0.0:7827`), then watches `web/src`/`web/public`/web config
files, `plugins/builtin`, and `src`/`Cargo.toml`/`Cargo.lock`/`build.rs`.
Changes are debounced (220 ms). Client and built-in plugin changes restart the
server without a Rust rebuild; Rust source/config changes rebuild the binary.
A failed build keeps the previous server alive. There is no separate Vite dev
server or HMR — reload the browser tab for a new client bundle.

Debug builds read `web/dist` and `plugins/builtin` from disk at runtime. Release
builds embed both via `rust-embed`; `build.rs` only builds `web/dist` for release
builds. Set `OPALNOTE_SKIP_WEB_BUILD=1` to compile a release without Node (a
placeholder page is embedded if no bundle exists).

`.github/workflows/release.yml` is manually triggered and builds an arm64
release from the selected commit. Its release version is `Cargo.toml`'s
version plus the first six commit characters (for example `0.1.0-a1b2c3`).

## Layout

```
package.json       dev / build / start / test scripts (the only task runner)
scripts/           dev orchestration, asset sync, release launcher
src/
  main.rs          startup, logging, graceful shutdown
  config.rs        clap, TOML config, env, config/install-service commands
  state.rs         AppState (Store + auth token)
  auth.rs          optional bearer-token middleware
  assets.rs        release rust-embed / debug disk static handler
  routes/          HTTP API; all handlers run DB work via spawn_blocking
  plugins.rs       release embed / debug disk plugin registry + QuickJS runner
  settings.rs      sparse settings.json store
  store/
    mod.rs         filesystem ↔ index sync, file-first CRUD, Datalog queries
    files.rs       folder layout, atomic writes, scanning, path safety, trash
    queries.rs     CozoScript statements (single source of truth)
    markdown.rs    wikilinks, tags, frontmatter, summaries + unit tests
    model.rs       API-facing serde models
plugins/builtin/ native plugin folders embedded with rust-embed
web/
  package.json     build + typecheck only (no dev server)
  src/api/         typed fetch client + shared types
  src/router.tsx   TanStack route tree and URL/view synchronization
  src/state/       Jotai atoms (async read atoms invalidated by revisionAtom)
  src/components/  workspace shell, home/plugin cards, pages, graph, assets, panels
  src/components/editor/  CodeMirror live editor + link completion
  src/lib/         app navigation, settings, live preview, graph layout
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
- Release builds embed `web/dist` and `plugins/builtin` via `rust-embed`; debug
  builds read them from disk. `scripts/lib.mjs` owns the web build/sync step.
  Any new embedded asset location must be wired through both modes.
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
- Code blocks use the configurable `codeTheme` setting (`--code-*` variables,
  GitHub Light by default) and `@codemirror/language-data` for lazy language
  highlighting. `.cm-live-code-line` maps the selected theme onto the shared
  `--syntax-*` token variables. Keep the copy-button widget on each fenced block
  and do not hard-code a single code surface.
- The single-page editor uses `autoHeight`: the page/main pane scrolls and
  the editor grows with its content. Do not put the editor back in a fixed
  height container with an internal `.cm-scroller` scrollbar. Journal cards
  use the same auto-height renderer and the same `--note-ch` hanging indent.
- The workspace opens on `HomeView` (`homeViewAtom`): today's editable journal
  card, a Favorites section, the three most recently edited pages, a New page
  action, and outstanding todo-plugin items in a sticky right strip. The global top bar hosts the
  **OmniBar**: normal text searches notes, a leading `#` lists tags, and a
  leading `>` lists commands. `Ctrl+M` / leader → `M` enters command mode. Tag
  views prefill `#tag` in the bar. Do not reintroduce the old centered search
  or command dialogs, and do not put search back into `LeftSidebar` or make
  `notesAtom` query-dependent.
- The workspace has collapsible left/right panels (`leftPanelOpenAtom`,
  `rightPanelOpenAtom`), **default collapsed**. The left sidebar owns Home,
  Journals, Pages, Graph and Assets navigation plus Favorites/Recent sections,
  which default collapsed. The right panel is wider and tabbed
  Context / Info / Graph. Keep it that way rather than adding new permanent
  side panels.
- Client routing is TanStack Router with browser history, not hashes. Canonical
  paths are `/<notebook>/home`, `/<notebook>/journal`, `/<notebook>/pages`,
  `/<notebook>/graph`, `/<notebook>/assets`, `/<notebook>/asset/<path>`,
  `/<notebook>/tag/<tag>`, and `/<notebook>/page?p=<note-path-or-title>`, where
  `<notebook>` is the
  URL-encoded notebook name. Unprefixed legacy paths redirect to the selected
  notebook (and remain the no-notebook fallback). All in-app destinations go
  through `useAppNavigate`; notes set the `p` search param and
  home/journal/pages/graph are path segments. A title-only `p` resolves to an
  existing note and replaces the URL with the canonical path. A filename rename
  uses `navigate(..., { replace: true })`, not a second history entry.
  Back/forward controls use TanStack history, not a custom atom history.
- `JournalFeed` pages through `GET /notebooks/{id}/journals` newest-first
  (7 at a time) and appends older pages on scroll. Journal entries are editable
  `JournalCard`s built on `LiveMarkdownEditor` with per-card debounced
  autosave; keep them editable rather than reverting to a read-only renderer.
  Opening the feed ensures today's `journals/YYYY-MM-DD.md` exists (unless the
  presentation lock is active); the sidebar `Today` action opens that page.
- `Pages` opens the All-pages directory (`pagesViewAtom`, `PagesView`), not a
  scroll target. It covers both `pages/` and `journals/` and paginates through
  `GET /notebooks/{id}/pages` (default 20/page, user-selectable 10/20/50/100/200)
  with server-side q/tag/sort/order parameters. `PageOverview` carries the resolved backlink count, tags,
  timestamps and an `is_orphan` flag; the view supports sortable columns, tag
  filtering, text filtering, table/cards modes and page controls.
  Journal/Pages/Graph/note views are mutually exclusive. Use
  `api.createNote(..., { section: "journals" })` for journal pages. Search
  calls `GET /notebooks/{id}/search` and opens results with `useAppNavigate`.
  Search returns match-centered plain-text excerpts; `OmniBar` highlights
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
  network host APIs.
- Native plugins live in `plugins/builtin/OpalNote/<extension>/` and are
  embedded with `rust-embed`; their ids are `OpalNote/<extension>`. Data
  plugins live in `<data-dir>/plugins/<folder>/` and use ids shaped
  `<domain>/<extension>`. Each folder needs `plugin.json` (`id`, `title`,
  `description`) and `plugin.js`. Built-in ids win over data plugins;
  conflicting data folders are reported as load errors. The registry loads at startup and can rescan via
  `POST /api/plugins/reload`; `GET /api/plugins` lists metadata. The journal
  endpoint is `GET /notebooks/{id}/plugins` and uses
  `OPALNOTE_PLUGIN_TIMEOUT_SECS`.
- Tasks are derived during filesystem sync into the `task` relation from
  markdown checkboxes and Logseq TODO/DOING/DONE/CANCELED keywords. Keep task
  rows in sync with note insert/update/delete and notebook deletion.
- `PluginCard` renders generic plugin items and is used by the Home todo strip;
  the journal feed no longer has a plugin rail. Plugin saves refresh
  `notesRevisionAtom` so todo widgets update after checkbox edits.
- `AssetsView` browses the notebook `assets/` folder with server-side search,
  kind filters, sorting and pagination. `AssetDetailView` provides image
  zoom/pan, video/audio players, download/rename actions, and reference
  backlinks. Asset bytes are fetched through the authenticated API as blobs;
  rename updates `assets/<path>` references in notes and reindexes the notebook.
- `TagView` is the `/<notebook>/tag/<tag>` page: editable `JournalCard`s showing
  only the tagged block (plus its indented children), and a page-title jump
  list. Edits are merged back into the full page content by block range. Tag
  clicks everywhere (journal cards, inline editor tags, page tags, right panel,
  pages table) go through `useAppNavigate`. Keep the tag route as a splat so
  tags containing `/` remain one logical tag.
- Sidebar section expansion is persisted in `sidebarSectionsAtom`
  (`opalnote.sidebar-sections.v2`), keyed by section title. Panel
  expand/collapse is persisted separately by `leftPanelOpenAtom` and
  `rightPanelOpenAtom`.
- Graph colors are theme tokens in `src/index.css`:
  `--color-graph-bg`, `--color-graph-node`, `--color-graph-node-journal`,
  `--color-graph-edge`, `--color-graph-label`. Keep the SVG using these
  variables rather than hard-coded graph colors; nodes and labels must stay
  readable against the warm graph surface.
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
- The UI follows the Square design system with a muted greige newsprint canvas
  (primary `#3B82F6`, secondary `#8B5CF6`, success/warning/danger tokens,
  hairline borders, 4px controls and near-square surfaces). Page cards and the
  CodeMirror writing surface use `--color-paper` (`#F8F5EC`, the logo tile) so
  they stand out from the canvas. Default role fonts are Google Sans
  for UI and JetBrains Mono for page titles, note editor, labels and code.
  Inter and Anonymous Pro remain selectable. Use the semantic tokens in
  `web/src/index.css`; do not introduce one-off colors, radii or fonts.
- Settings are sparse overrides in `<data-dir>/settings.json`, served by
  `GET/PUT /api/settings`. System defaults live in `web/src/lib/settings.ts`;
  never persist default values explicitly. The client applies cached IndexedDB
  settings immediately and revalidates from the server on every page load.
  Font roles are interface/display/editor/mono; arbitrary Google Fonts are
  requested over HTTPS. The large SettingsDialog uses left-side tabs.
- Configuration resolves CLI flags → environment variables → TOML config file →
  defaults. The default config is `~/.opalnote/config`; `--config` overrides it.
  `opalnote config` writes a default file, `--upgrade` preserves existing values,
  and `opalnote install-service` writes a systemd user unit defaulting to
  `~/.opalnote/data`.
- HTTPS is enabled by default (`--no-tls` / `OPALNOTE_NO_TLS` disables it).
  `pnpm dev` ensures mkcert certs under `certs/` (gitignored); production can
  pass `--tls-cert` / `--tls-key`. The Docker image defaults to HTTP because
  it has no certificate mount.
- Keyboard shortcuts are declared in `web/src/lib/shortcuts.ts` and dispatched
  by `useKeyboardShortcuts`; do not add ad-hoc global key listeners in
  components. User overrides live under `keybindings` in the sparse settings
  object and are recorded from Settings → Keyboard.
- Default action buttons are ghost-style: transparent surface/border with
  hover feedback. Selected controls keep `bg-accent-soft`/`bg-panel-strong`,
  and primary/danger buttons use semantic text colors rather than solid fills.
- New user-visible strings should be plain English; keep the UI quiet and
  keyboard-friendly (customizable shortcuts; the default leader is `Cmd+/`
  on macOS and `Ctrl+/` elsewhere, then `F` or `S` for the omni bar, `M` for
  command mode and `O` for settings. Save is `Cmd+S` / `Ctrl+S`).

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
GET /api/notebooks/{notebook}/assets?limit=&offset=&q=&kind=&sort=&dir=
GET /api/notebooks/{notebook}/assets/{*path}
GET /api/notebooks/{notebook}/asset?path=
PATCH /api/notebooks/{notebook}/asset
GET /api/notebooks/{notebook}/plugins
POST /api/notebooks/import
GET /api/plugins
POST /api/plugins/reload
GET|PUT /api/settings
```

`POST /api/notebooks/{notebook}/notes` accepts `section: "pages" | "journals"`.
`POST /api/notebooks/import` accepts a multipart `file` ZIP and optional `name`;
it never overwrites an existing notebook and auto-suffixes conflicting names.
`GET /journals` is a cursor-paginated, newest-first feed. `GET /pages` returns
one page of all notes (pages and journals) with resolved backlink counts;
`total` is the filtered row count. `GET /orphans` returns empty pages with no
backlinks. `GET /graph` returns graph nodes and resolved link edges.

`POST /api/reindex` forces a full filesystem read. The ad-hoc `/api/query`
endpoint is read-only and must keep rejecting `::` system commands.
