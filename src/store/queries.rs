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
];

pub const INDEXES: &[&str] = &[
    r#"::index create note:by_notebook { notebook_id }"#,
    r#"::fts create note:fts {
        extractor: title ++ ' ' ++ content,
        tokenizer: Simple,
        filters: [Lowercase, Stemmer('English')]
    }"#,
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
