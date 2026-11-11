//! CozoScript (Datalog) statements used by the store.
//!
//! Relations live in a single MnesticDB instance. Notes are partitioned by
//! `notebook_id`; the `note:by_notebook` secondary index and the `note:fts`
//! full-text index keep reads fast without a second datastore.

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
            id: String
            =>
            notebook_id: String,
            title: String,
            content: String,
            summary: String,
            created_at: Float,
            updated_at: Float
        }"#,
    ),
    (
        "note_tag",
        r#":create note_tag {
            note_id: String,
            tag: String
        }"#,
    ),
    (
        "link",
        r#":create link {
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
?[notebook_id, count(id)] := *note{notebook_id, id}
"#;

pub const GET_NOTEBOOK: &str = r#"
?[id, name, description, created_at, updated_at] :=
    *notebook{id, name, description, created_at, updated_at},
    id = $id
"#;

pub const NOTEBOOK_NOTE_COUNT: &str = r#"
?[count(id)] := *note{notebook_id, id}, notebook_id = $id
"#;

pub const NOTEBOOK_EXISTS: &str = r#"
?[id] := *notebook{id}, id = $id
"#;

pub const CREATE_NOTEBOOK: &str = r#"
?[id, name, description, created_at, updated_at] <- [[$id, $name, $description, $now, $now]]
:put notebook {id => name, description, created_at, updated_at}
"#;

pub const UPDATE_NOTEBOOK: &str = r#"
?[id, name, description, updated_at] <- [[$id, $name, $description, $now]]
:update notebook {id => name, description, updated_at}
"#;

pub const DELETE_NOTEBOOK_TAGS: &str = r#"
?[note_id, tag] :=
    *note_tag{note_id, tag},
    *note{id: note_id, notebook_id},
    notebook_id = $id
:rm note_tag {note_id, tag}
"#;

pub const DELETE_NOTEBOOK_LINKS: &str = r#"
?[from_note, target] :=
    *link{from_note, target},
    *note{id: from_note, notebook_id},
    notebook_id = $id
:rm link {from_note, target}
"#;

pub const DELETE_NOTEBOOK_NOTES: &str = r#"
?[id] := *note{id, notebook_id}, notebook_id = $id
:rm note {id}
"#;

pub const DELETE_NOTEBOOK: &str = r#"
?[id] <- [[$id]]
:rm notebook {id}
"#;

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

pub const LIST_NOTES: &str = r#"
?[id, title, summary, created_at, updated_at] :=
    *note{id, notebook_id, title, summary, created_at, updated_at},
    notebook_id = $notebook_id
:order -updated_at
:limit $limit
:offset $offset
"#;

pub const NOTE_TAGS_BY_IDS: &str = r#"
?[note_id, tag] := *note_tag{note_id, tag}, note_id in $ids
"#;

pub const GET_NOTE: &str = r#"
?[id, notebook_id, title, content, created_at, updated_at] :=
    *note{id, notebook_id, title, content, created_at, updated_at},
    id = $id
"#;

pub const NOTE_TAGS: &str = r#"
?[tag] := *note_tag{note_id, tag}, note_id = $id
:order tag
"#;

pub const NOTE_LINKS: &str = r#"
?[target, label] := *link{from_note, target, label}, from_note = $id
:order target
"#;

pub const NOTE_BACKLINKS: &str = r#"
?[from_note, from_title, updated_at] :=
    *link{from_note, target},
    *note{id: from_note, title: from_title, updated_at},
    target = $target
:order -updated_at
"#;

pub const NOTEBOOK_TITLES: &str = r#"
?[id, title] := *note{id, notebook_id, title}, notebook_id = $notebook_id
"#;

pub const CREATE_NOTE: &str = r#"
?[id, notebook_id, title, content, summary, created_at, updated_at] <-
    [[$id, $notebook_id, $title, $content, $summary, $now, $now]]
:put note {id => notebook_id, title, content, summary, created_at, updated_at}
"#;

pub const UPDATE_NOTE: &str = r#"
?[id, title, content, summary, updated_at] <-
    [[$id, $title, $content, $summary, $now]]
:update note {id => title, content, summary, updated_at}
"#;

pub const DELETE_NOTE: &str = r#"
?[id] <- [[$id]]
:rm note {id}
"#;

pub const DELETE_NOTE_TAGS: &str = r#"
?[note_id, tag] := *note_tag{note_id, tag}, note_id = $id
:rm note_tag {note_id, tag}
"#;

pub const DELETE_NOTE_LINKS: &str = r#"
?[from_note, target] := *link{from_note, target}, from_note = $id
:rm link {from_note, target}
"#;

pub const PUT_TAGS: &str = r#"
?[note_id, tag] <- $tag_rows
:put note_tag {note_id, tag}
"#;

pub const PUT_LINKS: &str = r#"
?[from_note, target, label] <- $link_rows
:put link {from_note, target => label}
"#;

// ---------------------------------------------------------------------------
// Search, tags, stats
// ---------------------------------------------------------------------------

pub const SEARCH_NOTES: &str = r#"
?[id, notebook_id, title, summary, created_at, updated_at, score] :=
    ~note:fts{id | query: $query, k: $k, bind_score: score},
    *note{id, notebook_id, title, summary, created_at, updated_at},
    notebook_id = $notebook_id
:order -score
:limit $limit
"#;

pub const LIST_TAGS: &str = r#"
?[tag, count(note_id)] :=
    *note_tag{note_id, tag},
    *note{id: note_id, notebook_id},
    notebook_id = $notebook_id
"#;

pub const COUNT_NOTEBOOKS: &str = "?[count(id)] := *notebook{id}";
pub const COUNT_NOTES: &str = "?[count(id)] := *note{id}";
pub const COUNT_TAGS: &str = "?[count(tag)] := *note_tag{tag}";
pub const COUNT_LINKS: &str = "?[count(from_note)] := *link{from_note}";

pub const PING: &str = "?[ok] := ok = 1";
