# OpalNote technical reference

Deep dive behind the [README](../README.md): how files and the index relate,
the stack and design tokens, build/update mechanics, editor internals, plugin
and background formats, routes, index schema, PWA details and the HTTP API.

## Contents

- [What is canonical](#what-is-canonical)
- [Stack](#stack)
- [Design system](#design-system)
- [Development and builds](#development-and-builds)
- [Import mapping](#import-mapping)
- [Self-updates](#self-updates)
- [Configuration reference](#configuration-reference)
- [Architecture](#architecture)
- [PWA](#pwa)
- [HTTP API](#http-api)
- [Project layout](#project-layout)
- [Durable server state](#durable-server-state) · [ADR 0001](adr/0001-durable-server-state.md)
- [Security notes](#security-notes)

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
  opalnote.db                 # durable server state: settings, agent config
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

### Durable server state

Not everything the application needs is a document. Sparse settings and the
agent provider configuration live in `<data-dir>/opalnote.db` — a SQLite
database of its own, opened like the trash database, never touched by the note
sync engine, and never derived from files (see
[ADR 0001](adr/0001-durable-server-state.md)).

```
:create app_settings { id: String => json: String, updated_at: Float }   # id = "settings"
:create agent_config { id: String => base_url: String, models: String,
                       key_envelope: String, updated_at: Float }         # id = "agent"
```

`src/system_db.rs` owns the file; `SettingsStore` is a settings-shaped facade
over the `app_settings` row, so `GET/PUT /api/settings` keeps its contract.
`data/index/` stays disposable: deleting it costs a rebuild and nothing else.
An older `<data-dir>/settings.json` is imported once on open and renamed to
`settings.json.imported`.

Schema changes go through `src/migrations.rs`, a small ordered list of
migrations recorded in a `schema_migrations` relation:

- each migration has a version (consecutive from 1), a name and a list of
  steps: `Create(name, ddl)` / `Script(cozo)` / `Drop(name)`;
- `Create` and `Drop` are existence-checked in Rust, so they are idempotent and
  a migration interrupted half-way can be retried; `Script` steps should use
  `:put` rather than `:insert` for the same reason (Cozo cannot run DDL inside a
  transaction);
- the version row is written only after every step of that migration succeeded;
- a database whose recorded version is newer than the build is refused instead of
  silently losing rows, and a database created before the migration table existed
  is adopted through a named baseline relation.

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

## Development and builds

A manually triggered GitHub Actions workflow builds an **arm64 development
artifact** from the selected commit; pushing a `v*` tag also runs
`.github/workflows/release.yml` to attach the tarball and manifest to a GitHub
release. The artifact version is the Cargo package version plus the first six
characters of the commit hash, e.g. `0.1.0-a1b2c3`. It is uploaded to the
workflow run as a downloadable artifact; the workflow does not create a GitHub
release.

`scripts/download_github_artifact.sh` lists recent artifacts newest first,
downloads the selected one with `gh`, and extracts the nested tarball under
`./artifacts/<artifact-name>/` (relative to the current directory, so it can be
run from anywhere). Pass `--latest` to skip the prompt or `--help` for options.

### What `pnpm dev` does

`pnpm dev` is deliberately not a Vite dev-server + API split. It:

1. installs the root and web dependencies on first run;
2. builds the generated built-in plugins and backgrounds;
3. builds the vendored markdown parser (`scripts/build-lutez.mjs` → `liblutez.a`
   for the server, `web/public/lutez.wasm` for the browser; needs Zig 0.17.0);
4. builds the client bundle;
5. starts the debug server;
6. watches client, server and built-in sources.

The parser step is cached: it only rebuilds when `vendor/lutez` (a git
submodule) changes or when the target/CPU flags change, so
`git submodule update --init --recursive` is the one setup step. The archive is
compiled for **baseline CPU features** (`-Dcpu=baseline`), never the host CPU:
Zig's default bakes the build machine's instructions (AVX-512, `dotprod`,
`i8mm`, `sve`, …) into the archive, and a binary built on a CI runner then dies
with `Illegal instruction (core dumped)` on an older server. Build for the
running machine only with `OPALNOTE_LUTEZ_CPU=native`. Without Zig the build prints a warning and uses the legacy
hand-written scanners (`OPALNOTE_SKIP_LUTEZ=1` makes that explicit); the server
serves `lutez.wasm` from the app root, so the browser falls back the same way.

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
the browser tab after a client rebuild to load the new bundle. Override the
listen address with `OPALNOTE_BIND`, or the data directory with
`OPALNOTE_DATA_DIR`.

HTTPS is on by default. `pnpm dev` creates `certs/localhost.pem` and
`certs/localhost-key.pem` with mkcert if they are missing. The certificate
covers `localhost`, `127.0.0.1`, `::1` and **every non-internal IPv4 address**,
so opening `https://<lan-ip>:7827` from a phone or another machine is a properly
secured origin (that is what the PWA needs — see below). `pnpm dev` regenerates
the certificate when the current addresses are not covered, so a changed LAN IP
is handled automatically; add extra names with `OPALNOTE_TLS_HOSTS=a.example,10.0.0.5`
and rerun `pnpm certs`. Run `mkcert -install` once — on each device that opens
the app — so the browser trusts the local CA, then open the printed `https://`
URL. Use `pnpm certs` to regenerate certificates or `pnpm dev -- --no-tls` for
plain HTTP.

### Release builds

`pnpm build` builds the generated built-ins, the vendored markdown parser, then
the web client and asset sync, then `cargo build --release --locked`. Release builds embed `web/dist`,
`builtin/plugins` and `builtin/backgrounds`; `build.rs` builds `web/dist` on
demand for a plain release build. Debug builds skip that embed step and read
all three directories at runtime.

Use `pnpm build:builtins` to regenerate the built-in outputs and
`pnpm build:builtins:check` to verify they match `builtin/src`.

## Import mapping

The left-sidebar import accepts a Logseq-format ZIP or gzip-compressed tar
(`.tar.gz` / `.tgz`) whose entries may sit at the top level or inside one
wrapper folder. Archives are detected by magic bytes, unknown formats are
rejected, and both the compressed and extracted sizes are capped.

- `pages/`, `journals/`, `assets/` and `draws/` map into the notebook folder
  as-is;
- `Pages/` and `Journal/` are migrated to lowercase `pages/` and `journals/`
  during the first scan, so an old graph copied straight onto disk also works;
- an existing notebook is never overwritten — a conflicting name imports as
  `<name> 2`, `<name> 3`, and so on;
- note titles come from filenames, and `[[Journal/2023-03-29]]` resolves through
  journal paths.

## Self-updates

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
and smoke-tested (`--version`) before it is atomically renamed into place — a
payload that cannot start never replaces a working binary. After a successful
replacement the server re-execs the new binary in place, so the same start
installs and runs it, with the same PID, the original argv and the same systemd
unit. If applying fails the old binary keeps serving and the candidate stays
staged. The candidate directory is deleted after a successful replacement.

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
leaves it staged for the next `serve` start (which applies it and re-execs). It
reports what it is doing — the running build, the channel and repository, the
latest release or artifact it found, every download with its size, and the
staged version/commit/hash — so a cron log explains why a run did or did not
stage anything:

```text
OpalNote updater
  current build : 0.1.0 (82ec9f1, committed 2026-11-17T12:12:43Z)
  channel       : development (liyu1981/opal_note)
  update dir    : /home/ubuntu/.opalnote/updates
Checking GitHub Actions artifacts for liyu1981/opal_note with `gh`
Latest artifact: opalnote-0.1.0-e968d8-aarch64 (created 2026-11-16T20:40:10Z, run 12345)
Downloading artifact opalnote-0.1.0-e968d8-aarch64 with `gh run download`…
Artifact archive: …/download/opalnote-0.1.0-e968d8-aarch64.tar.gz
Extracted …/download/opalnote (29.3 MiB)
Staged 0.1.0 (e968d8) in /home/ubuntu/.opalnote/updates/candidate
  binary : 29.3 MiB
  sha256 : …
Update 0.1.0 (e968d8) is staged in …; restart the server to apply it.
```

When an already-downloaded candidate is reused it says so, and a candidate
that is not newer (or a missing release/artifact) is reported with the version
it compared against. Progress goes to stderr, the final line to stdout. Archives are unpacked into
`<update-dir>/download/`, which is wiped at the start of each run and again once
the candidate is staged. The `release` channel queries GitHub's
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

## Configuration reference

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
csp_hosts = []
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
| `--csp-host`               | `OPALNOTE_CSP_HOSTS`          | none              | Extra `host[:port]` trusted by the viewer-plugin CSP     |

Build/run switches that are not CLI flags:

| Env | Meaning |
| --- | --- |
| `OPALNOTE_PARSER=legacy` | Index a notebook with the hand-written markdown scanners instead of the shared `lutez` AST (debugging and one-release fallback) |
| `OPALNOTE_SKIP_LUTEZ=1` | Build without linking `liblutez.a`; the server then has only `legacy` |
| `OPALNOTE_SKIP_WEB_BUILD=1` | Compile a release binary without building `web/dist` |

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
        via rust-embed          ◄────── │   notebooks/*.md   index/*.sqlite3   │
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

### Markdown parsing

One parser serves both runtimes: **lutez**, a CommonMark 0.31.2 + GFM parser in
Zig (git submodule `vendor/lutez`, pinned by commit, C ABI 3, wire-format 2 AST,
Mulan PSL v2). The server links `liblutez.a` and decodes the AST in
`src/store/lutez.rs`; the browser compiles `/lutez.wasm` before its first render.
`src/store/markdown.rs` (`mod lutez_ast`) and `web/src/lib/lutez/parse.ts` are the
two adapters that turn the AST into blocks, tasks, inline tags and wikilinks.
They are deliberately identical: `cargo test corpus_parity -- --ignored` compares
them (and the hand-written scanners) note by note on `data/notebooks`.

The dialect is a set of opt-in presets: inline/display math, `[[wikilinks]]`,
`#tags`, and Logseq `TODO`/`DOING` keywords (the `DONE`/`CANCELED` forms are a
small post-pass). Frontmatter is split before parsing — `render_page` rewrites
just the `tags:` block — and `key::`/`^block-id` stay off until blocks R2.
`GET /meta` reports the live parser; `OPALNOTE_PARSER=legacy` switches back to the
hand-written scanners for one start, and a build without `liblutez.a` does the
same automatically.

### Editor

The note surface is a block-oriented live preview built on CodeMirror 6:

- **Live** renders headings, emphasis, links, tags, lists, tasks, quotes,
  images, video (`<video controls>`), audio (`<audio controls>`) and code in
  place. Other asset references (pdf, office documents, archives) render as an
  icon plus the file name and open the asset view when clicked. Type `/upload`
  on an empty line to pick a file and insert its markdown at the cursor. Typing
  `#` in prose opens a tag picker over the notebook's tags (with page counts);
  pick one to insert `#tag`, the same way `[[` completes page links. Bare
  `https://…` and `www.…` URLs are recognized and become clickable links. The line under the cursor becomes plain markdown source —
  visible markers, normal text size and weight, no rendered inline styling —
  the way Obsidian live preview does. There is no separate source mode.
- **Images** enlarge in a lightbox: a plain click on a rendered picture opens
  it full-window with wheel/button zoom, drag-to-pan, reset and focus mode
  (`Cmd/Ctrl+Shift+F`, Escape exits focus before closing). Alt/Option-click
  drops the caret into the source instead, which is the only way to edit a
  line that contains nothing but an image. The lightbox is built on the shared
  shell in `web/src/components/lightbox/Lightbox.tsx`, which also provides the
  frame, header, focus toggle and Escape handling for the diagram lightbox.
- **Math** is typeset with KaTeX: `$e^{i\pi}+1=0$` inline and `$$…$$` as a
  centered display block (either on one line or as `$$` fences around several
  lines). A formula shows its source while the line or block is being edited,
  and returns to typeset form on blur; an invalid formula stays as plain,
  non-interactive source instead of breaking the note. `$` inside inline code,
  fenced code and `\$` stays literal, and Pandoc's currency rule keeps prose
  like `$5 and $10` out of math mode. Formulas are rendered with
  `trust: false`, so `\href`/`\html` cannot inject links or markup.
- Fenced code blocks use configurable syntax themes (GitHub Light by default),
  language-aware highlighting, and a copy button.
  Focusing any line inside the fence reveals the whole block as plain markdown
  source, including both fence markers, with no code or token styling so the
  text is easy to edit. Blur restores the rendered block.
- Type `/` at the start of a source line for a block command menu: headings,
  lists, task, quote, code block, divider, page link and inline code. Arrows
  and Enter apply a command; Escape cancels. The menu does not appear inside
  fenced code blocks.
- **Fenced code** is detected by one rule on both sides: a fence may open after
  a list marker — a bullet or an ordered `1.` (`- ```js`, `1. ```js`) — and only
  a bare fence closes it. The server copy is
  `fence_marker`; the client shares `fenceOpener` / `closesFence` /
  `fencedLines` from `web/src/lib/markdown.ts` across tags, tasks and blocks.
  Tag views used to hold their own naive toggle, so the closing fence of a
  bullet fence opened a block and hid every later tag ("No tagged block found
  in the page body").
- **Task checkboxes** toggle the source text from the widget (`[ ]` ⇄ `[x]`)
  and swallow mousedown, so ticking a box neither reveals the line as source
  nor moves the caret. `/` commands fire behind line prefixes (`- /`,
  `1. /`, `- [ ] /`, `> /`, `## /`). Pasting or dropping files uploads them and
  inserts `assetMarkdown` at the caret or drop point; the `maxUploadMb` cap
  applies and read-only notes ignore it.
- **Blocks**: every block gets a hover handle in the gutter. The block list comes
  from the shared parse — `web/src/lib/lutez/` (WASM) feeds
  `web/src/lib/blocks.ts`, the same AST the server indexes — and
  `components/editor/blockHandles.ts` decorates it. The handle menu offers
  copy link, fold/unfold, move up/down and delete; dragging the handle reorders
  the block as one transaction; Tab/Shift-Tab indents list items. Folding and
  handles are block decorations, so they come from a `StateField`. A block link
  is `?p=<path>&block=<hash>&at=<seq>`; the note editor resolves it and flashes
  the range. Nothing is written into the markdown (R1 of `doc/blocks.md`).
- **Resuming refreshes**: an installed PWA or a backgrounded tab keeps its state
  instead of reloading, so coming back re-reads note-derived data
  (`useRevalidateOnResume` → `notesRevisionAtom` on visibility/`pageshow`/`online`
  after a short absence). The open editor and journal cards adopt the server copy
  when they have no unsaved draft, so a note changed on another device appears
  without losing local typing; `JournalFeed` re-reads its loaded pages quietly.
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

### Diagram thumbnails

`.mermaid`, `.mmd` and `.excalidraw` assets have no intrinsic pixels, so the
browser renders their preview and caches it on the server:

- `GET /api/notebooks/{id}/thumbnail?path=` returns a stored PNG, or `404` with
  an `x-opalnote-asset-hash` header naming the digest the client should render
  from. `PUT` with `?path=&hash=` stores a PNG (validated signature, 4 MiB cap,
  409 when the asset changed in the meantime).
- The cache lives in `data/index/thumbs/<notebook>/<sha256>.png`. It is keyed
  by asset *content*, so an edited (or externally changed) diagram invalidates
  its thumbnail by construction, and `POST /api/reindex` sweeps entries whose
  diagram is gone or has changed. Being derived state it stays inside the
  disposable index directory.
- Rendering happens in an off-screen viewer frame: `viewerMount` sets
  `thumbnail: true`, the plugin rasterizes its own SVG (`exportToSvg` for
  Excalidraw — which embeds its fonts — and Pele's rendered SVG for Mermaid)
  with `builtin/src/shared/svgThumbnail.ts`, and answers
  `opalnote-viewer/thumbnail { png }`. Up to two frames render at once, and the
  asset bytes are always fetched with `cache: "no-store"` so a stale HTTP cache
  can never poison the content-keyed cache (the asset route itself answers
  `no-cache` for editable text assets).
- The stored PNG doubles as the PNG export on the asset detail page.

### Workspace layout

The shell follows a Logseq-like split. It opens on the **Home** dashboard:
today's editable journal card followed by a vertical list of plugin cards.
Favorites and the three most recently edited pages are client-side built-in
plugins under `builtin/src/plugins/OpalNote/`; server plugins such as Open todos
render in the same main-area list. There is no plugin side strip or section
label. The top bar carries the omni search bar with the Home button
beside it, plus back/forward history controls.

Both side panels are collapsible (default collapsed) and dock on desktop: they
are flex siblings that shrink the main column, and the right one is resizable.
Below the `md` breakpoint (768px) they become drawers instead — absolutely
positioned over the page at full height, so the writing surface keeps the whole
viewport width, with a dimmed backdrop that closes them on tap, a capped width,
no resize handle, and an automatic close once a navigation lands so the page you
picked is actually visible.

- **Left sidebar** — notebook switcher plus Home, Journals, Pages, Todos,
  Graph, Assets and Trash navigation. The pencil action renames the current notebook
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
  creates today's empty page automatically when it does not exist. A small
  **Filter** button floats in the margin beside the first entry, level with its
  top and taking no space; it stays in place while the list scrolls and lets
  clicks through everywhere except the button itself. Clicking it swaps the button for a full-width bar
  (which does take space) that narrows the entries already loaded in the
  browser (no server query), reports how many of them match, and can be hidden
  again (which clears the filter and removes the bar). A pane too narrow for
  that margin gets a compact button row above the list instead.
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
  the server trash after confirmation.
  The **Todos** view lists every task derived from markdown checkboxes and
  Logseq `TODO`/`DOING`/`DONE`/`CANCELED` keywords across pages and journals.
  Status chips (open, doing, done, cancelled) filter the list and show
  notebook-wide totals, a text filter narrows by task or page, sort covers
  status/task/page/updated (newest first by default), and each row opens the
  note that holds it. Both
  sidebars start collapsed and can be toggled from the top bar, leaving the
  writing surface to fill the window.
  The single-page editor grows with its content and scrolls the page, not an
  inner editor box; journal cards use the same renderer.
- **Home** — the workspace opens on today's editable journal card with a day
  switcher (`‹ Today ›` back to five days ago) and a New page action, then the
  notebook's home plugins: Open todos (server), Favorites and Recent pages
  (built-in client plugins). Settings → Home switches those three sections off
  individually (`homeShowTodos`, `homeShowFavorites`, `homeShowRecent`); the
  journal card itself is always shown. Only today's entry is created on open —
  stepping back loads an existing entry and creates one only when you ask, so
  browsing history never writes files.
- **Omni bar** — the global header hosts one input for note search, tag
  navigation and commands. Type normally to search the server's `note:fts`
  index together with the notebook's blocks: note hits come first, then block
  hits (kind glyph, block text, `path · line N`, at most 3 per note and 20 in
  total). Choosing a block row opens its note with `?p=…&block=<hash>&at=<seq>`
  and flashes that block. Type `#` to browse available tags; type `>` to search and run every
  workspace command. Tag pages prefill `#tag`. The old centered search and
  command dialogs are gone. `Ctrl+Shift+P` or leader → `M` opens command mode.
- **Settings** — a large left-tabbed dialog. Fonts are configured by role
  (interface, titles, editor, labels/code); any Google Font can be named and
  loaded over HTTPS. **Code** selects the fenced-code syntax theme; GitHub
  Light is the default. **Background** chooses an installed built-in or user
  background. **Keyboard** lists every workspace shortcut and lets you record a
  replacement chord sequence. **Trash** sets how many days deleted files stay
  recoverable. **Files** sets the maximum upload size (default 4096 MB). Workspace and navigation commands share a leader chord
  (`Cmd+;` on macOS, `Ctrl+;` elsewhere), followed by `F` or `S` to focus the
  omni bar, `T` tag search, `Shift+T` trash, `H` home, `A` all pages, `D`
  todos, `G` graph, `L`/`R` sidebars, `O` settings, `M` command mode, `N` new page, `J`
  journals, or `Shift+J` today's journal. Back/forward use `Ctrl+; [` /
  `Ctrl+; ]` (`Cmd+; [` / `Cmd+; ]` on macOS). The Keyboard settings tab also
  lists the native CodeMirror editor bindings.
  Save is `Cmd+S` / `Ctrl+S`. User overrides are stored as one sparse JSON
  object on the server and cached in IndexedDB for fast startup. An **About** tab shows the
  Opal mark, the project philosophy, and the GitHub source link.
- **Home** — `/<notebook>/home` is the default dashboard. It shows today's
  editable journal card with a New page button, followed by a main-area plugin list of
  plugin cards. Favorites and Recent pages are built-in client plugin cards;
  Open todos and other server plugins share the same list. There is no right
  plugin strip and no separate plugin section label.
- **Ghost controls** — action buttons default to a transparent ghost style
  with hairline hover feedback; selected/active controls keep their accent
  surface, and destructive actions use danger text on hover.
- **Assets** — `/<notebook>/assets` browses every file under the notebook's
  `assets/` folder with search, type filters, sorting and pagination. Cards
  provide download and rename actions. Asset detail pages (`/<notebook>/asset/
  <path>`) provide image zoom/pan, video/audio players, metadata, and links to
  every page that references the asset. Files are uploaded with the editor's
  `/upload` slash command (or `POST /api/notebooks/{id}/assets`): images,
  audio, video, pdf/office documents and archives up to `maxUploadMb` (4096 MB
  / 4 GB by default, configurable in Settings → Files). Names are sanitized
  (markdown characters such as `[]()*#` are dropped, extensions lowercased) so
  the generated link always parses; uploads keep
  the file name and a conflict gets a unix-timestamp suffix
  (`photo-1731000000.png`) instead of overwriting anything.
- **Navigation** — TanStack Router browser routes are scoped by notebook name:
  `/<notebook>/home`, `/<notebook>/journal`, `/<notebook>/pages`,
  `/<notebook>/tasks`, `/<notebook>/graph`, `/<notebook>/tag/<tag>`, and
  `/<notebook>/page?p=<page>`. Back/forward (default `Cmd+; [` / `Cmd+; ]`
  or `Ctrl+; [` / `Ctrl+; ]`, rebindable in Settings → Keyboard) use browser
  history, and page URLs can be reloaded or shared directly. Switching notebooks
  updates the URL and opens that notebook's home.
- **Right sidebar** — wider, tabbed **Agent**, **Context** (tags, outgoing
  links, backlinks), **Info** (path and timestamps), and **Graph**. Drag its
  left edge to resize it (up to half the window); the width is remembered, and
  double-clicking the handle restores the default. The
  Agent tab embeds [`@liyu1981/reagent`](https://www.npmjs.com/package/@liyu1981/reagent),
  an in-app AI chat whose agent loop runs entirely in the browser: provider
  keys live in `localStorage`, conversations in IndexedDB, and nothing is
  proxied through the OpalNote server. Configure an OpenRouter key or a local
  OpenAI-compatible endpoint (Ollama, LM Studio, vLLM) in the agent's own
  Settings view; the tab works without a notebook selected. The Graph tab
  renders an interactive local/full notebook graph. Its page graph
  (`unfoldOnClick`) loads a clicked node's direct connections into the view —
  `unfoldGraph` unions them, `mergeExpandedLayout` keeps existing nodes in place
  and seeds newcomers beside the node that pulled them in, and Reset folds
  everything back. The full-page notebook graph and plugin graphs leave the prop
  off because every node is already present, so a click there only highlights;
  double-click opens a page, hover previews links, and the Local/Full switch
  chooses between the active page's neighborhood and the complete graph. A **Tags**
  toggle adds tag nodes connected to their pages and starts enabled. The full graph
  follows Logseq's all-pages layout: d3-force for connected pages and a
  deterministic ring of isolated pages around the connected cluster. Connected
  nodes animate under force; drag a node to pull its neighbours, and use
  zoom/pan/reset controls. In the right panel the graph fills the tab's width
  and height and follows panel resizes, instead of using a fixed height.
- **Graph view** — the left-sidebar Graph view opens a full-page notebook graph
  using the same resolved-link data, filling the available workspace. Drag the
  canvas to pan, drag nodes to reposition them, zoom with the wheel or buttons,
  and reset the view. It participates in normal back/forward history.
- **Home plugin list** — the Home dashboard renders every registered server
  plugin result in the main-area list. Plugins run server-side in QuickJS, use
  read-only Datalog, and return JSON items plus an optional declarative UI. The
  built-in todos plugin lists open tasks across the notebook; clicking one
  opens its page. Favorites and Recent pages are client-side built-in plugins
  under `builtin/src/plugins/OpalNote/`; they receive the current notebook, notes,
  favorites, browser recents, link data and navigation actions through
  `HomePluginContext`. Settings → Plugins shows installed server plugins and
  reloads the data plugin folder.
- **Tag view** — `/<notebook>/tag/<tag>` shows every page carrying `#tag` as
  editable cards containing only the tagged block, with a page-title list for
  fast jumping. Its in-page filter narrows both the cards and that list to the
  entries already loaded, without another server query. Like the journal feed,
  it shows only a small floating **Filter** button beside the first card until
  clicked; the bar then takes space and can be hidden again. Clicking a tag in a journal card, page, pages table,
  right panel, or inline in a note opens the corresponding tag view.

### Plugins

Plugins are small JavaScript widgets with a JSON manifest.

Built-in source packages live under:

```
builtin/src/plugins/OpalNote/todos/package.json
builtin/src/plugins/OpalNote/todos/src/index.js
```

Client-side built-in plugins follow the same package shape under
`builtin/src/plugins/OpalNote/<extension>/` with `type: "client"`; their
generated modules are written alongside the server plugins in
`builtin/plugins/OpalNote/<extension>/` and exported through
`builtin/plugins/index.js`. Favorites and Recent pages live there because they
use browser-local state.

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
    "description": "Tasks not marked done or cancelled across this notebook.",
    "type": "server"
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

`opal_note.type` selects the plugin class:

- `server`: loaded by the Rust QuickJS registry; receives `__query` and
  `__notebook_id`.
- `client`: compiled into the web client; receives `HomePluginContext` with
  browser-local favorites, recents, notes, links and navigation actions.
  Client plugins live under `builtin/src/plugins/OpalNote/` with
  `type: "client"` and are generated to `builtin/plugins/OpalNote/`.

Server plugins default to `type: "server"` when an older data-plugin manifest
omits the field. A `type: "client"` manifest in the server registry is rejected.

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
`badge`, `list`, `button`, `link`, `separator`, `empty`, `markdown`, and
`graph`. The `markdown` node renders a read-only live markdown surface using the
current notebook's links; `graph` renders the notebook graph and accepts an
optional `scope` (`local`/`all`), `includeTags` boolean, and 120-480px height.
Actions are `openNote`, `openTag`, `openExternal`, and `runCommand`; external
URLs are restricted to safe schemes. The server validates the UI shape and
limits before returning it. Unknown kinds fall back to the generic item card.

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

### Agent provider

The right-panel agent (`@liyu1981/reagent`, vendored — see below) runs its loop
in the browser, but OpalNote relays the model traffic so the upstream credential
stays out of the browser and browser CORS rules stop applying:

```
browser agent ──POST /api/agent/v1/chat/completions──► Rust proxy ──► upstream
  x-opalnote-agent-key: <derived key>   session cookie + CSRF   (+ decrypted key)
```

**Storage.** The connection lives in `opalnote.db` (`agent_config`, ADR 0001):
base URL and model list in clear, the API key as an AES-256-GCM envelope. The
browser derives the encryption key from the user's password with
PBKDF2-SHA256 (600 000 iterations, per-envelope salt), encrypts the key, and
uploads only the envelope — the password never leaves the tab and the plaintext
key never enters the database.

**Requests.** Every proxied call carries the derived key in
`x-opalnote-agent-key`; the server decrypts the envelope for that one request,
puts the plaintext key on the upstream `Authorization` header, and drops it.
Missing or wrong key → `401 {"code":"agent_locked"}` before any upstream call.

**Routes.** `GET /api/agent` reports the configuration (including the envelope,
which is useless without the password); `PUT /api/agent/config` stores a base
URL, model list and envelope; `DELETE /api/agent/config` forgets it.
`GET|POST /api/agent/v1/{path}` forwards only `models`, `chat/completions`,
`responses`, `messages` and `messages/count_tokens` — the client cannot choose
the upstream URL — and relays the response chunk by chunk (the blocking `ureq`
request and its reader run on a blocking task feeding an mpsc channel that
becomes the body, `cache-control: no-cache`, `x-accel-buffering: no`; a closed
tab just ends the relay).

**Unlock windows.** 15 minutes (default), a custom duration, 24 hours, or until
the key changes. They are enforced in the browser — how long the tab keeps the
derived key (memory only, `sessionStorage`, or `localStorage`) — not by the
server, which holds no unlock state. A window "locks" rather than disconnects:
the models stay visible and the next request opens the password prompt. A
re-saved envelope changes its fingerprint, which invalidates any remembered key.
The window is chosen in the unlock dialog, which opens when a message is sent —
settings only configures the provider.

**Model list.** ReAgent's picker only offers models a provider's config
declares, and the browser is the only side that can fetch them (the listing goes
through the proxy, which needs the derived key). `save` therefore stores the
connection first, then `refreshProviderModels` lists `/models` through the proxy
and saves the ids; the same helper repairs a stored row with an empty list on
load, unlock and `Recheck`, and refreshes it when the base URL changes so stale
ids are never sent upstream. While the provider is locked nothing is fetched —
the ids stored server-side are reused.

**Client.** `opalnoteProvider.tsx` registers a ReAgent **host provider** whose
`fetch` hook attaches the derived key, fails fast with `agent_locked` when
locked, and locks again if the server rejects the key. `useOpalNoteCallGate`
(the provider's `beforeAgentCall` hook) additionally stops a call to a locked
provider *before* ReAgent appends the message, so the prompt stays in the
composer and the unlock dialog opens instead of a failed turn.

`AgentProviderCard.tsx` is **setup only**: the endpoint/key/password form while
nothing is configured, and a summary (endpoint, whether a key is stored, model
count) with "Set up a new configuration", "Recheck" and "Remove" once a setup
exists. It never locks or unlocks and carries no unlock-window control — that
belongs to `AgentUnlockDialog`, which the call gate raises at send time and
which also asks how long to keep the key. Saving a new envelope drops the
session key, so the next message prompts for the new password.
Since ReAgent 0.2.1 that page lists every provider with an on/off switch; the
OpalNote switch hides the card, and switching it back reconnects from
`GET /api/agent`.

**Vendored ReAgent.** `web/vendor/reagent` is a git submodule tracking upstream
`main`, linked as a workspace package and built from source by
`scripts/build-reagent.mjs` (the published tarball has no `dist/`). Docker and
the GitHub workflows check submodules out recursively.

### Client routes

| Route | View |
| --- | --- |
| `/` | Redirects to the selected notebook's home |
| `/<notebook>/home` | Home dashboard |
| `/<notebook>/journal` | Journal feed |
| `/<notebook>/pages` | All-pages table |
| `/<notebook>/tasks` | Todo directory filtered by status |
| `/<notebook>/graph` | Full-page notebook graph |
| `/<notebook>/assets` | Asset browser |
| `/<notebook>/asset/<path>` | Asset detail and references |
| `/<notebook>/trash` | Global trash/bin and restore view |
| `/<notebook>/tag/<tag>` | Pages carrying `#tag` |
| `/<notebook>/page?p=pages/foo.md` | A page by relative path or title |

`<notebook>` is the notebook name, URL-encoded when it contains spaces or
unicode. The old unprefixed routes redirect to the selected notebook and remain
available as a no-notebook fallback.

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
block    { notebook_id, note_path, seq => start_line, end_line, kind, depth,
                                 parent_seq, text, hash, updated_at }
```

`block` is R1 of [blocks.md](blocks.md): one row per block (`paragraph`,
`heading`, `list_item`, `task`, `code`, `quote`, `table`, `hr`, `math`, `html`),
keyed by its position in the note, with a short hash of its text for deep links.
Nothing is written into the markdown for it.

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

Blocks are not identified today. The plan in [blocks.md](blocks.md) is split:
**R1** (committed) derives positional blocks — `block` relation, handles, fold,
drag, block search and hash-based deep links — and writes nothing into the
markdown; **R2** (deferred, needs its own review) would add persistent
references, embeds and block backlinks, which is where the identity-token design
lives.

Tasks are derived from markdown checkboxes and Logseq task keywords during sync
(only `-`/`*`/`+` list items count), so a body save that adds, completes or
rewrites one changes derived data. Blocks, tasks, tags and wikilinks all come
from one `lutez` AST per body — the same parser the browser compiles from
`lutez.wasm` — so a fenced block written as a list child (`- ``` … ``` `) can no
longer swallow what follows it on one side but not the other. The editor and the
journal cards compare
`taskSignature(content)` before/after saving
(`web/src/lib/tasks.ts` reads the same AST, including its tolerance for any
whitespace run after the bullet — the editor draws `-  [ ] x` and `-\t[ ] x` as
checkboxes, so the server must index them) and bump `tasksRevisionAtom` when the
set moved, including from the flush that runs when a card is unmounted. The todo
list and the Home plugin list watch that atom; `notesRevisionAtom` is reserved for
metadata so a checkbox edit never suspends the open route.
`taskSignature` mirrors all of this. `data/index/tasks.rules` records the
extraction version and `data/index/blocks.rules` the block-derivation version;
bumping `TASK_RULES_VERSION` / `BLOCK_RULES_VERSION` in the store forces one full
re-read so existing files are re-derived after a rule change (`Store::take_rules_marker`).
Writes touching a note plus its tags/links/tasks use MnesticDB's `multi_transaction`,
and every filesystem mutation holds a store-wide lock so scans and sends do not
interleave.

## PWA

The web client is installable: `web/public/manifest.webmanifest` plus
`icons/` (192 and 512 `any`, an opaque 512 maskable and an opaque Apple touch
icon) give browsers the app
name, standalone display and theme colour, and `web/public/sw.js` registers a
minimal service worker. Offline support is intentionally minimal — the app is
server-first, so the worker caches **only** a placeholder page: an offline
navigation (reload, deep link, installed app launch) shows
`/offline.html` ("You are offline") instead of the browser error page. No API
response, note data or build asset is cached, so a reload always gets the
current shell. `/sw.js`, the manifest, the icons and the placeholder are served
`Cache-Control: no-cache`; hashed `assets/` stay immutable.

The icons are **full-bleed and borderless** on purpose: the paper background
reaches every edge with no inset and no stroke, so the mask iOS and Android apply
cannot expose a border or a gap between the icon and its background.
`web/public/icons/icon.svg` (baked rounding, mark at 78% of the canvas) produces
the `any` PNGs, `icon-square.svg` the opaque Apple touch icon (iOS masks an
opaque square itself) and `icon-maskable.svg` the maskable icon whose mark stays
inside the 66% safe zone. `pnpm icons` (`scripts/icons.mjs`) rasterizes all four
with headless Chromium and mirrors `icon.svg` to `public/favicon.svg`, so the tab
icon is the same artwork; only the in-app mark keeps a bordered tile, because it
is drawn on a page rather than masked.

`pnpm dev` serves production bundles, so the worker is active there too; open
`/` once, stop the server and reload to see the placeholder.

Installing the PWA needs a **trusted** certificate for the exact URL host:
Chrome refuses the service worker (and reports `not-from-secure-origin`) when
the dev certificate does not include the address you typed. Either open
`https://localhost:7827`/`127.0.0.1` or make sure the certificate covers the
LAN IP (`pnpm certs` does) and that the device trusts the mkcert CA. The install
entry is in Chrome's ⋮ menu under **Cast, save and share → Install page as
app**; the omnibox install icon only appears while Chrome decides the page
qualifies, so its absence is not a failure. DevTools → **Application →
Manifest** (and `chrome://web-app-internals`) lists any installability problem.

### Behind a tunnel or reverse proxy

A Cloudflare Tunnel (or nginx/Caddy with a real certificate) works: the browser
sees a normal HTTPS origin, the service worker registers and the app is
installable. Things worth knowing:

- **Use a stable hostname.** A named tunnel (or a proper DNS record) keeps the
  origin constant; a quick tunnel gives a new `*.trycloudflare.com` name on
  every restart, and since a service worker and installed app are bound to one
  origin, each change means reinstalling. Cloudflare terminates TLS with a
  trusted certificate, so no dev certificate is involved.
- **Do not cache `/sw.js` or `/manifest.webmanifest`.** They are served
  `Cache-Control: no-cache`; keep it that way. A "Cache Everything" page rule or
  an edge TTL on `.js` can pin an old worker — exclude those two paths (and
  purge after upgrading).
- **Leave Rocket Loader (and any script-rewriting transform) off** for the
  hostname; it rewrites `<script>` tags and breaks module scripts and worker
  registration.
- The app only needs same-origin requests, so no special CORS or WebSocket
  configuration is required.
- **Cloudflare Access needs a bypass for the PWA files.** Browsers fetch a web
  app manifest *without credentials* (HTML spec, credentials mode `omit`), so an
  Access-protected `/manifest.webmanifest` is answered with a 302 to the login
  page; the manifest fails to parse, `Page.getInstallabilityErrors` reports
  `manifest-parsing-or-network-error`, and the install entry never appears even
  while you are signed in.

  Keep the existing application for the hostname and add a second self-hosted
  application covering only the public, secret-free PWA paths, with a single
  **Bypass** policy that includes everyone (Access matches the most specific
  path, and five destinations fit in one application):

  ```json
  {
    "name": "notes - PWA assets",
    "type": "self_hosted",
    "app_launcher_visible": false,
    "domain": "notes.example.com/manifest.webmanifest",
    "self_hosted_domains": [
      "notes.example.com/manifest.webmanifest",
      "notes.example.com/sw.js",
      "notes.example.com/offline.html",
      "notes.example.com/icons",
      "notes.example.com/favicon.svg"
    ],
    "policies": [
      {
        "name": "Public PWA assets",
        "decision": "bypass",
        "include": [{ "everyone": {} }]
      }
    ]
  }
  ```

  With the API, `cf zero-trust access applications create --body "$(cat
  pwa-assets.json)"` creates it in one call; otherwise repeat the
  Zero Trust → Access → Applications dialog for each path.

  The app shell (`/`) and `/api/*` can stay protected: the installed app opens
  the Access login in its own window on first launch, and once the Access
  session expires a request returns its sign-in page, which the client treats as
  an expired session (the “Session expired — refresh” dialog reloads through
  the login).
- Running the origin with `--no-tls` behind the tunnel is fine: the session
  cookie is still marked `Secure` because the request carries
  `X-Forwarded-Proto: https`, and viewer CSPs derive their host from the
  forwarded/original `Host` header.

## HTTP API

Base path `/api`. Errors use
`{"error":{"code":"bad_request","message":"..."}}`.

Public: `GET /health`, `GET /meta`, `POST /session`, `DELETE /session`.

`POST /session` exchanges the optional `OPALNOTE_TOKEN` in `{token}` for an
HttpOnly `opalnote_session` cookie and returns a CSRF token. Cookie-authenticated
`POST`/`PATCH`/`PUT`/`DELETE` requests must send `x-opalnote-csrf`; API clients
can keep using `Authorization: Bearer`. The browser never stores the bearer
token in JavaScript storage. If the session cookie expires while a tab is
open (long idle, or the server restarted), the UI shows a blocking
**Session expired** dialog asking for a page refresh instead of leaving every
request failing.

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
| GET    | `/notebooks/{id}/tasks`                      | Paged/filtered derived tasks with status counts |
| GET    | `/notebooks/{id}/orphans`                    | Empty pages with no backlinks                  |
| GET    | `/notebooks/{id}/graph`                      | Nodes/links; `?include_tags=true` adds tag nodes |
| GET    | `/notebooks/{id}/assets`                     | Paged/filtered asset list                      |
| POST   | `/notebooks/{id}/assets`                     | Multipart `file` upload into `assets/`          |
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
| GET    | `/notebooks/{id}/blocks?path=`               | Derived blocks of one note                     |
| GET    | `/notebooks/{id}/block?path=&hash=&seq=`     | Resolve a block deep link                      |
| GET    | `/notebooks/{id}/block-search?q=`            | Block hits across the notebook                 |
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
doc/                 this reference and the rich-content (viewer) guide
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
  settings.rs        sparse settings store (over `opalnote.db`)
  system_db.rs       durable server state: settings row + agent config
  migrations.rs      schema migrations shared by the durable databases
  store/
    mod.rs           sync engine, file-first CRUD, Datalog queries
    files.rs         folder layout, atomic writes, scanning, trash paths
    trash.rs         separate trash metadata database
    markdown.rs      AST adapter: blocks, tasks, tags, links, summaries
    lutez.rs         FFI + wire decoder for the shared parser (cfg(lutez_ffi))
    queries.rs       every CozoScript statement
    model.rs         API models
builtin/src/        server plugin/background and client plugin package sources
builtin/plugins/    generated server and client plugin manifests/scripts
builtin/backgrounds/ generated background manifests/assets (embedded)
web/
  src/api/           typed client + types
  src/router.tsx     TanStack route tree + URL/view synchronization
  src/state/         Jotai atoms
  src/components/    workspace shell, journal feed, pages, graph, panels
  src/plugins/types.ts  shared client plugin context/types
  src/components/backgrounds/  React Bits renderer implementations
  src/components/editor/  live CodeMirror editor surface
  src/components/agent/   @liyu1981/reagent chat mounted in the right panel
  src/lib/           navigation, live preview, blocks, completion, editor theme
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

### Third-party secret in the generated viewer bundle

GitHub secret scanning reports a Google API key
(`AIzaSyAd15pYlMci…`) in `builtin/plugins/OpalNote/excalidraw/`. It is **not an
OpalNote credential**: it is the default Firebase web config that
[`@excalidraw/excalidraw`](https://www.npmjs.com/package/@excalidraw/excalidraw)
ships for its own collaboration backend (`excalidraw-room-persistence`), and it
appears here only because viewer bundles are committed build artifacts and
embedded into the binary.

- Firebase web API keys are public identifiers by design — they ship in every
  Excalidraw deployment and are guarded by Firebase security rules, not by
  secrecy.
- The Firebase project belongs to Excalidraw, so there is nothing for us to
  rotate or revoke; close the alert as a **false positive**, noting the upstream
  package and version.
- OpalNote never enables Excalidraw collaboration, so the config is inert.
- A rebuild re-introduces the literal. If the alerts become noisy, exclude the
  generated output rather than editing it, e.g. `.github/secret_scanning.yml`
  with `paths-ignore: [builtin/plugins/**]`.

The same reasoning applies to other strings baked into third-party bundles under
`builtin/plugins/`: check the upstream package before treating an alert as ours.
