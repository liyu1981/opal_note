# ADR 0001 — Durable server state lives in `data/opalnote.db`

- Status: accepted
- Date: 2026-11-19

## Context

OpalNote keeps almost everything in files: notebooks, pages, journals and assets
are markdown and binary files under `data/notebooks/`. Two kinds of state do not
fit that model:

1. **Derived state** — the Datalog index. It is rebuilt from the files on every
   start and before reads, so it is disposable and lives in `data/index/`.
2. **Server state** — things the application owns, not the user's documents:
   sparse UI settings (fonts, keybindings, code theme, background, trash
   retention, upload cap) and, going forward, the agent provider configuration
   (base URL, model list and an **encrypted** upstream API key).

Until now the second kind lived in `data/settings.json` — a single JSON file with
no transactions, no schema and no room for the agent credential. Two alternatives
were considered for the agent credential:

- **The note index** (`data/index/opalnote.sqlite3`). Technically safe today
  (schema creation only adds missing relations, sync is per-notebook and per
  relation, nothing deletes the database at runtime), but it would make the
  index authoritative. The project documents the index as disposable in three
  places and users are used to excluding it from backups, so the only copy of a
  key would be one `rm -rf data/index/` away from being lost.
- **A settings file next to it.** Works, but a JSON file is a poor home for
  secrets and for anything that needs an atomic read-modify-write with a schema.

## Decision

Introduce a single durable SQLite database, `<data-dir>/opalnote.db`, holding the
application's own state and nothing derived:

```
:create app_settings {
    id: String => json: String, updated_at: Float
}

:create agent_config {
    id: String => base_url: String, models: String, key_envelope: String,
                  updated_at: Float
}
```

Consequences of the decision:

- **`data/index/` keeps its guarantee.** It stays derived and disposable;
  deleting it only costs a rebuild. `data/opalnote.db` is durable and belongs in
  backups.
- **`data/settings.json` is retired.** The settings API (`GET/PUT /api/settings`)
  keeps its shape, but the rows live in `app_settings`. An existing
  `settings.json` is imported once on open and renamed to
  `settings.json.imported`, so an upgrade loses nothing and a downgrade still has
  the old file.
- **The database is opened like the trash database** — its own `DbInstance`, its
  own relation DDL in `src/store/queries.rs`, touched only through
  `src/system_db.rs`, never by the note sync engine.
- **No plaintext secrets.** The agent API key is stored as a versioned envelope
  (`v`, `kdf`, `salt`, nonce, ciphertext) produced in the browser with a
  user-supplied password; the server only decrypts it per request, in memory. The
  base URL and model list are configuration, not secrets, and stay readable.
- **File mode.** `opalnote.db` is created `0600` where the platform supports it,
  next to the existing data directory.

## Alternatives rejected

- **Share `data/index/opalnote.sqlite3`.** One file fewer, but it breaks the
  documented "delete the index at any time" contract; the first user who clears
  the index would silently lose their provider setup.
- **`data/server.sqlite3`.** Same idea as this ADR with a different name; kept
  generic only if more server databases appear. `opalnote.db` names the owner.
- **Keep everything in `settings.json`.** No transactions, no schema, no cap on
  concurrent writers, and no good place for a credential.
- **No server-side storage at all** (browser-only credentials). Then every device
  and every browser profile needs the key re-entered, and the server could not
  proxy the model traffic, so browser CORS limits would return.

## What follows

- `src/system_db.rs` owns the database; `SettingsStore` becomes a thin
  settings-shaped facade over it.
- The agent configuration (`GET/PUT/DELETE /api/agent/config`, the encrypted
  envelope, the per-request `x-opalnote-agent-key` header and the unlock windows)
  builds on the same file and table.
- Trash metadata stays in `data/.trash/trash.sqlite3` for now; the payload layout
  is tied to `File` paths and nothing forces a merge. If trash ever loses its
  file coupling, it can move into `opalnote.db`.
- New server-owned state must default to `opalnote.db`, never to
  `data/index/` and never to a new ad-hoc file.
