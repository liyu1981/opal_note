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

`README.md` is the user-facing overview (features, setup, usage); the deep
technical reference lives in `doc/architecture.md` and the viewer-plugin guide
in `doc/rich-content.md`. Keep both in sync when behaviour changes.

- Markdown files under `data/notebooks/<notebook>/pages|journals/` are
  canonical.
- MnesticDB (Datalog) is a **disposable index** under `data/index/`, rebuilt
  from files and reconciled before reads.
- The browser holds no notebook state; it queries the server.

Production is a **single binary** with the built web client embedded via
`rust-embed`.

## Design docs

Longer design notes live in `doc/`:

- `doc/plugin-system.md` — journal plugin pipeline and UI schema
- `doc/plugin-ui-expansion.md` — plugin UI expansion phases
- `doc/rich-content.md` — planned asset-backed diagrams: Mermaid (Pele) and
  Excalidraw as two sandboxed iframe `viewer` plugins (a new plugin type)
- `doc/lutez-parser.md` — the `lutez` integration: a CommonMark/GFM parser in Zig
  (submodule `vendor/lutez`, pinned `a8a81bb`, ABI 3, wire 2) that both the Rust
  indexer and the browser call, so a note has one parse. **Implemented** for
  blocks/tasks/tags/links and for the editor's rendering (P3); the legacy
  scanners are gone (P4). Records the re-reviews, the measured corpus parity (§5)
  and every dialect decision (§6).
- `doc/blocks.md` — block plan: **R1** positional blocks (grammar, derived `block`
  index, handles/fold/drag, hash deep links, no markdown changes) is the committed
  scope; references/`^id` are **R2**, deferred. Nothing outside the doc should
  assume block identity or block refs exist

## Stack

- Server: Rust 2021, Axum 0.8, Tokio, rquickjs for sandboxed journal plugins
- Database: `mnestic` crate (MnesticDB, a maintained CozoDB fork); the library
  target is still imported as `cozo`. SQLite backend (bundled SQLite).
- Client: React 19, TanStack Router, CodeMirror 6, TypeScript 7 (`tsc`
  native), Vite 8, Tailwind CSS 4, Jotai 3
- Markdown: `lutez` (CommonMark/GFM in Zig 0.17.0), a git submodule at
  `vendor/lutez`, compiled once into `liblutez.a` (server FFI) and
  `lutez.wasm` (editor)
- Package manager: pnpm

## Commands

```bash
pnpm dev               # build, then watch web/src, builtin/src and src
pnpm build             # built-ins + web build → asset sync → release binary
pnpm build:builtins    # regenerate builtin/plugins and builtin/backgrounds
node scripts/build-lutez.mjs  # rebuild liblutez.a + web/public/lutez.wasm (Zig 0.17.0)
pnpm check:parse       # server vs browser parse parity over data/notebooks
pnpm check:spans       # byte→UTF-16 span mapping (fixtures + every AST node in data/notebooks)
pnpm start             # run opalnote serve
pnpm test              # cargo test + web typecheck
pnpm check             # cargo check + web typecheck
pnpm --dir web build   # web assets only (oj when available, else Vite)
cargo test             # Rust unit tests (Datalog store + markdown parsing)
```

The root `package.json` is the only task runner. Do not add a Makefile,
justfile, or shell-script entry points — add a script there and, if
orchestration is needed, a Node entry under `scripts/`.

`pnpm dev` is a **single command**: it builds the generated built-ins, builds
the client, runs the debug server (bound to `0.0.0.0:7827`), then watches
`web/src`/`web/public`/web config files, `builtin/src`, and
`src`/`Cargo.toml`/`Cargo.lock`/`build.rs`.
Changes are debounced (220 ms). Client and built-in plugin changes restart the
server without a Rust rebuild; Rust source/config changes rebuild the binary.
A failed build keeps the previous server alive. The web build uses `oj build`
when `oj` is on `PATH` and otherwise falls back to `vite build`;
`pnpm --dir web build:watch` is the standalone watcher with the same fallback.
There is no separate Vite dev server or HMR — reload the browser tab for a new
client bundle.

Debug builds read `web/dist`, `builtin/plugins` and `builtin/backgrounds` from
disk at runtime. Release builds embed all three via `rust-embed`; `build.rs`
builds `web/dist` on demand for release builds. `pnpm build:builtins` regenerates
the built-in outputs; `pnpm build:builtins:check` verifies them. Set
`OPALNOTE_SKIP_WEB_BUILD=1` to compile a release without Node (a placeholder
page is embedded if no bundle exists).

`.github/workflows/dev-build.yml` is manually triggered and builds an arm64
development artifact from the selected commit. Its version is `Cargo.toml`'s
version plus the first six commit characters (for example `0.1.0-a1b2c3`), and
it is uploaded to the workflow run rather than creating a GitHub release.

## Layout

```
package.json       dev / build / start / test scripts (the only task runner)
scripts/           dev orchestration, builtin bundling, asset sync, release launcher
src/
  main.rs          startup, logging, graceful shutdown
  config.rs        clap, TOML config, env, config/install-service commands
  build_info.rs    compile-time version/commit/commit-time constants
  update.rs        validated offline self-update + startup replacement
  state.rs         AppState (Store + auth token)
  auth.rs          bearer token + HttpOnly session/CSRF middleware
  session.rs       in-memory browser sessions
  assets.rs        release rust-embed / debug disk static handler
  routes/          HTTP API; all handlers run DB work via spawn_blocking
  plugins.rs       release embed / debug disk plugin registry + QuickJS runner
  backgrounds.rs   built-in + user background registry and asset serving
  settings.rs      sparse settings store (over `opalnote.db`)
  system_db.rs     durable server state: settings row + agent config
  migrations.rs    schema migrations for the durable databases
  store/
    mod.rs         filesystem ↔ index sync, file-first CRUD, Datalog queries
    files.rs       folder layout, atomic writes, scanning, path safety, trash
    queries.rs     CozoScript statements (single source of truth)
    trash.rs       separate trash metadata database + retention records
    markdown.rs    wikilinks, tags, frontmatter, summaries + unit tests
    model.rs       API-facing serde models
builtin/src/       built-in server/client package sources and assets
builtin/plugins/   generated server/client plugin manifests and scripts (rust-embed)
builtin/backgrounds/ generated background manifests/assets (rust-embed)
web/
  package.json     build + typecheck only (no dev server)
  src/api/         typed fetch client + shared types
  src/router.tsx   TanStack route tree and URL/view synchronization
  src/state/       Jotai atoms (async read atoms invalidated by revisionAtom)
  src/components/  workspace shell, home/plugin cards, pages, graph, assets, panels
  src/plugins/types.ts  shared client plugin context/types
  src/components/editor/  CodeMirror live editor + link completion
  src/components/agent/   ReAgent chat mounted in the right panel (lazy)
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
- **One markdown parser, two runtimes.** Blocks, tasks, tags and wikilinks are
  derived from the vendored `lutez` CommonMark/GFM AST — `vendor/lutez` (a git
  submodule pinned by commit, Zig 0.17.0) built by
  `node scripts/build-lutez.mjs` into `liblutez.a` (server) and
  `web/public/lutez.wasm` (editor). Keep that script's `-Dcpu=baseline`: Zig's
  default targets the build machine's CPU, and an archive with AVX-512 or
  `dotprod`/`i8mm`/`sve` instructions kills the server with `Illegal
  instruction` on an older machine (a GitHub ARM runner → an ARM VM does
  exactly that). `OPALNOTE_LUTEZ_CPU=native` is only for a same-machine build.
  The server links the archive in `build.rs` and decodes wire format 2 in
  `src/store/lutez.rs` (ABI/wire checked once at startup); the adapters that turn
  the AST into `ParsedBlock`/`ParsedTask`/tags/links live in `mod lutez_ast` in
  `src/store/markdown.rs` and, for the browser, in `web/src/lib/lutez/`. **There
  is no second parser**: a missing `liblutez.a` is a hard build error, so build
  the archive first (`pnpm build`/`pnpm dev`/Docker/CI do). Change both adapters
  together and re-run `pnpm check:parse` (server rows vs browser rows over
  `data/notebooks`).
- `lutez` is fetched as `/lutez.wasm` and compiled before the first render
  (`web/src/main.tsx` → `loadLutez`). The asset route serves `.wasm` as
  `application/wasm` (the only type `instantiateStreaming` accepts) with
  `no-cache`, and the SPA CSP needs `script-src 'wasm-unsafe-eval'`. There is no
  client fallback parser either: a module that fails to load is a console
  warning and the editor renders plain source without block handles/formatting,
  so `main.tsx` awaits `loadLutez()` before the first render.
- **Three offset spaces, and each one has one job.** The AST carries raw bytes
  (`rawStart/rawEnd` — line numbers, server rows, block hashes), normalized bytes
  (`normStart/normEnd` — CRLF/CR → LF, what the editor's document is) and the
  token payload. CodeMirror indexes UTF-16 units, so a decoration is
  `utf16Mapper(normalizeText(body))` + `span16(node, mapper)` from
  `web/src/lib/lutez/spans.ts`; feeding it `rawStart` shifts every line after the
  first CRLF and every character after a multi-byte one. `pnpm check:spans`
  proves the mapping for every node in the corpus.
- **A note body is parsed once per sync**: `parse_content(&body)` returns blocks,
  tasks, tags and links from one AST walk, and the store feeds `merge_tag_lists`
  (sync) / `merge_tags` (note reads) and `summarize` from it. The individual
  `parse_blocks`/`extract_*` helpers are `#[cfg(test)]` views of that struct —
  never call them from a request path.
- Ordinary note autosaves merge the returned `Note` into local state. Do not
  bump `notesRevisionAtom` for body-only saves: only title/tag/link/backlink
  changes need the notebook-derived lists and graph refreshed.
- Note paths must resolve inside `pages/`/`journals/` via
  `files::resolve_note_path`; reject traversal and escapes.
- Notes are titled by filename stem. Renames move files. Deletes move pages,
  assets and whole notebooks to `data/.trash/entries/<uuid>/` and record the
  original path in the separate `data/.trash/trash.sqlite3` database. Remove
  the note rows in the same operation; restore reindexes the affected notebook.
- Trash retention is `trashRetentionDays` in sparse settings (default 30,
  clamped 1–3650) and is applied to `deleted_at`, not stored per entry. The
  hourly purge task plus `PUT /settings` call `Store::purge_expired_trash`;
  restoring a conflicting path auto-suffixes instead of overwriting.
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
- A **resumed tab or installed PWA is never reloaded**, so `useRevalidateOnResume`
  (mounted in `Workspace`) bumps `notesRevisionAtom` — never `revisionAtom`, which
  would suspend the shell — on visibility, bfcache `pageshow` and `online` after a
  ≥2 s absence. Editors and journal cards then **adopt a changed server copy only
  when they hold no draft** (`NoteEditor`, `JournalCard` compare against the last
  server copy), and `JournalFeed` silently re-reads its loaded first page. A
  resume therefore updates an untouched page but never clobbers unsaved typing.
- Keep API types in `src/api/types.ts` in sync with `src/store/model.rs`.
- `scripts/certs.mjs` / `devCertificateNames()` cover `localhost`, `127.0.0.1`,
  `::1` and every non-internal IPv4 address (plus `OPALNOTE_TLS_HOSTS`);
  `ensureDevCerts` regenerates when the cert no longer covers the current
  addresses. A PWA needs a certificate whose SANs include the exact URL host —
  Chrome blocks the service worker (`not-from-secure-origin`) otherwise.
- PWA app icons are **full-bleed and borderless**: the paper background reaches
  every edge with no inset and no stroke, so iOS/Android masking cannot reveal a
  frame or gap. `web/public/icons/icon.svg` (rounded corners, mark at 78% of the
  canvas) feeds the `any` PNGs, `icon-square.svg` (opaque square, 78%) feeds
  `apple-touch-icon.png` because iOS masks it itself, and `icon-maskable.svg`
  (opaque square, 66% safe zone) feeds the maskable PNG. Edit the SVGs and run
  `pnpm icons` (`scripts/icons.mjs`, headless Chromium) instead of touching the
  PNGs; the script also mirrors `icons/icon.svg` to `public/favicon.svg`, so the
  tab matches the app. Only the in-app mark (`OpalLogo`) keeps a bordered tile,
  because it is drawn on a page rather than masked.
- The web client is an installable **PWA** with deliberately minimal offline
  support: `web/public/manifest.webmanifest` + `icons/` (192/512 `any`, an
  opaque 512 maskable and an opaque apple-touch 180) describe the app, and `web/public/sw.js` caches only
  `/offline.html` and turns a failed navigation into that placeholder. Nothing
  else is cached — notes are server-canonical. `main.tsx` registers the worker
  in production bundles only. `src/assets.rs` serves `sw.js`,
  `manifest.webmanifest`, `offline.html`, `favicon.svg` and the icons with
  `Cache-Control: no-cache` (`must_revalidate`) and maps `.webmanifest` to
  `application/manifest+json`; hashed `assets/` stay immutable for a year. When
  changing the placeholder, bump `CACHE` in `sw.js`.
- Release builds embed `web/dist`, `builtin/plugins` and `builtin/backgrounds`
  via `rust-embed`; debug
  builds read them from disk. `scripts/lib.mjs` owns the web build/sync step.
  Any new embedded asset location must be wired through both modes.
- Use Tailwind theme tokens (`text-ink`, `bg-panel`, `border-line`, …) defined
  in `src/index.css`; do not hard-code new hex colors. When adding a rule next
  to an existing selector list, add a **separate** rule — splicing a selector
  into a shared list silently gives every member the new declarations (a block
  flash rule once turned every editor line into an accent-soft "quote").
- Browser auth lives in `web/src/lib/session.ts`: the server token is exchanged
  for an HttpOnly session cookie, the CSRF token is kept in memory, and the API
  client sends `x-opalnote-csrf` on mutations. Never persist the bearer token
  in `localStorage` (only read it once to migrate an old token). `App` gates
  the router until a session exists; a 401 during that bootstrap opens the
  token form (`ConnectionForm`). A 401 after the app was connected calls
  `markSessionExpired()` and shows the blocking `SessionExpiredDialog`
  ("Session expired — refresh the page"), because the browser cannot mint a
  new session without the server token; the ErrorBoundary uses the same copy
  for atom-level 401s instead of asking for a token. Keep static responses'
  CSP and link-scheme checks (`safeExternalUrl`) intact.
- The main outlet renders the selected background via `MainBackground` from
  the server background registry. Keep it scoped to the route outlet: outside
  `LeftSidebar`, `TopBar` and `RightPanel`, with view `<main>` backgrounds
  transparent so the layer shows. The Dot Grid renderer is adapted from React
  Bits (`components/backgrounds/DotGrid.tsx`); colours come from
  `--color-line-strong` / `--color-accent-strong`, never hard-coded.
- `livePreview` renders from the shared AST (`noteAstField` in
  `web/src/lib/lutez/editor.ts`, one parse per doc-changing transaction):
  fenced blocks (`NodeCodeBlock`, indented code stays prose as it always looked),
  display math, and every inline construct — code spans (any backtick run),
  emphasis/strong/strikethrough with their real marker spans, links/images
  (label and destination from `LinkText`/`LinkDest`, so `![](x.png)` and titles
  work), wikilinks, tags and inline math — come from nodes. Still source-local by
  design: the per-line marker widths that drive the hanging
  indent (headings, quotes, list/task markers), `==highlight==` (not a
  CommonMark/GFM construct, so no node), and bare URLs (GFM text; the editor's
  trailing-punctuation rules are its own).
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
- Fences have **one rule**: a fence may open after a list marker — a
  `-`/`*`/`+` bullet or an ordered `1.`/`1)` (`- ```js`, `1. ```js`) — but only
  a bare fence closes it. `fence_marker` in `src/store/markdown.rs` (via
  `strip_list_marker`) is the server copy; the client uses `fenceOpener`,
  `closesFence` and `fencedLines` from `web/src/lib/markdown.ts` (tags, tasks
  and blocks all consume them). A naive `inFence` toggle let the closing fence
  of a list-child fence *open* a block, which hid every later tag — tag pages
  said "No tagged block found in the page body". Changing this rule means
  bumping both `TASK_RULES_VERSION` and `BLOCK_RULES_VERSION`.
- Task checkboxes are **views of the markdown**: a click toggles the source
  `[ ]`/`[x]` from the widget itself instead of letting the browser toggle the
  input, because the first click after focus left the note used to reveal the
  line as source and swallow the change. The widget also suppresses mousedown
  so ticking a box never moves the caret.
- `/` commands trigger behind block prefixes as well as at line start:
  indentation, quote markers, a bullet or number (with an optional task
  checkbox) and heading marks. Slashes in prose and URLs stay literal.
- Pasting or dropping files onto the editor uploads them through the same
  `insertUploadedFiles` path as `/upload` and inserts `assetMarkdown` at the
  caret or drop point, one per line; the sparse `maxUploadMb` cap applies and
  read-only editors ignore the event. A drop without this handler would
  navigate the browser away from the note.
- Inline tags are marks (`.cm-live-tag`), so `livePreview` opens them on
  `mousedown`: CodeMirror's selection handling would otherwise re-render the
  line as source and destroy the mark before a `click` could land on it.
  Modifier clicks fall through so text selection still works, and the block
  being edited exposes `#tag` as plain source text instead of a mark.
- Asset uploads go through `POST /api/notebooks/{id}/assets` (multipart `file`,
  streamed to disk). The per-file cap is the sparse setting `maxUploadMb`
  (default 4096, clamped 1–102400; `SettingsStore::max_upload_bytes`), so the
  assets route disables axum's fixed `DefaultBodyLimit` and enforces the
  dynamic cap while streaming; the editor pre-checks the same limit from
  `settingsAtom` before uploading. `Store::assets_dir` creates the folder
  and `Store::finalize_asset` renames the temp file to
  `files::unique_asset_path`, which first runs `files::sanitize_asset_name` —
  it drops markdown-hostile characters (`[ ] ( ) < > { } \` * ~ | # ! " \`) and
  lowercases the extension so the generated link needs no escaping — then keeps
  the name and appends a unix timestamp on conflict. Only images, audio,
  video, pdf/office/text documents and archives are accepted; asset responses
  are served with `nosniff` and a sandboxing CSP because they share the app's
  origin. Never write uploads outside `assets/`.
- `assetUrl` (`src/lib/assets.ts`) emits `assets/<path>`, wrapping the
  destination in `<...>` when the name still has spaces or punctuation;
  sanitized upload names usually need neither. Asset rename sanitizes the new
  name the same way and rewrites raw `assets/<path>` references.
- Bare URLs are recognized in the live preview: `https://…` and `www.…` render
  as clickable `ExternalLinkWidget`s (`www.` opens with `https://`), with
  trailing sentence punctuation dropped and balanced parentheses kept. Markdown
  links, images, wikilinks, inline code and fenced code are claimed first, so
  their URLs are never double-handled; the active source line stays raw.
- In the live preview an asset reference renders by kind: `![](assets/x.png)` is
  an image, `![](assets/x.mp4)`/`![](assets/x.mp3)` become `MediaWidget`
  players with native controls, and everything else (plain links included) is an
  `AssetFileWidget` (icon + name) that opens `/<notebook>/asset/<path>` through
  the `onOpenAsset` live-preview option. `assetKindFromPath`/`assetMarkdown` in
  `src/lib/assets.ts` are the single mapping used by both the editor and the
  `/upload` command.
- Tag completion lives in `src/lib/tagCompletion.ts` and is the third
  CodeMirror completion source (after wikilinks and slash commands). Typing `#`
  at the start of a line or after whitespace/opening punctuation opens a picker
  over the notebook's tags with page counts, sorted by count. It inserts
  `#tag ` (no extra space before punctuation) and stays out of fenced/inline
  code, links and `[[Page#Heading]]` targets; a bare `#` at line start is a
  markdown heading, so there it waits for the first tag character.
- Diagram thumbnails are derived state: `data/index/thumbs/<notebook>/<sha256>.png`,
  keyed by asset content, swept by `POST /api/reindex`. The client renders on a
  cache miss through an off-screen viewer frame (`thumbnail: true` →
  `opalnote-viewer/thumbnail { png }`), so keep thumbnail renders fetching asset
  bytes with `no-store` and keep the asset route's `no-cache` for editable text
  assets — a stale read would poison the content-keyed cache. The same PNG is
  the asset page's PNG export.
- The agent's OpalNote provider keeps the upstream credential **encrypted in
  `opalnote.db`** (`agent_config`): the browser derives a key from the user's
  password (PBKDF2-SHA256), encrypts the API key with AES-256-GCM, and uploads
  only the envelope; each request carries the derived key in
  `x-opalnote-agent-key` and the server decrypts for that one call (`src/agent.rs`,
  `src/routes/agent.rs`). Missing/wrong key → `401 agent_locked`. **Only that
  code is a lock.** The proxy relays upstream statuses verbatim, so an upstream
  `401` (bad or expired API key, no credit) also reaches the browser as a 401:
  `buildFetch` parses a clone of the body and locks only on
  `error.code === "agent_locked"`, because dropping a valid derived key for an
  upstream rejection re-prompts for the encryption password and the next send is
  then blocked by the call gate — an unbreakable loop. `api/client.ts` likewise
  skips `markSessionExpired()` for `agent_locked` (it is not a session 401). The unlock
  window is browser-side (memory/`sessionStorage`/`localStorage`), never server
  state, and locking keeps the provider listed so the next request can prompt.
  There is deliberately **no** config-file, env or CLI way to set the agent key —
  the UI is the only writer.
- **Settings → Agent only *sets up* the provider; unlocking lives in the chat.**
  `AgentProviderCard` shows the endpoint/key/password form while nothing is
  configured, and a one-line summary (endpoint, key stored, model count) plus
  "Set up a new configuration" / "Recheck" / "Remove" once a setup is in place.
  It must not unlock, lock, or pick an unlock window: `useOpalNoteCallGate`
  stops a message from a locked provider and `AgentUnlockDialog` (rendered in
  the panel, not in settings) collects the password and the "Keep it" window
  right before the call. Saving a new envelope drops any session key
  (`lockProvider`), so the next send asks for the new password.
- The agent's model list is fetched **through the proxy** (`api.agentModels(key)` →
  `GET /api/agent/v1/models`), never from the browser directly: ReAgent's picker
  only shows models the host-provider config declares, so `AgentProviderCard.save`
  stores the connection first and then `refreshProviderModels` saves the ids it
  gets back. That helper also repairs a stored row with an empty list (on load,
  unlock and `Recheck`) and refreshes the ids when the base URL changes. Do not
  fetch models *before* the config exists (the proxy 404s) and do not call the
  listing while locked (it 401s): the stored ids are reused instead.
- The agent's OpalNote provider is a **server proxy**, not a browser credential:
  `GET /api/agent` reports `{configured, models}` and
  `GET|POST /api/agent/v1/{path}` forwards only `models`, `chat/completions`,
  `responses`, `messages` and `messages/count_tokens` (`src/agent.rs`) to
  the stored `agent_config` row, replacing the auth header with the decrypted
  upstream key and relaying the stream chunk by chunk. Never widen that
  allow-list into a general forwarder or let the client choose the upstream. The
  client side is a ReAgent host provider (`web/src/components/agent/`) whose
  `fetch` hook attaches the derived key and turns `401 agent_locked` into the
  password prompt, plus a `beforeAgentCall` gate (`useOpalNoteCallGate`) that
  stops a call to a *locked* provider before the message is appended — the
  prompt stays in the composer and our unlock dialog opens.
- The agent exposes read-only notebook tools to the model: `search_notes`,
  `list_tags` and `read_note` (`web/src/lib/agentTools.ts`), registered as
  `extraDescriptors` in `AgentPanel` (group `content`, always enabled). They read
  from `activeNotebookIdAtom` at call time and use the existing authenticated
  `api` client, so no extra credential plumbing is needed. Write tools are
  deliberately omitted from this batch.
- ReAgent is a **git submodule** at `web/vendor/reagent` tracking upstream
  `main` (currently `4691e95`), linked as a pnpm workspace package
  (`workspace:*`), because its published tarball has no committed `dist/`. `scripts/build-reagent.mjs` builds
  it (`tsc` in the submodule, skipped when `dist/` is newer than `src/`) and runs
  from `pnpm build`, `pnpm typecheck` and `pnpm build:watch`; `pnpm dev` also
  watches `web/vendor/reagent/src`. Bumping it means updating the submodule
  pointer (`git -C web/vendor/reagent fetch && git -C web/vendor/reagent
  checkout main`) and committing the new submodule SHA. Provider registration
  is a **prop** (`providerFilter` on `<ReAgent>`), not a settings switch. The
  panel registers the OpalNote provider **and** ReAgent's local model server
  (`providerFilter={{ enabled: [OPALNOTE_PROVIDER_ID, OLLAMA_PROVIDER_ID] }}`):
  cloud providers are deliberately left out because they call their vendor
  straight from the browser with a key stored in `localStorage`, while OpalNote
  proxies every cloud call so the credential stays encrypted on the server. The
  SPA CSP's `connect-src` therefore allows `'self'` plus the **loopback** hosts
  (`http://localhost:*`, `http://127.0.0.1:*`) and nothing else, which is what
  makes the local LLM section work; ReAgent probes it on mount, so a machine
  without a local server only logs a failed connection, not a CSP violation.
  Anything on a LAN or behind a tunnel goes in the OpalNote card instead, where
  the proxy makes the request. Two `messages` overrides keep the copy honest:
  the settings subtitle (the key is encrypted on the server, not "in this
  browser") and the empty cloud section (it points at the two supported ways). Docker and the release
  workflows check out submodules recursively. To patch ReAgent locally, edit the
  submodule and commit the change there first, then the pointer here.
- Full-window viewers share `web/src/components/lightbox/Lightbox.tsx`
  (backdrop, header, focus-mode toggle, Escape: exits focus first, then
  closes). `DiagramLightbox` and `ImageLightbox` are thin extensions of it —
  add new lightboxes the same way instead of copying the shell. Editor images
  open the image lightbox on click; Alt/Option-click keeps the caret-in-source
  behaviour so an image-only line stays editable.
- Blocks are **positional only** (`doc/blocks.md` R1): `parse_content` derives
  them from the shared AST in `src/store/markdown.rs`, the sync pass fills the
  `block` relation, and
  nothing is written into the markdown — no ids, no refs. `blockHandles` draws
  the gutter handle, folding, drag, delete and Tab indent; decorations come from
  a `StateField` because CodeMirror rejects block decorations from view plugins.
  `web/src/lib/blocks.ts` reads the same AST through `web/src/lib/lutez/`, and a
  block link is `?p=<path>&block=<hash>&at=<seq>`. Rules changes bump the
  `blocks.rules` marker, like `tasks.rules`.
- Slash commands live in `src/lib/slashCommands.ts` and are a second
  CodeMirror completion source after wikilinks. They trigger when `/` starts the
  line's text behind block prefixes — indentation, quote markers, a bullet or
  number (with an optional task checkbox) and heading marks — and are suppressed
  inside fenced code blocks. Use `apply` callbacks to edit the line, keep Escape and
  arrow/Enter selection behavior from CodeMirror, and keep the wiki-link source
  working after the "Link to page" command. "Upload file" is `kind: "upload"`:
  it clears the typed `/upload`, opens the host file picker, and inserts
  `assetMarkdown` for the uploaded entry once it returns (read-only editors skip
  it).
- Math is KaTeX with `$…$` and `$$…$$` (`web/src/lib/latex.ts` renders and caches
  formulas; `trust: false` keeps `\href`/`\html` inert). Inline formulas are a
  normal `Decoration.replace` in the view plugin; display `$$` blocks replace
  whole lines, and CodeMirror only accepts block decorations from a
  `StateField` ("Block decorations may not be specified via plugins"), so they
  live in `mathBlockField` and follow editor focus through `editorFocusField`.
  Keep `findMathBlocks` skipping fenced code, and keep the inline pass after
  inline code and before emphasis so `$` in code stays literal and `_`/`*`
  inside a formula are not read as markup.
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
- The workspace opens on `HomeView` (`homeViewAtom`): an editable journal card
  with a New page action, followed by a main-area plugin list. The card steps
  back through `‹ Today ›` up to five days (`homeDayOffsetAtom`, 0–5, memory
  only): only today's page is created on open — older days load read-only and
  are created on request ("Write that entry") so merely stepping back never
  writes files. Stepping to a day hands the cursor to its card.
  Favorites and Recent pages are client-side built-in plugins under
  `builtin/src/plugins/OpalNote/`; Open todos and other server plugins share the same
  list. Each of those three sections can be switched off in Settings → Home
  (`homeShowTodos`/`homeShowFavorites`/`homeShowRecent`, sparse booleans,
  default on); HomeView filters both the server plugin list and the built-in
  client plugins by plugin id through one `sectionSwitch` map. There is no
  right plugin strip or plugin section label. The global top bar hosts the
  **OmniBar** (with the Home button beside it): normal text searches notes
  **and** blocks (two sections, notes first), a leading `#` lists tags, and a
  leading `>` lists commands. `Ctrl+Shift+P` / leader → `M` enters command mode; leader → `T` opens tag search. Tag
  views prefill `#tag` in the bar. Do not reintroduce the old centered search
  or command dialogs, and do not put search back into `LeftSidebar` or make
  `notesAtom` query-dependent.
- The workspace has collapsible left/right panels (`leftPanelOpenAtom`,
  `rightPanelOpenAtom`), **default collapsed**. The left sidebar owns Home,
  Journals, Pages, Todos, Graph and Assets navigation plus Favorites/Recent
  sections, which default collapsed. The right panel is wider and tabbed
  Agent / Context / Info / Graph (Agent first and selected by default) and can
  be resized by dragging its left edge, which is capped at half the viewport
  and persisted in `rightPanelWidthAtom` (`RIGHT_PANEL_MIN_WIDTH` 320px,
  double-click or Home resets). Keep it that way rather than adding new
  permanent side panels. Below the `md` breakpoint (768px) both panels are
  drawers: absolutely positioned over the page (z-50, never shrinking the main
  column), with a dimmed backdrop (z-45) that closes them, a capped width
  (`LeftSidebar` `min(19rem,88vw)`, `RightPanel` `min(24rem,100vw-3rem)` via
  `--right-panel-width`), no resize handle, and an open panel closing itself
  once a navigation lands. Keep desktop layout unchanged above `md`.
- The right panel's **Agent** tab lazy-loads `@liyu1981/reagent`
  (`src/components/agent/AgentPanel.tsx`), so `pi-ai`, `pi-agent-core` and
  radix stay out of the main bundle. The agent loop runs in the browser:
  provider keys live in `localStorage`, conversations in IndexedDB under
  `storagePrefix="opalnote"`, and nothing is proxied through the server. It is
  notebook-independent, so the panel still renders (agent tab only) when no
  notebook is selected. ReAgent ships Tailwind utilities, so `src/index.css`
  imports `@liyu1981/reagent/styles.css` and adds
  `@source "../node_modules/@liyu1981/reagent/dist"`; its shadcn-style tokens
  (`--background`, `--card`, `--border`, `--muted-foreground`, …) are mapped
  onto the OpalNote palette in `:root`. `muted`/`accent`/`primary`/`secondary`
  collide with OpalNote theme keys: OpalNote's `@theme` definitions win, and
  `.agent-surface` re-points `--color-muted` so the agent's `bg-muted` chips
  stay light without turning `text-muted` copy pale.
- Omni-bar selections hand focus to the destination view through
  `pendingViewFocusAtom`. Views declare their landing target with
  `useViewAutoFocus` and focus once their content is ready (today's journal,
  newest journal card, tagged page, note editor, first page/todo row, graph
  canvas, first asset or the view itself). Note/tag requests carry a route identity so
  an outgoing view cannot consume the incoming view's request.
- Client routing is TanStack Router with browser history, not hashes. Canonical
  paths are `/<notebook>/home`, `/<notebook>/journal`, `/<notebook>/pages`,
  `/<notebook>/tasks`, `/<notebook>/graph`, `/<notebook>/assets`,
  `/<notebook>/asset/<path>`,
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
  ArrowDown on a card's last line hands focus to the next card, and ArrowUp on
  the first line hands it to the previous card; crossing the last loaded card
  queues and loads the next journal batch. Opening the feed ensures today's
  `journals/YYYY-MM-DD.md` exists (unless the presentation lock is active); the
  sidebar `Today` action opens that page. A `ListFilter` bar (`src/lib/filter.ts`)
  narrows the entries already loaded on the client — no server query — and
  shows `x of y loaded`; keyboard navigation must follow the filtered list. The
  bar matches the entry width. Collapsed — the default — the bar is not
  rendered at all (no space); only an absolutely positioned Filter button sits
  beside the first entry, level with its top. It sits on a sticky, transparent,
  zero-height layer that stays put while the list scrolls; the layer is
  `pointer-events-none` and only the button re-enables pointer events, so it
  never swallows clicks meant for the list. `ListFilter` measures the gutter
  between the list column and its scroll container and floats the button there
  when it fits (wide panes), otherwise it falls back to a compact row above the
  list so it is never clipped. The parent must be `relative` and start at the
  first entry's top. Clicking the button hides it and renders the full-width
  field in flow, which pushes the first entry down, with its own hide button.
  Hiding clears the query so entries never stay silently filtered.
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
  A text query also calls `GET /notebooks/{id}/block-search` and lists block
  rows under the notes (kind glyph, block text, `path · line N`), capped at 3
  per note and 20 overall so one page cannot flood the list; choosing a block
  row opens the note through `useAppNavigate` with `block`/`at`, so it lands on
  and flashes that block. Arrow keys and Enter traverse both sections as one
  list.
- `Todos` opens the todo directory (`tasksViewAtom`, `TasksView`), a read-only
  list over the derived `task` relation with `GET /notebooks/{id}/tasks`
  (default 20/page, user-selectable sizes, server-side `status`/`q`/`sort`/`dir`).
  Rows default to newest first (`sort=updated_at`, `dir=desc`, also the API
  default when no sort is given); choosing `status` keeps the
  open → doing → done → cancelled grouping and only flips the newest/oldest
  order *inside* each status group.
  The status filter is a multi-select (open/doing/done/cancelled, default
  open+doing) persisted in `taskStatusFilterAtom`; `TaskList.counts` always
  covers the whole notebook so the chips show totals while filtered. Rows open
  the owning note through `useAppNavigate`; edits stay in the note editor
  because the list must not race the open editor's autosave. Unknown status
  values are rejected by the route instead of being passed to Datalog.
- Graph view (`graphViewAtom`, `GraphView`) and the right-panel Graph tab use
  `GET /notebooks/{id}/graph`; `?include_tags=true` adds `tag:` nodes (kind
  `tag`) connected to their pages. Nodes are notes/tags; edges are only
  resolved wikilinks or note-tag memberships. `GraphPanel` defaults to the
  active note's 1-hop neighborhood with a Full toggle and a Tags toggle that
  starts enabled; `fill` mode is the full-page whole-notebook graph. In the
  right panel it runs in `panel` mode: compact controls over a canvas that
  fills the tab (measured by its ResizeObserver, so it follows panel resizes)
  instead of the fixed height plugin cards use. Keep graph data out of the
  editor's Suspense path.
- `GraphCanvas` owns view state: live force simulation, wheel/button zoom,
  background pan, node drag, reset, and single-click selection. Connected
  nodes animate from `createLiveSimulation`; anchors keep the Logseq seed shape,
  and dragging a node sets its `fx/fy` so link forces pull its neighbours.
  Auto-fit follows the simulation until the user pans or zooms; Reset restores
  the initial seed, fit and simulation. Double-clicking (or Enter on) a node
  uses `useAppNavigate`. With the `unfoldOnClick` prop a single click **loads that
  node's direct connections** into the graph (`unfoldGraph` + `mergeExpandedLayout`,
  so existing nodes keep their positions and newcomers are seeded beside the node
  that pulled them in) and highlights them; double-click (or Enter) opens the page,
  and Reset folds everything back. Only the right panel's page graph enables it —
  the prop stays off for the full-page notebook graph and plugin graphs, where
  every node is already present, and the hint text follows the flag. In Full scope
  inside the panel a click only highlights.
  Preserve this distinction and the ResizeObserver-driven full-page sizing.
- Plugins have three kinds. `server` plugins run in QuickJS; `client` plugins are
  built into the web bundle; `viewer` plugins are sandboxed iframe bundles
  (`type: "viewer"` with `extensions`, `entry`, `role`) served from the public
  `/static/plugins/{domain}/{extension}/{*path}` route (public, code-only) with
  a CSP of `'self'` plus host-derived sources and
  `Access-Control-Allow-Origin: null` for opaque-origin module/font fetches.
  `resize` messages carry the content's natural `width`, so inline embeds
  shrink to the diagram instead of spanning the line (clamped to 100%).
  Built-in viewers are `sandbox: "same-origin"` so `'self'` keeps them working
  behind any proxy; opaque data viewers use `X-Forwarded-Host`/`Forwarded`/`Host`
  and the `--csp-host` / `OPALNOTE_CSP_HOSTS` escape hatch.
  Built-in viewers (`builtin/src/plugins/OpalNote/mermaid`,
  `OpalNote/excalidraw`) bundle their engine into
  `builtin/plugins/<id>/viewer.js` and are excluded from the client plugin
  index. A viewer manifest may declare `csp` (only `connect-src`, `font-src`,
  `img-src`, `media-src`, `style-src` with `'self'`/`data:`/`blob:`) to extend
  the sandbox policy for its own files; scripts and framing stay host-owned.
  See `doc/rich-content.md`.
- Journal plugins live in `src/plugins.rs`: a fresh QuickJS runtime per run,
  a read-only `__queryHost` bridge backed by `Store::run_query`, and a
  per-plugin deadline that interrupts JS and bounds Datalog queries. Plugins
  return a generic `{items: [...]}` JSON payload. Do not add filesystem or
  network host APIs.
- Notebook imports accept ZIP or gzip-compressed tar. Detect the archive by
  magic bytes, reject unknown formats, cap both compressed and extracted bytes,
  and normalize entry paths through the same allow-listed folder mapping as ZIP
  imports. Never extract tar symlinks, hard links or device nodes.
- `build.rs` embeds `OPALNOTE_BUILD_VERSION`, `OPALNOTE_BUILD_COMMIT`,
  `OPALNOTE_BUILD_COMMIT_TIME` (git commit `%ct`) and `OPALNOTE_BUILD_CHANNEL`
  in every build. Keep the metadata emission before the debug early return.
- Self-update is split into two explicit steps. `opalnote serve` only applies
  `<update-dir>/candidate/{opalnote,manifest.json}` at startup in release builds;
  it does not poll GitHub. Compare semver first and commit time as the
  tie-breaker; validate target/size/optional SHA-256; copy beside the current
  executable, prove the copy runs (`--version`) and only then atomically rename
  it into place; delete the candidate after success. Debug builds and
  `--no-self-update` skip the startup apply. A successful apply **re-execs** the
  new binary in place, so one `serve` start both installs and runs it: the
  `AppliedUpdate` carries the target path captured before the rename, because
  `/proc/self/exe` reports `(deleted)` afterwards, and `exec` keeps the original
  argv (a bare `Command::new` would start the server with no arguments). A
  candidate that does not start is refused and the old binary keeps serving —
  `exec` cannot be undone.
- `opalnote update` performs discovery and downloads a candidate for the next
  restart, and is intended for cron. The `release` channel uses the public
  GitHub `releases/latest` API (with an optional `manifest.json` asset); the
  `dev` channel uses authenticated `gh` and the newest unexpired
  `opalnote-*-<arch>` Actions artifact.
- Backgrounds are declarative plugins, not sandboxed JS. Built-in sources live
  in `builtin/src/backgrounds/<folder>/package.json`, with the final manifest
  in `opal_note` and assets copied into `builtin/backgrounds/<folder>/` by the
  build tool. Users add `<data-dir>/backgrounds/<folder>/background.json` plus
  optional assets. The
  manifest id is `<domain>/<extension>`; built-in ids win and bad folders are
  reported as load errors. Supported kinds are `none`, `dot-grid`, `image`
  (requires `options.asset`), `gradient`, `galaxy`, `grid-scan`,
  `letter-glitch` and `shape-grid`; the default is `OpalNote/grid-scan`.
  Keep asset access inside the
  registered folder; serve it through `/api/backgrounds/asset`, never a raw
  filesystem path. Selection is `backgroundId` in sparse settings; per-background
  speed overrides live in `backgroundOptions[id]`. Grid Scan defaults to a slow
  10 s sweep with a 5 min delay, and Letter Glitch to 0.25× speed; expose both
  Grid Scan controls and the Letter Glitch speed in Settings → Background.
- Built-in server plugin sources live in `builtin/src/plugins/<domain>/<extension>/`.
  Each package has a `package.json`; `opal_note.type` is `server` or `client`,
  `opal_note` holds the final manifest and `opal_note_build` holds the esbuild
  entry/target/minify settings. Server source modules default-export a function
  returning `{ items, ui? }`; client source modules default-export a
  `BuiltinClientPlugin`. The build tool writes server output to
  `builtin/plugins/<id>/` and client output to `builtin/plugins/<id>/`.
  Client plugins may consume `HomePluginContext`; server plugins only receive
  QuickJS/Datalog data.
  Data plugins live in `<data-dir>/plugins/<folder>/` with final
  `plugin.json`/`plugin.js` files. Built-in ids win over data plugins;
  conflicting data folders are reported as load errors. The registry loads at startup and can rescan via
  `POST /api/plugins/reload`; `GET /api/plugins` lists metadata. The journal
  endpoint is `GET /notebooks/{id}/plugins` and uses
  `OPALNOTE_PLUGIN_TIMEOUT_SECS`. Plugin results may include an optional `ui`
  descriptor: either a safe `kind` or a versioned declarative schema (`schema:
  1`, `root`). Schema nodes include the basic layout primitives plus
  `markdown` (read-only live editor) and `graph` (notebook graph with optional
  scope/includeTags/height). Supported actions are `openNote`, `openTag`,
  `openExternal`, and `runCommand`; validate and bound UI depth, node count,
  strings, URLs, and payload size on both server and client.
- Tasks are derived during filesystem sync into the `task` relation from
  markdown checkboxes and Logseq TODO/DOING/DONE/CANCELED keywords. The task set
  itself comes from the shared AST (only `-`/`*`/`+` list items count, ordered
  items do not) with the marker read from the item's own source line; the
  client's `taskSignature` uses the same AST through WASM. Keep task
  rows in sync with note insert/update/delete and notebook deletion.
  A body edit can therefore change derived data, so saves that move the task set
  bump **`tasksRevisionAtom`** (`refreshTasksAtom`), never `notesRevisionAtom`:
  the todo list and the Home plugin list listen to it, while `notesRevisionAtom`
  would invalidate `notesAtom`/`tagsAtom` and suspend the open route (a visible
  whole-page flash). `EditorPane` compares `taskSignature(previous.content)` with
  the saved content, and `JournalCard` does the same after a save **and** after
  its unmount flush (the next view, e.g. Todos, may already be mounted and must be
  told). The task set comes from the shared AST on both sides: `task_row` in
  `src/store/markdown.rs` (`mod lutez_ast`) and `taskRow` in
  `web/src/lib/lutez/parse.ts` must agree — only `-`/`*`/`+` list items count
  (ordered ones do not), any whitespace run after the bullet is accepted (the
  editor renders `-  [ ] x` and `-\t[ ] x` as checkboxes), `[ ]`/`[x]`/`[-]` and
  the Logseq keywords, and fenced code never yields a task because the AST has no
  items inside a fence. `pnpm check:parse` compares the two on the corpus. Bump
  `TASK_RULES_VERSION` in `Store::take_task_rules_backfill` whenever extraction
  starts matching more or fewer lines: the `data/index/tasks.rules` marker then
  forces one full re-read, because unchanged files are skipped by the scan.
  `BLOCK_RULES_VERSION`/`blocks.rules` does the same for the block grammar
  (currently **4** and **2**), and both markers go through
  `Store::take_rules_marker`.
- `PluginHost` dispatches plugin results to a safe renderer kind, the
  declarative schema renderer, or the legacy item card. `PluginCard` remains
  the todo-kind/legacy fallback. Home renders every server plugin result plus
  client-side Favorites and Recent plugins generated under `builtin/plugins/`.
  `HomePluginContext` exposes notes, favorites, browser recents, link data, and
  navigation actions to those built-in plugins. The journal feed has no plugin
  rail. Plugin saves refresh `journalPluginsRevisionAtom` so widget data updates
  after checkbox edits.
- `AssetsView` browses the notebook `assets/` folder with server-side search,
  kind filters, sorting and pagination. `AssetDetailView` provides image
  zoom/pan, video/audio players, download/rename actions, and reference
  backlinks. Asset bytes are fetched through the authenticated API as blobs;
  rename updates `assets/<path>` references in notes and reindexes the notebook.
- `TagView` is the `/<notebook>/tag/<tag>` page: editable `JournalCard`s showing
  only the tagged block (plus its indented children), and a page-title jump
  list. Edits are merged back into the full page content by block range. Tag
  clicks everywhere (journal cards, inline editor tags, page tags, right panel,
  pages table) go through `useAppNavigate`. Tag cards use the same cross-card
  arrow-key navigation as journal cards. Its `ListFilter` narrows the loaded
  cards and the jump list together, resets when the tag changes, and follows
  the same collapsed-button → full-width-field pattern as the journal feed. Keep the
  tag route as a splat so tags containing `/` remain one logical tag.
- Sidebar section expansion is persisted in `sidebarSectionsAtom`
  (`opalnote.sidebar-sections.v2`), keyed by section title. Panel
  expand/collapse is persisted separately by `leftPanelOpenAtom` and
  `rightPanelOpenAtom`.
- Graph colors are theme tokens in `src/index.css`:
  `--color-graph-bg`, `--color-graph-node`, `--color-graph-node-journal`,
  `--color-graph-node-tag`, `--color-graph-edge`, `--color-graph-label`. Keep the SVG using these
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
  they land in the trash). Do not bypass the trash path.
- `TrashView` is the global `/<notebook>/trash` bin (also the bare `/trash`
  fallback when no notebook exists, and `nav.trash` in the command
  palette/sidebar). It lists pages, journals, assets and notebooks, previews
  note text or image assets, restores through `POST /trash/{id}/restore` and
  permanently deletes through `DELETE /trash/{id}`. Trash is data-dir-wide, not
  notebook-scoped, so deleting the last notebook must not strand its entry.
- The UI follows the Square design system with a muted greige newsprint canvas
  (primary `#3B82F6`, secondary `#8B5CF6`, success/warning/danger tokens,
  hairline borders, 4px controls and near-square surfaces). Page cards and the
  CodeMirror writing surface use `--color-paper` (`#F8F5EC`, the logo tile) so
  they stand out from the canvas. Default role fonts are Google Sans
  for UI and JetBrains Mono for page titles, note editor, labels and code.
  Inter and Anonymous Pro remain selectable. Use the semantic tokens in
  `web/src/index.css`; do not introduce one-off colors, radii or fonts.
- Durable server state — sparse settings and the agent provider configuration —
  lives in `<data-dir>/opalnote.db` (`src/system_db.rs`), never in
  `data/index/` and never in a new ad-hoc file ([ADR 0001](doc/adr/0001-durable-server-state.md)).
  Schema changes go through the ordered list in `src/migrations.rs`
  (`schema_migrations` relation): add a new version, never edit a shipped one,
  prefer `Create`/`Drop` steps (idempotent) and `:put` in `Script` steps so a
  half-applied migration can be retried. A database recorded with a newer
  version than the build is refused rather than downgraded.
- Settings are sparse overrides in `<data-dir>/opalnote.db` (`app_settings`),
  served by
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
  keyboard-friendly (customizable shortcuts; the default leader is `Cmd+;`
  on macOS and `Ctrl+;` elsewhere, then `F` or `S` for the omni bar, `T` for
  tag search, `D` for todos, `M` for command mode and `O` for settings.
  Back/forward are `Cmd+; [` / `Cmd+; ]` or `Ctrl+; [` / `Ctrl+; ]`; the
  keyboard settings tab
  also lists native CodeMirror editor bindings. Save is `Cmd+S` / `Ctrl+S`).

### Tests

- Pure derivation logic → unit tests in `src/store/markdown.rs`
  (including frontmatter round-trips and malformed wikilinks).
- Store behavior → tests in `src/store/mod.rs` using `tempfile`: folder/file
  layout, external file create/edit/delete, legacy folder migration, cross-
  notebook path collisions, trash behavior.
- Run `pnpm test` before handing work back.

## API contract

Base path `/api`. `GET /health`, `GET /meta`, and `POST|DELETE /session` are
public. Other routes accept either `Authorization: Bearer` (API clients) or an
HttpOnly session cookie when `OPALNOTE_TOKEN` is set; cookie-authenticated
mutations also require `x-opalnote-csrf`. Errors are
`{"error":{"code":"...","message":"..."}}`.

Session flow:

```
POST /api/session {"token":"..."}  # optional token when OPALNOTE_TOKEN is set
  -> HttpOnly opalnote_session cookie + {csrf_token}
DELETE /api/session                 # clear the session
```

Notes are scoped to a notebook and identified by their relative path:

```
GET|PATCH|DELETE /api/notebooks/{notebook}/notes/{*path}
GET /api/notebooks/{notebook}/journals?before=<path>&limit=7
GET /api/notebooks/{notebook}/pages?limit=&offset=&q=&tag=&sort=&dir=
GET /api/notebooks/{notebook}/tasks?limit=&offset=&status=&q=&sort=&dir=
GET /api/notebooks/{notebook}/orphans
GET /api/notebooks/{notebook}/graph?include_tags=true
GET /api/notebooks/{notebook}/assets?limit=&offset=&q=&kind=&sort=&dir=
GET|DELETE /api/notebooks/{notebook}/assets/{*path}
GET /api/notebooks/{notebook}/asset?path=
PATCH /api/notebooks/{notebook}/asset
GET /api/notebooks/{notebook}/plugins
POST /api/notebooks/import
GET /api/plugins
POST /api/plugins/reload
GET /api/backgrounds
POST /api/backgrounds/reload
GET /api/backgrounds/asset?id=&path=
GET|PUT /api/settings
GET /api/trash?limit=&offset=&q=&kind=&sort=&dir=
GET /api/trash/{id}
GET /api/trash/{id}/content
POST /api/trash/{id}/restore
DELETE /api/trash/{id}
```

`POST /api/notebooks/{notebook}/notes` accepts `section: "pages" | "journals"`.
`POST /api/notebooks/import` accepts a multipart `file` archive (ZIP, `.tar.gz`
or `.tgz`) and optional `name`; it never overwrites an existing notebook and
auto-suffixes conflicting names.
`GET /tasks` lists derived tasks for the todo directory: `status` is a
comma-separated `open,doing,done,cancelled` filter (unknown values are a 400)
and the response carries the filtered page plus notebook-wide status counts.
`GET /journals` is a cursor-paginated, newest-first feed. `GET /pages` returns
one page of all notes (pages and journals) with resolved backlink counts;
`total` is the filtered row count. `GET /orphans` returns empty pages with no
backlinks. `GET /graph` returns graph nodes and resolved link edges.

`POST /api/reindex` forces a full filesystem read. The ad-hoc `/api/query`
endpoint is read-only and must keep rejecting `::` system commands.
