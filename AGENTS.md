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

- Server: Rust 2021, Axum 0.8, Tokio
- Database: `mnestic` crate (MnesticDB, a maintained CozoDB fork); the library
  target is still imported as `cozo`. SQLite backend (bundled SQLite).
- Client: React 19, CodeMirror 6, TypeScript 7 (`tsc` native), Vite 8,
  Tailwind CSS 4, Jotai 3
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
  store/
    mod.rs         filesystem ↔ index sync, file-first CRUD, Datalog queries
    files.rs       folder layout, atomic writes, scanning, path safety, trash
    queries.rs     CozoScript statements (single source of truth)
    markdown.rs    wikilinks, tags, frontmatter, summaries + unit tests
    model.rs       API-facing serde models
web/
  package.json     build + typecheck only (no dev server)
  src/api/         typed fetch client + shared types
  src/state/       Jotai atoms (async read atoms invalidated by revisionAtom)
  src/components/  collapsible left sidebar, journal feed, tabbed right panel
  src/components/editor/  CodeMirror live editor + link completion
  src/lib/         live preview, editor theme, journal helpers, markdown
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
  and are invalidated by bumping `revisionAtom` via `refreshAtom`.
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
- The workspace has collapsible left/right panels (`leftPanelOpenAtom`,
  `rightPanelOpenAtom`), **default collapsed**. The left sidebar owns Journals,
  Pages, Favorites, Recent and a Graph placeholder. The right panel is wider
  and tabbed Context / Info / Graph. Keep it that way rather than adding new
  permanent side panels.
- `JournalFeed` pages through `GET /notebooks/{id}/journals` newest-first
  (7 at a time) and appends older pages on scroll. Journal entries are editable
  `JournalCard`s built on `LiveMarkdownEditor` with per-card debounced
  autosave; keep them editable rather than reverting to a read-only renderer.
  `Today` opens or creates `journals/YYYY-MM-DD.md`.
- `Pages` opens a dedicated placeholder view (`pagesViewAtom`, `PagesView`),
  not just a scroll target. Journal/Pages/note views are mutually exclusive.
  Use `api.createNote(..., { section: "journals" })` for journal pages.
- New user-visible strings should be plain English; keep the UI quiet and
  keyboard-friendly (⌘K search, ⌘S save).

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
```

`POST /api/notebooks/{notebook}/notes` accepts `section: "pages" | "journals"`.
`GET /journals` is a cursor-paginated, newest-first feed.

`POST /api/reindex` forces a full filesystem read. The ad-hoc `/api/query`
endpoint is read-only and must keep rejecting `::` system commands.
