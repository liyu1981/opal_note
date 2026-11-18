# OpalNote

A server-first, self-hosted notebook. Notes are plain **markdown files** in a
folder you own; a disposable Datalog index makes them searchable, linked and
graphable. The browser is a query UI — it never owns your notes.

Drop a page into `data/notebooks/<name>/pages/`, edit files while the server
runs, or import a Logseq graph: the Rust server reconciles everything on the
next read. Delete the index at any time and it comes back.

## Features

- **File-first notebooks** — pages and journals are `.md` files under
  `data/notebooks/<notebook>/{pages,journals}/`. Frontmatter carries explicit
  tags, inline `#tags` live in the body, `[[wikilinks]]` resolve by title or
  path, and backlinks stay accurate after external edits. The index under
  `data/index/` is disposable and rebuilt from files.
- **Live block editor** — a CodeMirror 6 surface that renders headings,
  emphasis, links, tags, lists, tasks, quotes, code, images, video, audio and
  documents in place, and shows plain markdown for the block under the cursor.
  Includes KaTeX math (`$…$`, `$$…$$`), Mermaid and Excalidraw diagrams,
  `[[` page completion, a `#` tag picker, a `/` command menu, bare-URL
  autolinking, syntax-highlighted code with copy buttons and autosave that
  never interrupts typing. Click an image to enlarge it in a zoomable
  lightbox with a full-screen focus mode (Alt-click edits its source).
- **Journals** — an editable, newest-first feed of journal cards with
  per-card saving and arrow-key navigation between days.
- **Pages, tags and todos** — an all-pages table across pages and journals with
  backlink counts, filters, sorting, table/card modes and server-side
  pagination; tag pages showing just the tagged block; a todo directory derived
  from markdown checkboxes and Logseq `TODO`/`DOING`/`DONE`/`CANCELED`
  keywords.
- **Graph** — a d3-force notebook graph in the sidebar view and the right
  panel, with tag nodes, drag, zoom and a Logseq-style ring for isolated pages.
- **Assets** — upload images, audio, video, PDFs, office files and archives
  (4 GB default, configurable), browse and rename them, and jump from a file to
  every page that references it. Diagrams get rendered previews in the grid and
  on their detail page, and can be exported as PNG.
- **Responsive workspace** — collapsible side panels that dock on a desktop and
  float over the page as drawers on phones and small tablets.
- **Search and commands** — one omni bar: text searches the full-text index,
  `#` browses tags, `>` runs commands. Keyboard-first, with rebindable leader
  chords and a command palette.
- **Trash** — deletes move pages, assets and notebooks to a recoverable bin
  with configurable retention; restoring a conflicting path auto-suffixes.
- **Plugins** — server plugins run in a sandboxed QuickJS runtime with
  read-only Datalog and declarative UI; client plugins add Home cards. Built-in
  favorites/recents/todos, plus your own under `<data-dir>/plugins/`.
- **Themes** — Square-inspired design tokens, selectable fonts per role, code
  syntax themes and eight animated backgrounds.
- **AI side panel** — an in-browser chat agent with a server-proxied provider:
  the OpalNote provider keeps the upstream key on the server (no CORS limits,
  one path for OpenRouter, Ollama, LM Studio or vLLM), or bring your own key in
  the agent's own settings. Conversations stay in the browser.
- **One binary** — the web client, plugins and backgrounds are embedded in the
  release build. HTTPS by default, systemd user service, self-update staging
  and an installable PWA with a minimal offline page.

## Quick start

Requirements: Rust 1.85+, Node 22.12+ (or 24), pnpm, a C compiler for the
bundled SQLite, and [mkcert](https://github.com/FiloSottile/mkcert) for local
HTTPS.

```bash
git clone --recursive <repo> && cd opal_note   # or: git submodule update --init
# development: builds the client, runs the server, rebuilds on change
pnpm dev
```

`web/vendor/reagent` is a git submodule tracking ReAgent's `main`: the agent
panel is built from source there (`scripts/build-reagent.mjs` runs
`tsc` in the submodule), so a fresh clone needs `--recursive` and an already
cloned tree needs `git submodule update --init`.

This serves `https://localhost:7827` (and `https://<your-lan-ip>:7827`). Run
`mkcert -install` once so the device trusts the local CA; `pnpm certs`
regenerates certificates. Add `-- --no-tls` for plain HTTP.

```bash
# production: one binary with everything embedded
pnpm build
pnpm start            # or: ./target/release/opalnote serve --data-dir ./data
```

Data lives in `./data` by default: `notebooks/` (your notes), `index/`
(rebuildable), `opalnote.db` (durable server state — back it up) and `.trash/`. Point it elsewhere with `--data-dir` or
`OPALNOTE_DATA_DIR`.

### Importing notes

Use the import button in the left sidebar to upload a Logseq-format ZIP or
gzip-compressed tar (`.tar.gz` / `.tgz`). `pages/`, `journals/`, `assets/` and
`draws/` are imported, `Pages/`/`Journal/` are folded into the lowercase
folders, and an existing notebook is never overwritten (a conflicting name
becomes `<name> 2`).

You can also copy a graph straight into a data directory and reindex:

```bash
cp -a ~/sb-import data/notebooks/sb-import
```

## Commands

| Command                     | What it does                                          |
| --------------------------- | ----------------------------------------------------- |
| `pnpm dev`                  | build, then watch + rebuild + restart on `0.0.0.0:7827` |
| `pnpm build`                | built-ins → web client → release binary                |
| `pnpm start`                | run `opalnote serve` (pass server args after `--`)     |
| `pnpm certs`                | regenerate dev TLS certificates                        |
| `pnpm build:web`            | client bundle only                                     |
| `pnpm build:server`         | release binary only (expects a current `web/dist`)     |
| `pnpm build:builtins`       | regenerate built-in plugins and backgrounds            |
| `pnpm build:builtins:check` | verify generated built-ins match `builtin/src`         |
| `pnpm typecheck`            | TypeScript check                                       |
| `pnpm test`                 | Rust tests + TypeScript check                          |
| `pnpm check`                | `cargo check` + TypeScript check                       |
| `pnpm fmt`                  | `cargo fmt`                                            |
| `pnpm clean`                | remove `target/` and `web/dist/`                       |
| `pnpm docker`               | build the container image                              |

## Configuration

Values resolve as **CLI flags → environment variables → TOML file → defaults**.
The config file is `~/.opalnote/config` (override with `--config`):

```toml
version = 1
bind = "127.0.0.1:7827"
data_dir = "./data"
token = ""
tls_cert = "certs/localhost.pem"
tls_key = "certs/localhost-key.pem"
```

The flags that matter most:

| Flag | Env | Default | Meaning |
| ---- | --- | ------- | ------- |
| `--bind` | `OPALNOTE_BIND` | `127.0.0.1:7827` | Listen address |
| `--data-dir` | `OPALNOTE_DATA_DIR` | `./data` | Notebooks, index and trash |
| `--token` | `OPALNOTE_TOKEN` | _(unset)_ | Bearer token for `/api`; unset is open access |
| `--no-tls` | `OPALNOTE_NO_TLS` | `false` | Serve plain HTTP |
| `--tls-cert` / `--tls-key` | `OPALNOTE_TLS_CERT` / `_KEY` | `certs/localhost*.pem` | HTTPS certificate |
| `--update-channel` | `OPALNOTE_UPDATE_CHANNEL` | `release` | `release` or `dev` for `opalnote update` |

`opalnote config` writes a default file, `opalnote config --upgrade` adds new
keys without touching your values, and `opalnote install-service` writes a
systemd **user** unit defaulting to `~/.opalnote/data`. Every flag, the plugin
and query timeouts, CORS and CSP hosts are listed in the
[configuration reference](doc/architecture.md#configuration-reference).

Appearance and behaviour settings live in the UI (Settings) and are stored
sparsely in `<data-dir>/opalnote.db`, the durable server database that also holds
the agent provider configuration (see
[ADR 0001](doc/adr/0001-durable-server-state.md)).

## Deploying

### Docker

```bash
docker build -t opal-note .
docker run --rm -p 7827:7827 -v opal-data:/data opal-note
```

The container defaults to HTTP because it has no certificate mount. Mount
`certs/` and set `OPALNOTE_NO_TLS=false` to serve HTTPS.

### Behind a tunnel or reverse proxy

A Cloudflare Tunnel (or nginx/Caddy with a real certificate) works: the browser
sees a normal HTTPS origin, the PWA installs and the session cookie stays
`Secure` even when the origin runs `--no-tls`. Use a **stable hostname**, keep
`/sw.js` and `/manifest.webmanifest` uncached, and leave script-rewriting
transforms (Rocket Loader) off. Cloudflare Access needs a bypass for the PWA
files. Full checklist:
[behind a tunnel or reverse proxy](doc/architecture.md#behind-a-tunnel-or-reverse-proxy).

### Agent models

The right-panel agent can use an OpenAI-compatible endpoint that OpalNote itself
relays — OpenRouter, a gateway, or a local server (Ollama, LM Studio, vLLM):

1. Settings → Agent → Model → **OpalNote**: enter the base URL (e.g.
   `https://openrouter.ai/api/v1`, or `http://localhost:11434/v1` with no key).
2. Enter the API key and an **encryption password**. The key is encrypted in the
   browser with a key derived from that password; the server stores only the
   ciphertext and never sees the password.
3. Pick an unlock window (15 minutes, custom, 24 hours, or until the key
   changes). While locked the provider keeps its models listed but every request
   asks for the password first.

Because the password and the key stay in the browser, nothing is configured
through the config file or environment variables, and a stolen `data/` directory
does not expose the upstream credential. Details:
[agent provider](doc/architecture.md#agent-provider).

### Keeping a server up to date

```bash
opalnote update        # download a newer candidate (cron-friendly)
```

`opalnote serve` applies a staged candidate at startup and keeps running the
old binary until the next restart. Details:
[self-updates](doc/architecture.md#self-updates).

## Documentation

| Document | Contents |
| -------- | -------- |
| [doc/architecture.md](doc/architecture.md) | Storage model and sync, stack, build and update mechanics, editor internals, workspace layout, plugins, backgrounds, routes, index schema, PWA, HTTP API, configuration reference, project layout |
| [doc/rich-content.md](doc/rich-content.md) | Viewer plugins: Mermaid and Excalidraw diagrams end to end |
| [doc/adr/](doc/adr/README.md) | Architecture decision records (`opalnote.db`, migrations) |
| [AGENTS.md](AGENTS.md) | Coding conventions for contributors |

The HTTP API and its auth/session flow are documented in
[the technical reference](doc/architecture.md#http-api).

## Security

- Without `OPALNOTE_TOKEN`, anyone who can reach the port can read and write
  your notes. Set a token before exposing the server; it is a single-user gate,
  not per-notebook access.
- The token is exchanged for an HttpOnly, SameSite=Strict session cookie; CSRF
  tokens guard mutations and the bearer token is never kept in browser storage.
- Journal plugins run in a fresh QuickJS runtime with memory, stack and
  wall-clock limits and a read-only Datalog bridge — no filesystem or network.
- Note and asset paths are validated against traversal; `/api/query` is
  read-only and rejects `::` system commands.
- Responses carry a Content Security Policy, and viewer plugin bundles are
  sandboxed in iframes with host-scoped CSPs.

More detail: [security notes](doc/architecture.md#security-notes).

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
