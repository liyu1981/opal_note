# OpalNote

A server-first, self-hosted notebook with **markdown files as the source of
truth** and a disposable Datalog index that stays in sync.

Open a notebook folder in your editor, drop a page in with `mkdir`, edit files
while the server is running, or import a Logseq graph — the Rust server
reconciles everything into [MnesticDB](https://www.mnesticdb.com/), a CozoDB
fork. The browser is a query UI; it never owns the notes.

## What is canonical

- **Notebooks are folders** under `data/notebooks/<notebook name>/`.
- **Pages are markdown files** under `pages/` and `journals/`.
- **The index is disposable** under `data/index/opalnote.sqlite3` and can be
  deleted at any time; it is rebuilt from files.
- **Tags are file data**: explicit tags live in YAML frontmatter, inline
  `#tags` live in the body.
- **Links are file data**: `[[wikilinks]]` resolve against note titles or paths
  (`[[Journal/2023-03-29]]` works for imported graphs).
- Deletes move files to `data/.trash/` rather than unlinking them.

```
data/
  notebooks/
    My Notes/
      .opalnote.json          # optional description
      pages/
        hello.md
      journals/
        2026-11-12.md
      assets/
  index/
    opalnote.sqlite3          # MnesticDB / SQLite (rebuildable)
  .trash/
    notes/…
    notebooks/…
```

### Synchronization

The index follows the filesystem:

- every notebook folder is scanned at startup;
- every read reconciles the index with the filesystem, so external edits appear
  on the very next request;
- each write is applied to the markdown file atomically, then the affected
  notebook is re-indexed;
- an external file added, edited, renamed or deleted is picked up on the next
  scan;
- `POST /api/reindex` (or the **Rebuild index** button in connection settings)
  forces a full re-read.

Deleting `data/index/` is always safe — the next start rebuilds it.

> Switching from the RocksDB build? The old `data/index/db/` directory is
> ignored; notes are unchanged. You can delete `data/index/db/` after the
> SQLite index has been rebuilt.

> Upgrading from the earlier index-only scaffold? Notes lived in `data/db`
> with UUID ids; this file-first layout does not migrate them. Export or copy
> what you need into `data/notebooks/<name>/pages/` and remove the old
> `data/db`.

## Stack

| Layer    | Choice                                                        |
| -------- | ------------------------------------------------------------- |
| Server   | Rust 2021, Axum 0.8, Tokio                                     |
| Database | [`mnestic`](https://www.mnesticdb.com/) 0.19 (Datalog, SQLite)  |
| Client   | React 19, TanStack Router, CodeMirror 6, TypeScript 7, Jotai 3 |
| Styling  | Tailwind CSS 4                                                 |
| Build    | Vite 8, pnpm, root `package.json` scripts                      |

> `mnestic` publishes its crate under that name but keeps the library target
> `cozo` for drop-in compatibility, so the server imports `cozo::*`.

## Design system

The UI follows the **Square** design skill from
`liyu1981/awesome-design-skills`: minimal white surfaces, primary blue and
secondary violet, success/warning/danger tokens, 4px controls and 8px
surfaces. Default role fonts are **Google Sans** for the interface and
**JetBrains Mono** for page titles, the note editor, labels and code. Inter and
Anonymous Pro remain selectable in Settings. Google Sans, Inter, JetBrains Mono
and Anonymous Pro are self-hosted so the single binary remains
offline-capable.

## Quick start

Requirements: Rust (1.85+), Node 22.12+ / 24, pnpm, a C compiler for bundled
SQLite, and **mkcert** for local HTTPS.

```bash
# development: one command, one process
pnpm dev
```

`pnpm dev` is deliberately not a Vite dev-server + API split. It:

1. installs the web dependencies on first run;
2. builds the client bundle;
3. syncs the bundle into the location the server embeds;
4. rebuilds the Rust server;
5. starts it on **`https://0.0.0.0:7827`**;
6. watches client and server sources.

Changes are debounced for 220 ms, then coalesced:

- a change under `web/src`, `web/public`, or a web config file rebuilds the
  client and restarts the server;
- a change under `src`, `Cargo.toml`, `Cargo.lock`, or `build.rs` rebuilds the
  binary and restarts the server;
- a failed build leaves the current server running and waits for the next edit.

There is no Vite HMR; reload the browser tab after a client rebuild to load the
new bundle. Override the listen address with `OPALNOTE_BIND`, or the data
directory with `OPALNOTE_DATA_DIR`.

HTTPS is on by default. `pnpm dev` creates `certs/localhost.pem` and
`certs/localhost-key.pem` with mkcert if they are missing. Run
`mkcert -install` once so the browser trusts the local CA, then open the
printed `https://` URL. Use `pnpm certs` to regenerate certificates or
`pnpm dev -- --no-tls` for plain HTTP.

```bash
# production: one binary, assets embedded
pnpm build
pnpm start
# or run the artifact directly with certificates:
./target/release/opalnote --data-dir ./data --bind 0.0.0.0:7827 \
  --tls-cert certs/localhost.pem --tls-key certs/localhost-key.pem
```

`pnpm build` runs the same web build + asset sync, then
`cargo build --release --locked`. `build.rs` also builds `web/dist` on demand
for a plain `cargo build`.

### Importing a Logseq graph

Copy the graph into a notebook folder and start (or reindex):

```bash
mkdir -p data/notebooks
cp -a ~/sb-import data/notebooks/sb-import
pnpm dev
```

`Pages/` and `Journal/` are migrated to lowercase `pages/` and `journals/`
during the first scan; `assets/` and `draws/` are left untouched. Note titles
come from filenames, and the sample graph's
`[[Journal/2023-03-29]]` links resolve through journal paths.

### Scripts

| Command             | What it does                                                     |
| ------------------- | ---------------------------------------------------------------- |
| `pnpm dev`          | build, then watch + rebuild + restart on `0.0.0.0:7827`           |
| `pnpm build`        | build web → sync assets → release binary                          |
| `pnpm start`        | run `target/release/opalnote` (pass server args after `--`)       |
| `pnpm build:web`    | client bundle only                                               |
| `pnpm build:server` | release binary only (expects a current `web/dist`)                |
| `pnpm typecheck`    | TypeScript check                                                 |
| `pnpm test`         | Rust tests + TypeScript check                                    |
| `pnpm check`        | `cargo check` + TypeScript check                                 |
| `pnpm fmt`          | `cargo fmt`                                                      |
| `pnpm clean`        | remove `target/` and `web/dist/`                                  |
| `pnpm docker`       | build the container image                                        |

The root `package.json` is the only task runner by design; there is no
Makefile.

### Docker

```bash
docker build -t opal-note .
docker run --rm -p 7827:7827 -v opal-data:/data opal-note
```

The container defaults to HTTP because it has no certificate mount. Mount
`certs/` and set `OPALNOTE_NO_TLS=false` to serve HTTPS.

## Configuration

All flags have environment-variable equivalents.

| Flag                       | Env                           | Default           | Meaning                                                  |
| -------------------------- | ----------------------------- | ----------------- | -------------------------------------------------------- |
| `--bind`                   | `OPALNOTE_BIND`               | `127.0.0.1:7827`  | Listen address (`pnpm dev` forces `0.0.0.0:7827`)        |
| `--data-dir`               | `OPALNOTE_DATA_DIR`           | `./data`          | Root holding `notebooks/`, `index/` and `.trash/`        |
| `--token`                  | `OPALNOTE_TOKEN`              | _(unset)_         | Bearer token for `/api`; unset means open access         |
| `--query-timeout-secs`     | `OPALNOTE_QUERY_TIMEOUT_SECS` | `5`               | Default budget for ad-hoc `/api/query`                   |
| `--plugin-timeout-secs`    | `OPALNOTE_PLUGIN_TIMEOUT_SECS`| `5`               | Per-run QuickJS journal plugin budget                    |
| `--no-tls`                 | `OPALNOTE_NO_TLS`             | `false`           | Serve plain HTTP instead of HTTPS                        |
| `--tls-cert`               | `OPALNOTE_TLS_CERT`           | `certs/localhost.pem` | PEM certificate chain for HTTPS                     |
| `--tls-key`                | `OPALNOTE_TLS_KEY`            | `certs/localhost-key.pem` | PEM private key for HTTPS                      |
| `--dev-cors`               | `OPALNOTE_DEV_CORS`           | `false`           | Permissive CORS for API calls from another origin        |

Logging uses `tracing`: `RUST_LOG=opalnote=debug,tower_http=info`.

`pnpm dev` sets `--bind 0.0.0.0:7827` so the app is reachable from a LAN or
container; override `OPALNOTE_BIND` if you want it loopback-only during
development.

## Architecture

```
┌──────────────────────────────┐        ┌────────────────────────────────────┐
│ React 19 + Jotai             │  HTTP  │ Rust / Axum                        │
│  • read atoms per view       │ ─────► │  routes ──► spawn_blocking         │
│  • revision bump to refresh  │        │              │                     │
│  • no notebook state         │        │              ▼                     │
└──────────────────────────────┘        │        Store (files + Datalog)     │
                                        │         │            │             │
        embedded web/dist               │         ▼            ▼             │
        via rust-embed          ◄────── │   notebooks/*.md   index/db         │
                                        │   (canonical)      (derived)        │
                                        └────────────────────────────────────┘
```

### Files and frontmatter

A page is an ordinary markdown file. Its title is the filename stem:

```
pages/hello.md          → title "hello"
journals/2026-11-12.md  → title "2026-11-12"
```

Explicit tags are read from and written to YAML frontmatter:

```markdown
---
tags:
- journal
- planning
date: "2026-11-12"
---
- body #inline-tag
```

The tag field edits the explicit list; inline `#tags` remain part of the body
and are indexed too. Other frontmatter keys are preserved when saving. The
editor shows the body without frontmatter.

### Editor

The note surface is a block-oriented live preview built on CodeMirror 6:

- **Live** renders headings, emphasis, links, tags, lists, tasks, quotes and
  code in place. The line under the cursor becomes plain markdown source —
  visible markers, normal text size and weight, no rendered inline styling —
  the way Obsidian live preview does. There is no separate source mode.
- Fenced code blocks use a light panel and language-aware syntax highlighting.
  Focusing any line inside the fence reveals the whole block as plain markdown
  source, including both fence markers, with no code or token styling so the
  text is easy to edit. Blur restores the rendered block.
- Type `/` at the start of a source line for a block command menu: headings,
  lists, task, quote, code block, divider, page link and inline code. Arrows
  and Enter apply a command; Escape cancels. The menu does not appear inside
  fenced code blocks.
- **Read only** locks the note for presentation: title/tags are not editable,
  save/delete are hidden, the editor is non-editable, and task checkboxes are
  disabled. Wikilinks stay clickable for navigation.
- Note text, titles and lists use a fixed-width face for easier scanning.
- `[[` opens title/path completion for the current notebook; `[[Beta]]` and
  `[[journals/2026-11-12]]` both resolve.
- Rendered wikilinks are clickable. Clicking a missing page offers to create
  it, which then shows up in the target's backlinks.
- Task checkboxes toggle `[ ]` / `[x]` in the file and autosave.
- Autosave refreshes note/list data without suspending or remounting the
  editor, so focus and the `[[` completion popup survive a save.
- The backlinks panel is fed by the server's `link` relation, so bidi linking
  stays accurate after external edits.

### Workspace layout

The shell follows a Logseq-like split. It opens on the journal feed, which is
the workspace **Home**. The top bar carries search (by default the leader
sequence `Cmd+/` on macOS, `Ctrl+/` elsewhere, then `F` opens an in-page
dialog), back/forward history controls, and a Home button on the right.

- **Left sidebar** — notebook switcher, Favorites, Recent, Journal and Pages.
  Journals open a dedicated feed of **editable journal cards** rather than a
  single page; the feed loads the newest seven pages and appends older pages as
  you scroll. Each card edits its own `journals/YYYY-MM-DD.md` with the live
  block editor and autosaves. Opening the journal feed creates today's empty
  page automatically when it does not exist.
- **Center** — the current page, the journal feed, or the Pages directory. The
  Pages view is a Logseq-style **All pages** table across pages and journals,
  with backlink counts, tags, created/updated timestamps, sortable columns,
  tag filtering, a page filter, table/card modes and server-side pagination.
  A **Clean** action lists empty pages with no backlinks and can move them to
  the server trash after confirmation. Both sidebars start collapsed and can
  be toggled from the top bar, leaving the writing surface to fill the window.
  The single-page editor grows with its content and scrolls the page, not an
  inner editor box; journal cards use the same renderer.
- **Omni bar** — the global header hosts one input for both note search and
  tag navigation. Type normally to search the server's `note:fts` index and
  open a result from the dropdown; type `#` to browse available tags and jump
  to a tag view. Tag pages prefill `#tag` in the bar. The old centered search
  dialog is gone.
- **Command palette** — leader → `P` opens a VS Code-style command search.
  Type to filter every workspace command, use ↑/↓ and Enter to run it, or click
  a row. Each row shows the current, rebindable shortcut.
- **Settings** — a large left-tabbed dialog. Fonts are configured by role
  (interface, titles, editor, labels/code); any Google Font can be named and
  loaded over HTTPS. **Keyboard** lists every workspace shortcut and lets you
  record a replacement chord sequence. Workspace and navigation commands share
  a leader chord (`Cmd+/` on macOS, `Ctrl+/` elsewhere), followed by `F` or
  `S` to focus the omni bar, `H` home, `A` all pages, `G` graph, `L`/`R`
  sidebars, `O` settings, `P` command palette, `N` new page, or `J` today.
  Save is `Cmd+S` / `Ctrl+S`. User overrides are stored as one sparse JSON
  object on the server and cached in IndexedDB for fast startup. An **About** tab shows the
  Opal mark, the project philosophy, and the GitHub source link.
- **Navigation** — TanStack Router browser routes are scoped by notebook name:
  `/<notebook>/journal`, `/<notebook>/pages`, `/<notebook>/graph`,
  `/<notebook>/tag/<tag>`, and `/<notebook>/page?p=<page>`. Back/forward (default `Cmd+[` / `Cmd+]` or
  `Alt+Left` / `Alt+Right`, rebindable in Settings → Keyboard) use browser
  history, and page URLs can be reloaded or shared directly. Switching notebooks
  updates the URL and opens that notebook's journal.
- **Right sidebar** — wider, tabbed **Context** (tags, outgoing links,
  backlinks), **Info** (path and timestamps), and **Graph**. The Graph tab
  renders an interactive local/full notebook graph: click a node to highlight
  its links, double-click to open its page, hover to preview links, and switch
  between the active page's neighborhood and the complete graph. The full graph
  follows Logseq's all-pages layout: d3-force for connected pages and a
  deterministic ring of isolated pages around the connected cluster. Connected
  nodes animate under force; drag a node to pull its neighbours, and use
  zoom/pan/reset controls.
- **Graph view** — the left-sidebar Graph view opens a full-page notebook graph
  using the same resolved-link data, filling the available workspace. Drag the
  canvas to pan, drag nodes to reposition them, zoom with the wheel or buttons,
  and reset the view. It participates in normal back/forward history.
- **Journal tools** — journal view reserves a vertical plugin rail on the
  right (desktop). Plugins run server-side in QuickJS, use read-only Datalog,
  and return JSON items. The built-in todos plugin lists open tasks across the
  notebook; clicking one opens its page. Settings → Plugins shows installed
  plugins and reloads the data plugin folder.
- **Tag view** — `/<notebook>/tag/<tag>` shows every page carrying `#tag` as
  read-only content cards, with a page-title list for fast jumping. Clicking a
  tag in a journal card, page, pages table, right panel, or inline in a note
  opens the corresponding tag view.

### Plugins

Plugins are small JavaScript widgets with a JSON manifest:

```
plugins/builtin/todos/plugin.json   # embedded in the binary
plugins/builtin/todos/plugin.js
<data-dir>/plugins/<id>/plugin.json # loaded at startup / on reload
<data-dir>/plugins/<id>/plugin.js
```

`plugin.json` contains `id`, `title`, and `description`. `plugin.js` is an IIFE
that returns `JSON.stringify({ items: [...] })`; it can call the read-only
`__query(script, params)` bridge and read `__notebook_id`. Built-in ids take
precedence: a data plugin with the same id is rejected and reported in Settings
→ Plugins. Reloading does not require a server restart.

### Client routes

| Route | View |
| --- | --- |
| `/` | Redirects to the selected notebook's journal |
| `/<notebook>/journal` | Journal feed / Home |
| `/<notebook>/pages` | All-pages table |
| `/<notebook>/graph` | Full-page notebook graph |
| `/<notebook>/tag/<tag>` | Pages carrying `#tag` |
| `/<notebook>/page?p=pages/foo.md` | A page by relative path or title |

`<notebook>` is the notebook name, URL-encoded when it contains spaces or
unicode. The old unprefixed routes redirect to the selected notebook and remain
available as a no-notebook fallback.
| `/page?p=Some%20Page` | A page resolved by title |

Routes use clean browser paths plus search params; no hash routing. They are
scoped to the active notebook; switching notebooks returns to `/journal`.
Favorites and recents are stored in the browser, scoped per notebook. A page can be
pinned with the star in the editor toolbar.

Embedding (images/objects) and executable blocks are deliberately out of scope
for this pass.

### Index relations

```
notebook { id => name, description, created_at, updated_at }
note     { notebook_id, path => title, content, summary,
                             mtime_ns, size, created_at, updated_at }
note_tag { notebook_id, note_path, tag }
link     { notebook_id, from_note, target => label }
task     { notebook_id, note_path, line => text, status, updated_at }
```

The index is keyed by relative path, so two notebooks may both contain
`pages/index.md`. A secondary `note:by_notebook` index and a BM25 full-text
index (`note:fts`) keep list and search queries fast.

Tasks are derived from markdown checkboxes and Logseq task keywords during sync.
Writes touching a note plus its tags/links/tasks use MnesticDB's `multi_transaction`,
and every filesystem mutation holds a store-wide lock so scans and sends do not
interleave.

## HTTP API

Base path `/api`. Errors use
`{"error":{"code":"bad_request","message":"..."}}`.

Public (no token): `GET /health`, `GET /meta`.

| Method | Path                                         | Purpose                                        |
| ------ | -------------------------------------------- | ---------------------------------------------- |
| GET    | `/notebooks`                                 | List folders with note counts                  |
| POST   | `/notebooks`                                 | `{name, description?}` — creates the folder    |
| GET    | `/notebooks/{id}`                            | Notebook metadata                              |
| PATCH  | `/notebooks/{id}`                            | `{name?, description?}` — may rename the folder|
| DELETE | `/notebooks/{id}`                            | Move notebook folder to `.trash/`              |
| GET    | `/notebooks/{id}/notes`                      | `?limit=&offset=` newest first                 |
| GET    | `/notebooks/{id}/pages`                      | Paged/filtered pages with backlink counts       |
| GET    | `/notebooks/{id}/orphans`                    | Empty pages with no backlinks                  |
| GET    | `/notebooks/{id}/graph`                      | Nodes and resolved links for the graph         |
| GET    | `/notebooks/{id}/plugins`                    | Journal plugin results (QuickJS + Datalog)     |
| GET    | `/plugins`                                   | Installed plugin metadata + load errors        |
| POST   | `/plugins/reload`                            | Rescan the data plugin folder                  |
| GET    | `/settings`                                  | Sparse user settings JSON                      |
| PUT    | `/settings`                                  | Replace the sparse user settings JSON          |
| POST   | `/notebooks/{id}/notes`                      | `{title?, content?, tags?, section?}`           |
| GET    | `/notebooks/{id}/journals`                   | `?before=<path>&limit=` date-desc feed          |
| GET    | `/notebooks/{id}/search`                     | `?q=&limit=` BM25 search                       |
| GET    | `/notebooks/{id}/tags`                       | Tag counts                                     |
| GET    | `/notebooks/{id}/notes/{*path}`              | Note + tags + links + backlinks                |
| PATCH  | `/notebooks/{id}/notes/{*path}`              | `{title?, content?, tags?}` — may rename file  |
| DELETE | `/notebooks/{id}/notes/{*path}`              | Move the file to `.trash/`                     |
| GET    | `/stats`                                     | Global counts                                  |
| POST   | `/reindex`                                   | Force a full filesystem → index rebuild        |
| POST   | `/query`                                     | Ad-hoc read-only Datalog                       |

`section` is `pages` (default) or `journals`; journal pages are written under
`journals/`. `GET /journals` is cursor-paginated by relative path, newest first.

`id` in note payloads is the relative path (`pages/hello.md`). Paths are
URL-encoded per segment by the client, so spaces and unicode work:

```bash
curl -s 'localhost:7827/api/notebooks/My%20Notes/notes/pages/hello.md'
```

New pages are created in the notebook's existing `pages/` (or `Pages/`, which
is migrated to `pages/`). Duplicate titles get a numeric suffix (`hello 2.md`).
Renaming a page moves its file.

### Querying the index directly

```bash
curl -s localhost:7827/api/query \
  -H 'content-type: application/json' \
  -d '{
    "script": "?[path, title] := *note{notebook_id, path, title}, notebook_id = $nb",
    "params": { "nb": "sb-import" }
  }'
```

Response:

```json
{
  "headers": ["path", "title"],
  "rows": [["pages/Project ideas.md", "Project ideas"]],
  "next": null,
  "took_ms": 2
}
```

`/query` is strictly read-only: system commands (`::`) are rejected, scripts
run with `ScriptMutability::Immutable`, and each call gets a wall-clock and
memory budget. It triggers a sync first, so it reads the current files.

## Project layout

```
package.json         the only task runner: dev / build / start / test
scripts/             dev orchestration, asset sync, release launcher
src/
  main.rs            startup, tracing, graceful shutdown
  config.rs          clap + env
  state.rs           shared AppState
  auth.rs            optional bearer-token middleware
  assets.rs          rust-embed asset + SPA fallback
  routes/            /api handlers (blocking DB work offloaded)
  plugins.rs         embedded/data plugin registry + QuickJS runner
  settings.rs        sparse settings.json store
  store/
    mod.rs           sync engine, file-first CRUD, Datalog queries
    files.rs         folder layout, atomic writes, scanning, trash
    markdown.rs      wikilinks, tags, frontmatter, summaries
    queries.rs       every CozoScript statement
    model.rs         API models
plugins/builtin/     native plugin folders embedded into the binary
web/
  src/api/           typed client + types
  src/router.tsx     TanStack route tree + URL/view synchronization
  src/state/         Jotai atoms
  src/components/    workspace shell, journal feed, pages, graph, panels
  src/components/editor/  live CodeMirror editor surface
  src/lib/           navigation, live preview, completion, editor theme
```

## Security notes

- Journal plugins run in a fresh QuickJS runtime per request with memory, stack
  and wall-clock limits. They get only a read-only Datalog host function; no
  filesystem or network APIs are exposed. Data plugin files are read only at
  startup/reload; the plugin script itself cannot touch the filesystem.
- Without `OPALNOTE_TOKEN`, anyone who can reach the port can read and write
  files under `data/notebooks`. Set a token before exposing the server.
- There is no per-notebook access control — the token is a single-user gate.
- The token is compared in constant time and returned as `WWW-Authenticate:
  Bearer` on 401. The client stores it in `localStorage`.
- `/api/query` cannot write and cannot run `::` system operations, but it can
  read every notebook. Treat the token as full access.
- Path traversal is rejected: note paths must stay inside
  `pages/`/`journals/` under the canonicalized notebook folder.
- Static assets are served without auth so the SPA can load and prompt for a
  token.

## Roadmap / non-goals

- serving notebook `assets/` through the API (images in imported notes are not
  rewritten yet);
- keyset/virtualized pagination at very large notebook sizes;
- real-time collaboration and a sync protocol;
- per-notebook permissions and multi-user accounts;
- CRDT-based collaborative editing;
- true block references and transclusion (the live editor is block-oriented,
  but pages remain plain markdown files);
- embedded images/objects and executable code blocks;
- vector/semantic search — MnesticDB supports HNSW, but no embedder is wired in;
- auto-updating `[[links]]` when a page is renamed.

## License

Server and client code: MIT.

MnesticDB (`mnestic`) is MPL-2.0; it is linked as a library. SQLite is in the
public domain.
