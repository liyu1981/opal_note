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
- Deletes move pages, assets and whole notebooks to `data/.trash/` rather than
  unlinking them. A separate `data/.trash/trash.sqlite3` record database keeps
  the original notebook/path, and entries are permanently deleted after
  `trashRetentionDays` (default 30).

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
    trash.sqlite3            # recoverable entries + original paths
    entries/<uuid>/…         # payload files, assets and notebook folders
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
`liyu1981/awesome-design-skills`: a muted greige newsprint canvas, warm
`#F8F5EC` page and editor surfaces matching the Opal mark, hairline borders,
primary blue and secondary violet, success/warning/danger tokens, and
near-square surfaces. Default role fonts are **Google Sans** for the interface and
**JetBrains Mono** for page titles, the note editor, labels and code. Inter and
Anonymous Pro remain selectable in Settings. Google Sans, Inter, JetBrains Mono
and Anonymous Pro are self-hosted so the single binary remains
offline-capable.

## Development builds

A manually triggered GitHub Actions workflow builds an **arm64 development
artifact** from the selected commit; pushing a `v*` tag also runs
`.github/workflows/release.yml` to attach the tarball and manifest to a GitHub
release. The artifact version is the Cargo package
version plus the first six characters of the commit hash, e.g.
`0.1.0-a1b2c3`. It is uploaded to the workflow run as a downloadable artifact;
the workflow does not create a GitHub release.

`scripts/download_github_artifact.sh` lists recent artifacts newest first,
downloads the selected one with `gh`, and extracts the nested tarball under
`./artifacts/<artifact-name>/` (relative to the current directory, so it can be
run from anywhere). Pass `--latest` to skip the prompt or `--help` for options.

## Quick start

Requirements: Rust (1.85+), Node 22.12+ / 24, pnpm, a C compiler for bundled
SQLite, and **mkcert** for local HTTPS.

```bash
# development: one command, one process
pnpm dev
```

`pnpm dev` is deliberately not a Vite dev-server + API split. It:

1. installs the root and web dependencies on first run;
2. builds the generated built-in plugins and backgrounds;
3. builds the client bundle;
4. starts the debug server;
5. watches client, server and built-in sources.

Debug builds deliberately **do not embed** `web/dist`, `builtin/plugins` or
`builtin/backgrounds`.
The debug server reads all three directly from disk, so Rust only needs
rebuilding when Rust source/config changes.

Changes are debounced for 220 ms, then coalesced:

- a change under `web/src`, `web/public`, or a web config file rebuilds the
  client and restarts the server;
- a change under `builtin/src` rebuilds the generated built-ins and restarts
  the server without compiling Rust;
- a change under `src`, `Cargo.toml`, `Cargo.lock`, or `build.rs` rebuilds the
  binary and restarts the server;
- a failed build leaves the current server running and waits for the next edit.

The client build uses `oj build` when `oj` is on `PATH`, and falls back to
`vite build` otherwise. `pnpm --dir web build:watch` starts a standalone
rebuild watcher with the same `oj`/Vite fallback. There is no Vite HMR; reload
the browser tab after a client rebuild to load the new bundle. Override the listen address with `OPALNOTE_BIND`, or the data
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
./target/release/opalnote serve --data-dir ./data --bind 0.0.0.0:7827 \
  --tls-cert certs/localhost.pem --tls-key certs/localhost-key.pem
```

`pnpm build` builds the generated built-ins, then the web client and asset
sync, then `cargo build --release --locked`. Release builds embed `web/dist`,
`builtin/plugins` and `builtin/backgrounds`; `build.rs` builds `web/dist` on
demand for a plain release build. Debug builds skip that embed step and read
all three directories at runtime.

Use `pnpm build:builtins` to regenerate the built-in outputs and
`pnpm build:builtins:check` to verify they match `builtin/src`.

### Self-updates

Release builds embed their package version, commit hash and **commit time**.
On startup they check:

```text
<update-dir>/candidate/
  opalnote
  manifest.json
```

The default update directory is `~/.opalnote/updates`; override it with
`--update-dir`, `OPALNOTE_UPDATE_DIR`, or `update_dir` in the TOML config.
Candidate manifests contain:

```json
{
  "version": "0.1.0",
  "commit": "abc1234",
  "commit_time": 1770000000,
  "target": "aarch64-unknown-linux-gnu",
  "sha256": "...",
  "size": 29384756
}
```

A candidate is applied only when its semantic version is newer, or the version
is equal and its commit time is newer. The binary is validated (target, size,
optional SHA-256), copied to a temporary file beside the running executable,
and atomically renamed into place. The running process keeps the old image;
the new version starts on the next restart. The candidate directory is deleted
after a successful replacement.

The server does **not** pull updates automatically. It only applies a pending
candidate from `<update-dir>/candidate/` when `opalnote serve` starts, in
release builds. Use `--no-self-update` or `OPALNOTE_NO_SELF_UPDATE=true` to
disable that startup check.

Run the download step explicitly:

```bash
opalnote update
opalnote update --update-channel dev
opalnote update --update-dir ~/.opalnote/updates
```

`opalnote update` checks the selected channel, downloads a newer candidate and
leaves it staged for the next restart. The `release` channel queries GitHub's
public `releases/latest` API over HTTPS and prefers a matching `manifest.json`
asset. The `dev` channel uses the authenticated `gh` CLI to read the newest
unexpired `opalnote-*-<arch>` Actions artifact, so the service user needs `gh`
on `PATH` and must have run `gh auth login`.

This command is designed to run from cron:

```cron
0 4 * * * /usr/local/bin/opalnote update >> ~/.opalnote/update.log 2>&1
```

Cron downloads the candidate; the running server is unchanged. The new binary
starts on the next service restart.

`opalnote --version` prints the build version, channel, commit and commit time;
`GET /api/meta` exposes the same build fields.

### Importing a Logseq graph

Use the notebook import button in the left sidebar to upload a Logseq-format
ZIP or gzip-compressed tar (`.tar.gz` / `.tgz`). The archive may contain
`pages/`, `journals/`, `assets/` and `draws/` directly or inside one wrapper
folder. Existing notebooks are never overwritten; if the requested name exists,
the server imports as `<name> 2`, `<name> 3`, and so on, and the UI reports the
chosen name.

You can also copy a graph into a notebook folder manually and start/reindex:

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
| `pnpm start`        | run `opalnote serve` (pass server args after `--`)                |
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

All server flags have environment-variable equivalents. Values are resolved in
this order: **CLI flags → environment variables → config file → defaults**.

The default config file is `~/.opalnote/config`; override it with `--config`.
The file is TOML:

```toml
version = 1
bind = "127.0.0.1:7827"
data_dir = "./data"
token = ""
update_dir = "~/.opalnote/updates"
no_self_update = false
update_repo = "liyu1981/opal_note"
update_channel = "release"
query_timeout_secs = 5.0
plugin_timeout_secs = 5.0
no_tls = false
tls_cert = "certs/localhost.pem"
tls_key = "certs/localhost-key.pem"
dev_cors = false
```

Server command:

```bash
opalnote serve --data-dir ./data --bind 127.0.0.1:7827
```

Running `opalnote` with no subcommand prints the CLI help. The serving flags
listed below belong to `opalnote serve`.

Config commands:

```bash
opalnote config                 # write ./config with current defaults
opalnote config --path ./config --force
opalnote config --upgrade       # add new keys, preserve existing values
```

`opalnote install-service` writes a systemd **user** service to
`~/.config/systemd/user/opalnote.service`. It defaults to
`~/.opalnote/data` and the default config path. Use `--data-dir`, `--binary`
or `--force` to customize it; the command prints the enable commands.

| Flag                       | Env                           | Default           | Meaning                                                  |
| -------------------------- | ----------------------------- | ----------------- | -------------------------------------------------------- |
| `--config`                 | —                             | `~/.opalnote/config` | TOML configuration file                              |
| `--bind`                   | `OPALNOTE_BIND`               | `127.0.0.1:7827`  | Listen address (`pnpm dev` forces `0.0.0.0:7827`)        |
| `--data-dir`               | `OPALNOTE_DATA_DIR`           | `./data`          | Root holding `notebooks/`, `index/` and `.trash/`        |
| `--token`                  | `OPALNOTE_TOKEN`              | _(unset)_         | Bearer token for `/api`; unset means open access         |
| `--update-dir`             | `OPALNOTE_UPDATE_DIR`         | `~/.opalnote/updates` | Pending update candidate directory                     |
| `--no-self-update`         | `OPALNOTE_NO_SELF_UPDATE`     | `false`           | Do not apply a pending candidate on `serve` startup      |
| `--update-repo`            | `OPALNOTE_UPDATE_REPO`        | `liyu1981/opal_note` | Repository used by `opalnote update`                   |
| `--update-channel`         | `OPALNOTE_UPDATE_CHANNEL`     | `release`         | `release` or `dev` channel used by `opalnote update`     |
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

- **Live** renders headings, emphasis, links, tags, lists, tasks, quotes,
  images and code in place. The line under the cursor becomes plain markdown source —
  visible markers, normal text size and weight, no rendered inline styling —
  the way Obsidian live preview does. There is no separate source mode.
- Fenced code blocks use configurable syntax themes (GitHub Light by default),
  language-aware highlighting, and a copy button.
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

The shell follows a Logseq-like split. It opens on the **Home** dashboard:
today's editable journal card, a Favorites section, the three most recently
edited pages, a New page action, and a right-hand strip of outstanding todos.
The top bar carries the omni search bar with the Home button beside it, plus
back/forward history controls.

- **Left sidebar** — notebook switcher plus Home, Journals, Pages, Graph,
  Assets and Trash navigation. The pencil action renames the current notebook
  folder on disk, discards its index rows and reindexes every file under the
  new name, so it warns before starting and shows elapsed reindex time.
  Favorites and Recent
  are collapsible sections, collapsed by default. Journals open a dedicated
  feed of **editable journal cards** rather than a single page; the feed loads
  the newest seven pages and appends older
  pages as you scroll. Each card edits its own `journals/YYYY-MM-DD.md` with the
  live block editor and autosaves. ArrowDown on a card's last line moves into
  the next card, and ArrowUp on the first line moves into the previous card;
  crossing the last loaded card loads the next batch. Opening the journal feed
  creates today's empty page automatically when it does not exist.
- **Center** — every view sits on a selectable **background**, defaulting to
  the slow Grid Scan room. Backgrounds are adapted from
  [React Bits](https://reactbits.dev/backgrounds) and scoped to the route
  outlet: the left sidebar, right panel and top bar stay outside it. Backgrounds
  load from the built-in registry or `<data-dir>/backgrounds/`; the current
  page, the journal feed, or the Pages directory.
  Pages view is a Logseq-style **All pages** table across pages and journals,
  with backlink counts, tags, created/updated timestamps, sortable columns,
  tag filtering, a page filter, table/card modes and server-side pagination.
  A **Clean** action lists empty pages with no backlinks and can move them to
  the server trash after confirmation. Both sidebars start collapsed and can
  be toggled from the top bar, leaving the writing surface to fill the window.
  The single-page editor grows with its content and scrolls the page, not an
  inner editor box; journal cards use the same renderer.
- **Omni bar** — the global header hosts one input for note search, tag
  navigation and commands. Type normally to search the server's `note:fts`
  index; type `#` to browse available tags; type `>` to search and run every
  workspace command. Tag pages prefill `#tag`. The old centered search and
  command dialogs are gone. `Ctrl+M` or leader → `M` opens command mode.
- **Settings** — a large left-tabbed dialog. Fonts are configured by role
  (interface, titles, editor, labels/code); any Google Font can be named and
  loaded over HTTPS. **Code** selects the fenced-code syntax theme; GitHub
  Light is the default. **Background** chooses an installed built-in or user
  background. **Keyboard** lists every workspace shortcut and lets you record a
  replacement chord sequence. **Trash** sets how many days deleted files stay
  recoverable. Workspace and navigation commands share a leader
  chord (`Cmd+/` on macOS, `Ctrl+/` elsewhere), followed by `F` or `S` to focus
  the omni bar, `T` tag search, `Shift+T` trash, `H` home, `A` all pages,
  `G` graph, `L`/`R` sidebars, `O` settings, `M` command mode, `N` new page,
  `J` journals, or `Shift+J` today's journal.
  Save is `Cmd+S` / `Ctrl+S`. User overrides are stored as one sparse JSON
  object on the server and cached in IndexedDB for fast startup. An **About** tab shows the
  Opal mark, the project philosophy, and the GitHub source link.
- **Home** — `/<notebook>/home` is the default dashboard. It shows today's
  editable journal card, Favorites, the top three recently edited pages with a
  New page button, and outstanding todo-plugin items in a sticky right strip.
- **Ghost controls** — action buttons default to a transparent ghost style
  with hairline hover feedback; selected/active controls keep their accent
  surface, and destructive actions use danger text on hover.
- **Assets** — `/<notebook>/assets` browses every file under the notebook's
  `assets/` folder with search, type filters, sorting and pagination. Cards
  provide download and rename actions. Asset detail pages (`/<notebook>/asset/
  <path>`) provide image zoom/pan, video/audio players, metadata, and links to
  every page that references the asset.
- **Navigation** — TanStack Router browser routes are scoped by notebook name:
  `/<notebook>/home`, `/<notebook>/journal`, `/<notebook>/pages`,
  `/<notebook>/graph`, `/<notebook>/tag/<tag>`, and
  `/<notebook>/page?p=<page>`. Back/forward (default `Cmd+[` / `Cmd+]` or
  `Alt+Left` / `Alt+Right`, rebindable in Settings → Keyboard) use browser
  history, and page URLs can be reloaded or shared directly. Switching notebooks
  updates the URL and opens that notebook's home.
- **Right sidebar** — wider, tabbed **Context** (tags, outgoing links,
  backlinks), **Info** (path and timestamps), and **Graph**. The Graph tab
  renders an interactive local/full notebook graph: click a node to highlight
  its links, double-click to open its page, hover to preview links, and switch
  between the active page's neighborhood and the complete graph. A **Tags**
  toggle adds tag nodes connected to their pages. The full graph
  follows Logseq's all-pages layout: d3-force for connected pages and a
  deterministic ring of isolated pages around the connected cluster. Connected
  nodes animate under force; drag a node to pull its neighbours, and use
  zoom/pan/reset controls.
- **Graph view** — the left-sidebar Graph view opens a full-page notebook graph
  using the same resolved-link data, filling the available workspace. Drag the
  canvas to pan, drag nodes to reposition them, zoom with the wheel or buttons,
  and reset the view. It participates in normal back/forward history.
- **Home plugin strip** — the Home dashboard renders every registered plugin
  result in its right-hand strip. Plugins run server-side in QuickJS, use
  read-only Datalog, and return JSON items plus an optional declarative UI. The
  built-in todos plugin lists open tasks across the notebook; clicking one
  opens its page. Settings → Plugins shows installed plugins and reloads the
  data plugin folder.
- **Tag view** — `/<notebook>/tag/<tag>` shows every page carrying `#tag` as
  editable cards containing only the tagged block, with a page-title list for
  fast jumping. Clicking a tag in a journal card, page, pages table, right
  panel, or inline in a note opens the corresponding tag view.

### Plugins

Plugins are small JavaScript widgets with a JSON manifest.

Built-in source packages live under:

```
builtin/src/plugins/OpalNote/todos/package.json
builtin/src/plugins/OpalNote/todos/src/index.js
```

The source package has normal `name`/`version`/`description` fields, the final
manifest under `opal_note`, and bundling configuration under
`opal_note_build`:

```json
{
  "name": "@opalnote/plugin-todos",
  "version": "1.0.0",
  "description": "Open tasks across the notebook.",
  "private": true,
  "type": "module",
  "opal_note": {
    "id": "OpalNote/todos",
    "title": "Open todos",
    "description": "Tasks not marked done or cancelled across this notebook."
  },
  "opal_note_build": {
    "entry": "src/index.js",
    "target": "es2020",
    "minify": true
  }
}
```

`pnpm build:builtins` bundles source plugins with esbuild and writes the final
release folders:

```
builtin/plugins/OpalNote/todos/plugin.json
builtin/plugins/OpalNote/todos/plugin.js
```

The final `plugin.js` remains the IIFE expression format consumed by QuickJS.
Source plugins default-export a function and return `{ items, ui? }`; the
bundler serializes it. Built-in ids take precedence over data plugins, which
live under `<data-dir>/plugins/<folder>/` with the same final file names.
Reloading does not require a server restart.

The optional `ui` object can be a safe renderer kind:

```json
{ "kind": "todo-list", "title": "Open todos" }
```

or a declarative schema:

```json
{
  "schema": 1,
  "root": {
    "type": "card",
    "title": "Open todos",
    "children": [
      {
        "type": "list",
        "emptyText": "All clear.",
        "items": [
          {
            "title": "Task",
            "detail": "Page title",
            "status": "doing",
            "action": { "type": "openNote", "path": "pages/task.md" }
          }
        ]
      }
    ]
  }
}
```

Supported schema nodes include `card`, `section`, `row`, `heading`, `text`,
`badge`, `list`, `button`, `link`, `separator`, and `empty`. Actions are
`openNote`, `openTag`, `openExternal`, and `runCommand`; external URLs are
restricted to safe schemes. The server validates the UI shape and limits before
returning it. Unknown kinds fall back to the generic item card.

### Backgrounds

Backgrounds are declarative plugins: a JSON manifest plus optional assets.
Built-in source packages live under `builtin/src/backgrounds/<id>/`; their
`package.json` contains the final manifest in `opal_note`. The build tool copies
assets and writes:

```
builtin/backgrounds/OpalNote/dot-grid/background.json  # generated + embedded
<data-dir>/backgrounds/<folder>/background.json        # user
<data-dir>/backgrounds/<folder>/<asset>                # user image, etc.
```

Example image background:

```json
{
  "id": "Acme/skyline",
  "title": "Skyline",
  "description": "A city skyline at dusk.",
  "kind": "image",
  "options": { "asset": "skyline.jpg", "fit": "cover", "opacity": 0.6 }
}
```

The manifest `id` uses the same `<domain>/<extension>` shape as journal
plugins. Built-in ids win over user folders with the same id; invalid folders
are reported in Settings → Background. Supported `kind` values:

- `none` — plain canvas.
- `dot-grid` — React Bits dot grid. Numeric options follow the component
  (`dotSize`, `gap`, `proximity`, `strength`, `bounce`, `tension`,
  `returnDuration`, `shockRadius`, `shockStrength`, `swell`, `stretch`, `glow`,
  `fade`, `opacity`); `shape`, `intro`, `mouseInteraction`, `clickShock` and
  `baseColor`/`activeColor` are also accepted. Colours default to
  `--color-line-strong` / `--color-accent-strong`.
- `image` — requires `options.asset`; optional `fit`, `position`, `opacity`,
  `blur`.
- `gradient` — `from`, `to` and `angle` in degrees.
- `galaxy` — React Bits starfield. Options include `density`, `starSpeed`,
  `starSize`, `glowIntensity`, `flareIntensity`, `twinkleIntensity`, `layers`,
  `lightMode`, `transparent`, `starColors` and `opacity`.
- `grid-scan` — React Bits wireframe-room scan. Options include `cells`,
  `depth`, `linesColor`, `scanColor`, `scanDuration`, `scanDelay`,
  `scanDirection`, `glow` and `lightMode`. Webcam preview is disabled.
- `letter-glitch` — React Bits monospace glitch text. Options include
  `glitchColors`, `baseColor`, `characters`, `density`, `baseOpacity`,
  `glitchAmount`, `speed`, `flow`, `edgeFade` and `centerFade`.
- `shape-grid` — React Bits drifting lattice. Options include `shape`,
  `cellSize`, `lineColor`, `hoverColor`, `direction`, `speed`, `radius`,
  `trail`, `glow`, `twinkle` and `opacity`.

Settings → Background shows a thumbnail preview for every installed background;
selecting one stores its id as `backgroundId` in the sparse settings. Grid Scan
exposes sweep-duration and delay controls (default 10 s and 5 min) and Letter
Glitch exposes a glitch-speed control (default 0.25×); overrides live in
`backgroundOptions`, keyed by background id. Assets are served through the
authenticated API. Fonts, Code and Background are single-column lists with
their preview/controls on the right; expandable options appear only for the
selected background.

### Client routes

| Route | View |
| --- | --- |
| `/` | Redirects to the selected notebook's home |
| `/<notebook>/home` | Home dashboard |
| `/<notebook>/journal` | Journal feed |
| `/<notebook>/pages` | All-pages table |
| `/<notebook>/graph` | Full-page notebook graph |
| `/<notebook>/assets` | Asset browser |
| `/<notebook>/asset/<path>` | Asset detail and references |
| `/<notebook>/trash` | Global trash/bin and restore view |
| `/<notebook>/tag/<tag>` | Pages carrying `#tag` |
| `/<notebook>/page?p=pages/foo.md` | A page by relative path or title |

`<notebook>` is the notebook name, URL-encoded when it contains spaces or
unicode. The old unprefixed routes redirect to the selected notebook and remain
available as a no-notebook fallback.
| `/page?p=Some%20Page` | A page resolved by title |

Routes use clean browser paths plus search params; no hash routing. They are
scoped to the active notebook; switching notebooks returns to its home.
Favorites and recents are stored in the browser, scoped per notebook. A page can be
pinned with the star in the editor toolbar.

Markdown images render in the live editor using authenticated asset blobs;
relative `assets/` paths are resolved against the note location. Executable
blocks and non-image object embeds remain out of scope.

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

Trash metadata is deliberately kept outside that disposable index:

```
data/.trash/trash.sqlite3
trash_entry { id => notebook_id, notebook_name, original_path, kind,
              title, size, deleted_at, trashed_path, mime, preview }
```

`trashed_path` points into `data/.trash/entries/<uuid>/`, so a restore can move
the payload back to `original_path` (or a numeric suffix when it is occupied).

Tasks are derived from markdown checkboxes and Logseq task keywords during sync.
Writes touching a note plus its tags/links/tasks use MnesticDB's `multi_transaction`,
and every filesystem mutation holds a store-wide lock so scans and sends do not
interleave.

## HTTP API

Base path `/api`. Errors use
`{"error":{"code":"bad_request","message":"..."}}`.

Public: `GET /health`, `GET /meta`, `POST /session`, `DELETE /session`.

`POST /session` exchanges the optional `OPALNOTE_TOKEN` in `{token}` for an
HttpOnly `opalnote_session` cookie and returns a CSRF token. Cookie-authenticated
`POST`/`PATCH`/`PUT`/`DELETE` requests must send `x-opalnote-csrf`; API clients
can keep using `Authorization: Bearer`. The browser never stores the bearer
token in JavaScript storage.

| Method | Path                                         | Purpose                                        |
| ------ | -------------------------------------------- | ---------------------------------------------- |
| POST   | `/session`                                   | Exchange token for HttpOnly cookie + CSRF     |
| DELETE | `/session`                                   | Clear the browser session                      |
| GET    | `/notebooks`                                 | List folders with note counts                  |
| POST   | `/notebooks`                                 | `{name, description?}` — creates the folder    |
| POST   | `/notebooks/import`                          | Multipart ZIP/tar.gz import; auto-suffixes names |
| GET    | `/notebooks/{id}`                            | Notebook metadata                              |
| PATCH  | `/notebooks/{id}`                            | `{name?, description?}` — may rename the folder|
| DELETE | `/notebooks/{id}`                            | Move notebook folder to `.trash/`              |
| GET    | `/notebooks/{id}/notes`                      | `?limit=&offset=` newest first                 |
| GET    | `/notebooks/{id}/pages`                      | Paged/filtered pages with backlink counts       |
| GET    | `/notebooks/{id}/orphans`                    | Empty pages with no backlinks                  |
| GET    | `/notebooks/{id}/graph`                      | Nodes/links; `?include_tags=true` adds tag nodes |
| GET    | `/notebooks/{id}/assets`                     | Paged/filtered asset list                      |
| GET    | `/notebooks/{id}/assets/{*path}`             | Asset bytes with MIME type                     |
| DELETE | `/notebooks/{id}/assets/{*path}`             | Move the asset to the trash                    |
| GET    | `/notebooks/{id}/asset?path=`                | Asset metadata + page references               |
| PATCH  | `/notebooks/{id}/asset`                      | `{path, name}` — rename and update references  |
| GET    | `/notebooks/{id}/plugins`                    | Journal plugin results (QuickJS + Datalog)     |
| GET    | `/plugins`                                   | Installed plugin metadata + load errors        |
| POST   | `/plugins/reload`                            | Rescan the data plugin folder                  |
| GET    | `/backgrounds`                               | Installed background metadata + errors         |
| POST   | `/backgrounds/reload`                        | Rescan the user background folder              |
| GET    | `/backgrounds/asset?id=&path=`               | Background asset bytes                         |
| GET    | `/settings`                                  | Sparse user settings JSON                      |
| PUT    | `/settings`                                  | Replace the sparse user settings JSON          |
| POST   | `/notebooks/{id}/notes`                      | `{title?, content?, tags?, section?}`           |
| GET    | `/notebooks/{id}/journals`                   | `?before=<path>&limit=` date-desc feed          |
| GET    | `/notebooks/{id}/search`                     | `?q=&limit=` BM25 search                       |
| GET    | `/notebooks/{id}/tags`                       | Tag counts                                     |
| GET    | `/notebooks/{id}/notes/{*path}`              | Note + tags + links + backlinks                |
| PATCH  | `/notebooks/{id}/notes/{*path}`              | `{title?, content?, tags?}` — may rename file  |
| DELETE | `/notebooks/{id}/notes/{*path}`              | Move the file to the trash                     |
| GET    | `/trash`                                     | `?limit=&offset=&q=&kind=&sort=&dir=`          |
| GET    | `/trash/{id}`                                | Trash metadata + text preview                  |
| GET    | `/trash/{id}/content`                        | Trash payload bytes                            |
| POST   | `/trash/{id}/restore`                        | Restore to the original path (or a suffix)     |
| DELETE | `/trash/{id}`                                | Permanently delete one trash entry             |
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
  config.rs          clap, config file, env, config/install-service commands
  state.rs           shared AppState
  auth.rs            bearer token + HttpOnly session/CSRF middleware
  session.rs         in-memory browser sessions
  assets.rs          release rust-embed / debug disk asset handler + SPA fallback
  routes/            /api handlers (blocking DB work offloaded)
  plugins.rs         release embed / debug disk plugin registry + QuickJS runner
  backgrounds.rs     built-in + user background registry and assets
  settings.rs        sparse settings.json store
  store/
    mod.rs           sync engine, file-first CRUD, Datalog queries
    files.rs         folder layout, atomic writes, scanning, trash paths
    trash.rs         separate trash metadata database
    markdown.rs      wikilinks, tags, frontmatter, summaries
    queries.rs       every CozoScript statement
    model.rs         API models
builtin/src/        plugin/background package sources (package.json + assets)
builtin/plugins/    generated plugin manifests and scripts (embedded)
builtin/backgrounds/ generated background manifests/assets (embedded)
web/
  src/api/           typed client + types
  src/router.tsx     TanStack route tree + URL/view synchronization
  src/state/         Jotai atoms
  src/components/    workspace shell, journal feed, pages, graph, panels
  src/components/backgrounds/  React Bits renderer implementations
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
- The optional server token is compared in constant time and returned as
  `WWW-Authenticate: Bearer` on 401. The web UI exchanges it for an HttpOnly,
  SameSite=Strict session cookie; the cookie is not readable by JavaScript.
  Mutating cookie requests require `x-opalnote-csrf`.
- Static responses carry a Content Security Policy with `script-src 'self'`;
  external links are restricted to http/https/mailto before `window.open`.
- `/api/query` cannot write and cannot run `::` system operations, but it can
  read every notebook. Treat the token as full access.
- Path traversal is rejected: note paths must stay inside
  `pages/`/`journals/` and asset paths inside `assets/` under the canonicalized
  notebook folder.
- Static assets are served without auth so the SPA can load and prompt for a
  token.

## Roadmap / non-goals

- keyset/virtualized pagination at very large notebook sizes;
- real-time collaboration and a sync protocol;
- per-notebook permissions and multi-user accounts;
- CRDT-based collaborative editing;
- true block references and transclusion (the live editor is block-oriented,
  but pages remain plain markdown files);
- executable code blocks and non-image object embeds;
- vector/semantic search — MnesticDB supports HNSW, but no embedder is wired in;
- auto-updating `[[links]]` when a page is renamed.

## License

Server and client code: MIT.

The Dot Grid background is adapted from
[React Bits](https://reactbits.dev/backgrounds/dot-grid) by David Haz, used
under its MIT + Commons Clause license. MnesticDB (`mnestic`) is MPL-2.0; it is
linked as a library. SQLite is in the public domain.
