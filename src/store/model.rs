use serde::{Deserialize, Serialize};

/// A notebook (vault / space). Notes are always scoped to exactly one notebook.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Notebook {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
    pub note_count: i64,
}

/// Compact note representation used by lists and search results.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteSummary {
    /// Path relative to the notebook root, e.g. `pages/hello.md`.
    pub id: String,
    pub notebook_id: String,
    pub title: String,
    pub excerpt: String,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
    /// BM25 score; only present on search results.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
}

/// A resolved outgoing `[[wikilink]]`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LinkRef {
    /// Normalized target title, as used by the index.
    pub target: String,
    /// Original label typed by the user.
    pub label: String,
    /// `Some` when a note with that title exists in the same notebook.
    pub note_id: Option<String>,
    pub title: Option<String>,
}

/// A note that links to the current note.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BacklinkRef {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Note {
    /// Path relative to the notebook root, e.g. `pages/hello.md`.
    pub id: String,
    pub notebook_id: String,
    pub title: String,
    /// Markdown body with frontmatter removed.
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
    /// Explicit frontmatter tags only (what the tag editor edits).
    pub explicit_tags: Vec<String>,
    /// Frontmatter tags plus inline `#tags`.
    pub tags: Vec<String>,
    pub links: Vec<LinkRef>,
    pub backlinks: Vec<BacklinkRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
}

/// Global, read-only view of the store used by `/api/stats`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Stats {
    pub notebooks: i64,
    pub notes: i64,
    pub tags: i64,
    pub links: i64,
}
