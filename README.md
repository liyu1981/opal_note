# Opal Note

A server-first, self-hosted notebook. The browser is a **query UI**; the Rust
server owns the data, the index, and the query language.

Opal Note looks like a local markdown vault, but behaves like a small database
product:

- notebooks (vaults / spaces), notes, tags and `[[wikilinks]]` live in
  **MnesticDB** — an embedded Datalog engine (a maintained CozoDB fork) backed
  by RocksDB;
- full-text search is a native BM25 index maintained transactionally with each
  write;
- backlinks are derived from a `link` relation and resolved against current
  titles, so notes can be linked before they exist;
- the React client holds no note data: every view is an API query, and every
  edit is a server mutation;
- production is **one binary** with the built client embedded.

## Stack

| Layer    | Choice                                                        |
| -------- | ------------------------------------------------------------- |
| Server   | Rust 2021, Axum 0.8, Tokio                                     |
| Database | [`mnestic`](https://www.mnesticdb.com/) 0.19 (Datalog, RocksDB) |
| Client   | React 19, TypeScript 7, Jotai 3                                |
| Styling  | Tailwind CSS 4                                                 |
| Build    | Vite 8, pnpm, root `package.json` scripts                      |

> `mnestic` publishes its crate under that name but keeps the library target
> `cozo` for drop-in compatibility, so the server imports `cozo::*`.

## Quick start

Requirements: Rust (1.85+), Node 22.12+ / 24, pnpm, and a C++ toolchain
(`clang`, `cmake`) for RocksDB.

```bash
# development: one command, one process
pnpm dev
```

`pnpm dev` is deliberately not a Vite dev-server + API split. It:

1. installs the web dependencies on first run;
2. builds the client bundle;
3. syncs the bundle into the location the server embeds;
4. rebuilds the Rust server;
5. starts it on **`0.0.0.0:7827`**.

Open http://localhost:7827. There is no HMR: rerun `pnpm dev` after changing
client or server code. Override the listen address with `OPALNOTE_BIND`, or the
data directory with `OPALNOTE_DATA_DIR`.

```bash
# production: one binary, assets embedded
pnpm build
pnpm start
# or run the artifact directly:
./target/release/opalnote --data-dir ./data --bind 0.0.0.0:7827
```

`pnpm build` runs the same web build + asset sync, then
`cargo build --release --locked`. `build.rs` also builds `web/dist` on demand
for a plain `cargo build`. `cargo build --release` with a prebuilt `web/dist`
is all the Docker image does.

### Scripts

| Command            | What it does                                                     |
| ------------------ | ---------------------------------------------------------------- |
| `pnpm dev`         | build web → sync assets → build server → run on `0.0.0.0:7827`    |
| `pnpm build`       | build web → sync assets → release binary                          |
| `pnpm start`       | run `target/release/opalnote` (pass server args after `--`)       |
| `pnpm build:web`   | client bundle only                                               |
| `pnpm build:server`| release binary only (expects a current `web/dist`)                |
| `pnpm typecheck`   | TypeScript check                                                 |
| `pnpm test`        | Rust tests + TypeScript check                                    |
| `pnpm check`       | `cargo check` + TypeScript check                                 |
| `pnpm fmt`         | `cargo fmt`                                                      |
| `pnpm clean`       | remove `target/` and `web/dist/`                                  |
| `pnpm docker`      | build the container image                                        |

The root `package.json` is the only task runner by design; there is no
Makefile.

### Docker

```bash
docker build -t opal-note .
docker run --rm -p 7827:7827 -v opal-data:/data opal-note
```

## Configuration

All flags have environment-variable equivalents.

| Flag                      | Env                          | Default           | Meaning                                             |
| ------------------------- | ---------------------------- | ----------------- | --------------------------------------------------- |
| `--bind`                  | `OPALNOTE_BIND`              | `127.0.0.1:7827`  | Listen address (`pnpm dev` forces `0.0.0.0:7827`)   |
| `--data-dir`              | `OPALNOTE_DATA_DIR`          | `./data`          | RocksDB store location                              |
| `--token`                 | `OPALNOTE_TOKEN`             | _(unset)_         | Bearer token for `/api`; unset means open access    |
| `--db-memory-mb`          | `OPALNOTE_DB_MEMORY_MB`      | `256`             | Shared RocksDB block-cache/write-buffer envelope    |
| `--query-timeout-secs`    | `OPALNOTE_QUERY_TIMEOUT_SECS`| `5`               | Default budget for ad-hoc `/api/query`              |
| `--dev-cors`              | `OPALNOTE_DEV_CORS`          | `false`           | Permissive CORS for API calls from another origin    |

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
└──────────────────────────────┘        │        Store (Datalog)            │
                                        │              │                     │
        embedded web/dist               │              ▼                     │
        via rust-embed          ◄────── │        MnesticDB / RocksDB         │
                                        │   note · note_tag · link · FTS     │
                                        └────────────────────────────────────┘
```

### Data model

A single MnesticDB instance holds all notebooks; notes are partitioned by
`notebook_id` and served through a secondary index.

```
notebook { id => name, description, created_at, updated_at }
note     { id => notebook_id, title, content, summary, created_at, updated_at }
note_tag { note_id, tag }
link     { from_note, target => label }      # target is a normalized title
```

Derived on every write, in the same transaction as the note row:

- `summary` — plain-text excerpt for lists and search results;
- `note_tag` — explicit tags plus `#inline-tags` found outside code fences;
- `link` — `[[wikilinks]]`, normalized (lowercase, whitespace-collapsed) so
  backlinks survive capitalization differences;
- `note:fts` — BM25 index over `title ++ content`, tokenized with `Simple`,
  `Lowercase` and an English stemmer (no stop-word list, so searching “world”
  works).

Deleting a note or notebook cascades through tags and links. Writes that touch
multiple relations use MnesticDB's `multi_transaction`, so a failure leaves no
half-indexed note.

### Timestamps

The database stores seconds since the Unix epoch as floats; the API exposes
RFC 3339 strings (`2026-11-12T00:36:24Z`).

## HTTP API

Base path `/api`. Errors use
`{"error":{"code":"bad_request","message":"..."}}`.

Public (no token): `GET /health`, `GET /meta`.

| Method | Path                              | Purpose                                   |
| ------ | --------------------------------- | ----------------------------------------- |
| GET    | `/notebooks`                      | List notebooks with note counts           |
| POST   | `/notebooks`                      | `{name, description?}`                    |
| GET    | `/notebooks/{id}`                 | Notebook metadata                         |
| PATCH  | `/notebooks/{id}`                 | `{name?, description?}`                   |
| DELETE | `/notebooks/{id}`                 | Cascade-delete notebook                   |
| GET    | `/notebooks/{id}/notes`           | `?limit=&offset=` newest first            |
| POST   | `/notebooks/{id}/notes`           | `{title?, content?, tags?}`               |
| GET    | `/notebooks/{id}/search`          | `?q=&limit=` BM25 search                  |
| GET    | `/notebooks/{id}/tags`            | Tag counts                                |
| GET    | `/notes/{id}`                     | Note + tags + resolved links + backlinks  |
| PATCH  | `/notes/{id}`                     | `{title?, content?, tags?}`               |
| DELETE | `/notes/{id}`                     | Cascade-delete note                       |
| GET    | `/stats`                          | Global counts                             |
| POST   | `/query`                          | Ad-hoc read-only Datalog                  |

### Querying the notebook directly

The UI's data is available to scripts and agents as Datalog:

```bash
curl -s localhost:7827/api/query \
  -H 'content-type: application/json' \
  -d '{
    "script": "?[id, title, n] := *note{id, title, notebook_id}, notebook_id = $nb, n = 1",
    "params": { "nb": "field-notes-167572" }
  }'
```

Response:

```json
{
  "headers": ["id", "title", "n"],
  "rows": [["…", "Welcome to Opal Note", 1]],
  "next": null,
  "took_ms": 2
}
```

`/query` is strictly read-only: system commands (`::`) are rejected, scripts
run with `ScriptMutability::Immutable`, and each call gets a wall-clock and
memory budget. For anything that mutates, use the REST routes.

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
  store/
    mod.rs           Datalog store, transactions, cascade deletes
    queries.rs       every CozoScript statement
    markdown.rs      wikilink/tag/summary derivation
    model.rs         API models
web/
  package.json       client package (build + typecheck only)
  src/api/           typed client + types
  src/state/         Jotai atoms
  src/components/    rail, notes, editor, inspector, settings
  src/lib/           markdown helpers, formatting
```

## Security notes

- Without `OPALNOTE_TOKEN`, anyone who can reach the port can read and write.
  This is intended for loopback use; set a token before exposing the server.
  There is no per-notebook access control yet — the token is a single-user gate.
- The token is compared in constant time and returned as `WWW-Authenticate:
  Bearer` on 401. The client stores it in `localStorage`.
- `/api/query` cannot write and cannot run `::` system operations, but it can
  read every notebook. Treat the token as full access.
- Static assets are served without auth so the SPA can load and prompt for a
  token.

## Roadmap / non-goals

Intentionally not implemented yet:

- real-time collaboration and sync protocol (the server is the authority, but
  there is no websocket fan-out);
- a Vite dev server with HMR — `pnpm dev` is a single production-like process;
- file import/export (markdown folder import);
- per-notebook permissions and multi-user accounts;
- block-level editing/CRDT;
- wikilink autocomplete and graph view in the UI;
- vector/semantic search — MnesticDB supports HNSW, but no embedder is wired in.

The schema and query layer are the extension points: add a relation in
`src/store/queries.rs`, index it, expose a route, and add a typed atom.

## License

Server and client code: MIT.

MnesticDB (`mnestic`) is MPL-2.0; it is linked as a library. RocksDB is
Apache-2.0/GPL-2.0 dual-licensed.
