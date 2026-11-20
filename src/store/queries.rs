//! CozoScript (Datalog) statements used by the store.
//!
//! The index is disposable: notebooks and pages live on disk, and these
//! relations are rebuilt from the filesystem. Notes are keyed by
//! `(notebook_id, path)` so the same relative path can exist in two notebooks.

pub const RELATIONS: &[(&str, &str)] = &[
    (
        "notebook",
        r#":create notebook {
            id: String
            =>
            name: String,
            description: String,
            created_at: Float,
            updated_at: Float
        }"#,
    ),
    (
        "note",
        r#":create note {
            notebook_id: String,
            path: String
            =>
            title: String,
            content: String,
            summary: String,
            mtime_ns: Int,
            size: Int,
            created_at: Float,
            updated_at: Float
        }"#,
    ),
    (
        "note_tag",
        r#":create note_tag {
            notebook_id: String,
            note_path: String,
            tag: String
        }"#,
    ),
    (
        "link",
        r#":create link {
            notebook_id: String,
            from_note: String,
            target: String
            =>
            label: String
        }"#,
    ),
    (
        "task",
        r#":create task {
            notebook_id: String,
            note_path: String,
            line: Int
            =>
            text: String,
            status: String,
            updated_at: Float
        }"#,
    ),
    ("block", BLOCK_CREATE),
];

pub const INDEXES: &[&str] = &[
    r#"::index create note:by_notebook { notebook_id }"#,
    r#"::fts create note:fts {
        extractor: title ++ ' ' ++ content,
        tokenizer: Simple,
        filters: [Lowercase, Stemmer('English')]
    }"#,
    BLOCK_INDEX_NOTE,
    BLOCK_INDEX_HASH,
];

// ---------------------------------------------------------------------------
// Notebooks
// ---------------------------------------------------------------------------

pub const LIST_NOTEBOOKS: &str = r#"
?[id, name, description, created_at, updated_at] :=
    *notebook{id, name, description, created_at, updated_at}
:order name
"#;

pub const NOTEBOOK_COUNTS: &str = r#"
?[notebook_id, count(path)] := *note{notebook_id, path}
"#;

pub const GET_NOTEBOOK: &str = r#"
?[id, name, description, created_at, updated_at] :=
    *notebook{id, name, description, created_at, updated_at},
    id = $id
"#;

pub const NOTEBOOK_NOTE_COUNT: &str = r#"
?[count(path)] := *note{notebook_id, path}, notebook_id = $id
"#;

pub const NOTEBOOKS_INDEXED: &str = r#"
?[id] := *notebook{id}
"#;

pub const PUT_NOTEBOOK: &str = r#"
?[id, name, description, created_at, updated_at] <-
    [[$id, $name, $description, $created_at, $updated_at]]
:put notebook {id => name, description, created_at, updated_at}
"#;

pub const DELETE_NOTEBOOK_TAGS: &str = r#"
?[notebook_id, note_path, tag] :=
    *note_tag{notebook_id, note_path, tag},
    notebook_id = $id
:rm note_tag {notebook_id, note_path, tag}
"#;

pub const DELETE_NOTEBOOK_LINKS: &str = r#"
?[notebook_id, from_note, target] :=
    *link{notebook_id, from_note, target},
    notebook_id = $id
:rm link {notebook_id, from_note, target}
"#;

pub const DELETE_NOTEBOOK_NOTES: &str = r#"
?[notebook_id, path] := *note{notebook_id, path}, notebook_id = $id
:rm note {notebook_id, path}
"#;

pub const DELETE_NOTEBOOK: &str = r#"
?[id] <- [[$id]]
:rm notebook {id}
"#;

// ---------------------------------------------------------------------------
// Notes / index sync
// ---------------------------------------------------------------------------

pub const LIST_NOTES: &str = r#"
?[path, title, summary, created_at, updated_at] :=
    *note{notebook_id, path, title, summary, created_at, updated_at},
    notebook_id = $notebook_id
:order -updated_at
:limit $limit
:offset $offset
"#;

pub const LIST_ALL_NOTES: &str = r#"
?[path, title, summary, created_at, updated_at, content] :=
    *note{notebook_id, path, title, summary, content, created_at, updated_at},
    notebook_id = $notebook_id
:order -updated_at
"#;

pub const NOTEBOOK_LINK_EDGES: &str = r#"
?[target, from_note] :=
    *link{notebook_id, from_note, target},
    notebook_id = $notebook_id
"#;

pub const LIST_NOTEBOOK_TASKS: &str = r#"
?[note_path, note_title, line, text, status, updated_at] :=
    *task{notebook_id, note_path, line, text, status, updated_at},
    *note{notebook_id, path: note_path, title: note_title},
    notebook_id = $notebook_id
:order -updated_at
"#;

pub const NOTE_INDEX_ROWS: &str = r#"
?[path, mtime_ns, size, created_at] :=
    *note{notebook_id, path, mtime_ns, size, created_at},
    notebook_id = $notebook_id
"#;

pub const NOTE_CREATED: &str = r#"
?[created_at] :=
    *note{notebook_id, path, created_at},
    notebook_id = $notebook_id,
    path = $path
"#;

pub const NOTE_TAGS_BY_PATHS: &str = r#"
?[note_path, tag] :=
    *note_tag{notebook_id, note_path, tag},
    notebook_id = $notebook_id,
    note_path in $paths
"#;

pub const NOTE_LINKS: &str = r#"
?[target, label] :=
    *link{notebook_id, from_note, target, label},
    notebook_id = $notebook_id,
    from_note = $path
:order target
"#;

pub const NOTE_BACKLINKS: &str = r#"
?[from_note, from_title, updated_at] :=
    *link{notebook_id, from_note, target},
    *note{notebook_id, path: from_note, title: from_title, updated_at},
    notebook_id = $notebook_id,
    target in $targets
:order -updated_at
"#;

pub const NOTEBOOK_TITLES: &str = r#"
?[path, title, updated_at] :=
    *note{notebook_id, path, title, updated_at},
    notebook_id = $notebook_id
:order -updated_at
"#;

pub const PUT_NOTE_ROWS: &str = r#"
?[notebook_id, path, title, content, summary, mtime_ns, size, created_at, updated_at] <- $rows
:put note {notebook_id, path => title, content, summary, mtime_ns, size, created_at, updated_at}
"#;

pub const DELETE_NOTE_ROWS: &str = r#"
?[notebook_id, path] :=
    *note{notebook_id, path},
    notebook_id = $notebook_id,
    path in $paths
:rm note {notebook_id, path}
"#;

pub const DELETE_TAG_ROWS: &str = r#"
?[notebook_id, note_path, tag] :=
    *note_tag{notebook_id, note_path, tag},
    notebook_id = $notebook_id,
    note_path in $paths
:rm note_tag {notebook_id, note_path, tag}
"#;

pub const DELETE_LINK_ROWS: &str = r#"
?[notebook_id, from_note, target] :=
    *link{notebook_id, from_note, target},
    notebook_id = $notebook_id,
    from_note in $paths
:rm link {notebook_id, from_note, target}
"#;

pub const PUT_TAG_ROWS: &str = r#"
?[notebook_id, note_path, tag] <- $rows
:put note_tag {notebook_id, note_path, tag}
"#;

pub const PUT_LINK_ROWS: &str = r#"
?[notebook_id, from_note, target, label] <- $rows
:put link {notebook_id, from_note, target => label}
"#;

pub const DELETE_TASK_ROWS: &str = r#"
?[notebook_id, note_path, line] :=
    *task{notebook_id, note_path, line},
    notebook_id = $notebook_id,
    note_path in $paths
:rm task {notebook_id, note_path, line}
"#;

pub const DELETE_NOTEBOOK_TASKS: &str = r#"
?[notebook_id, note_path, line] :=
    *task{notebook_id, note_path, line},
    notebook_id = $id
:rm task {notebook_id, note_path, line}
"#;

pub const PUT_TASK_ROWS: &str = r#"
?[notebook_id, note_path, line, text, status, updated_at] <- $rows
:put task {notebook_id, note_path, line => text, status, updated_at}
"#;

// ---------------------------------------------------------------------------
// Search, tags, stats
// ---------------------------------------------------------------------------

pub const SEARCH_NOTES: &str = r#"
?[path, title, summary, created_at, updated_at, score, content] :=
    ~note:fts{notebook_id, path | query: $query, k: $k, bind_score: score},
    *note{notebook_id, path, title, summary, content, created_at, updated_at},
    notebook_id = $notebook_id
:order -score
:limit $limit
"#;

pub const LIST_TAGS: &str = r#"
?[tag, count(note_path)] :=
    *note_tag{notebook_id, note_path, tag},
    notebook_id = $notebook_id
"#;

pub const LIST_JOURNALS: &str = r#"
?[path, title, content, created_at, updated_at] :=
    *note{notebook_id, path, title, content, created_at, updated_at},
    notebook_id = $notebook_id,
    path >= $prefix,
    path < $before
:order -path
:limit $limit
"#;

pub const COUNT_NOTEBOOKS: &str = "?[count(id)] := *notebook{id}";
pub const COUNT_NOTES: &str = "?[count(path)] := *note{path}";
pub const COUNT_TAGS: &str = "?[count(tag)] := *note_tag{tag}";
pub const COUNT_LINKS: &str = "?[count(from_note)] := *link{from_note}";

pub const PING: &str = "?[ok] := ok = 1";

// ---------------------------------------------------------------------------
// Trash (separate metadata database under data/.trash)
// ---------------------------------------------------------------------------

pub const TRASH_CREATE: &str = r#":create trash_entry {
    id: String
    =>
    notebook_id: String,
    notebook_name: String,
    original_path: String,
    kind: String,
    title: String,
    size: Int,
    deleted_at: Float,
    trashed_path: String,
    mime: String,
    preview: String
}"#;

pub const TRASH_PUT: &str = r#"
?[id, notebook_id, notebook_name, original_path, kind, title, size, deleted_at, trashed_path, mime, preview] <-
    [[$id, $notebook_id, $notebook_name, $original_path, $kind, $title, $size, $deleted_at, $trashed_path, $mime, $preview]]
:put trash_entry {id => notebook_id, notebook_name, original_path, kind, title, size, deleted_at, trashed_path, mime, preview}
"#;

pub const TRASH_LIST: &str = r#"
?[id, notebook_id, notebook_name, original_path, kind, title, size, deleted_at, trashed_path, mime, preview] :=
    *trash_entry{id, notebook_id, notebook_name, original_path, kind, title, size, deleted_at, trashed_path, mime, preview}
"#;

pub const TRASH_GET: &str = r#"
?[id, notebook_id, notebook_name, original_path, kind, title, size, deleted_at, trashed_path, mime, preview] :=
    *trash_entry{id, notebook_id, notebook_name, original_path, kind, title, size, deleted_at, trashed_path, mime, preview},
    id = $id
"#;

pub const TRASH_DELETE: &str = r#"
?[id] := *trash_entry{id}, id = $id
:rm trash_entry {id}
"#;

// ---- durable server state (`<data-dir>/opalnote.db`, see ADR 0001) ----------

/// One sparse JSON settings document, stored under the fixed id `settings`.
pub const APP_SETTINGS_CREATE: &str = r#":create app_settings {
    id: String => json: String, updated_at: Float
}"#;

pub const APP_SETTINGS_GET: &str = r#"
?[json] := *app_settings{id: "settings", json}
"#;

pub const APP_SETTINGS_PUT: &str = r#"
?[id, json, updated_at] <- [["settings", $json, $updated_at]]
:put app_settings {id => json, updated_at}
"#;

/// Agent provider configuration: readable connection details plus a browser-made
/// envelope for the upstream key (see the agent provider design).
pub const AGENT_CONFIG_CREATE: &str = r#":create agent_config {
    id: String => base_url: String, models: String, key_envelope: String, updated_at: Float
}"#;

pub const AGENT_CONFIG_GET: &str = r#"
?[base_url, models, key_envelope, updated_at] :=
    *agent_config{id: "agent", base_url, models, key_envelope, updated_at}
"#;

pub const AGENT_CONFIG_PUT: &str = r#"
?[id, base_url, models, key_envelope, updated_at] <-
    [["agent", $base_url, $models, $key_envelope, $updated_at]]
:put agent_config {id => base_url, models, key_envelope, updated_at}
"#;

pub const AGENT_CONFIG_DELETE: &str = r#"
?[id] := *agent_config{id}, id = "agent"
:rm agent_config {id}
"#;

// ---- migration bookkeeping (`opalnote.db`, see `src/migrations.rs`) --------

pub const SCHEMA_MIGRATIONS_CREATE: &str = r#":create schema_migrations {
    version: Int => name: String, applied_at: Float
}"#;

pub const SCHEMA_MIGRATIONS_LIST: &str = r#"
?[version] := *schema_migrations{version}
"#;

pub const SCHEMA_MIGRATIONS_PUT: &str = r#"
?[version, name, applied_at] <- [[$version, $name, $applied_at]]
:put schema_migrations {version => name, applied_at}
"#;

// ---- blocks (positional, derived; see doc/blocks.md R1) --------------------

pub const BLOCK_CREATE: &str = r#":create block {
    notebook_id: String,
    note_path: String,
    seq: Int
    =>
    start_line: Int,
    end_line: Int,
    kind: String,
    depth: Int,
    parent_seq: Int,
    text: String,
    hash: String,
    updated_at: Float
}"#;

pub const BLOCK_INDEX_NOTE: &str = r#"::index create block:by_note { notebook_id, note_path }"#;

pub const BLOCK_INDEX_HASH: &str =
    r#"::index create block:by_hash { notebook_id, note_path, hash }"#;

pub const DELETE_BLOCK_ROWS: &str = r#"
?[notebook_id, note_path, seq] :=
    *block{notebook_id, note_path, seq},
    notebook_id = $notebook_id,
    note_path in $paths
:rm block {notebook_id, note_path, seq}
"#;

pub const PUT_BLOCK_ROWS: &str = r#"
?[notebook_id, note_path, seq, start_line, end_line, kind, depth, parent_seq, text, hash, updated_at] <-
    $rows
:put block {notebook_id, note_path, seq => start_line, end_line, kind, depth, parent_seq, text, hash, updated_at}
"#;

pub const BLOCKS_FOR_NOTE: &str = r#"
?[seq, start_line, end_line, kind, depth, parent_seq, text, hash] :=
    *block{notebook_id, note_path, seq, start_line, end_line, kind, depth, parent_seq, text, hash},
    notebook_id = $notebook_id,
    note_path = $note_path
:order seq
"#;

pub const BLOCK_SEARCH: &str = r#"
?[note_path, seq, start_line, end_line, kind, depth, parent_seq, text, hash] :=
    *block{notebook_id, note_path, seq, start_line, end_line, kind, depth, parent_seq, text, hash},
    notebook_id = $notebook_id,
    str_includes(lowercase(text), $needle)
:order note_path, seq
:limit $limit
"#;
