//! File-first note store.
//!
//! Markdown files on disk are canonical. MnesticDB holds a disposable index
//! that is reconciled with the filesystem on startup and before every read.
//! Writes go to disk first, then the index is refreshed.

pub mod files;
pub mod markdown;
pub mod model;
mod queries;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use cozo::{DataValue, DbInstance, NamedRows, ScriptMutability, ScriptRunOptions};

use self::markdown::{
    extract_tasks, extract_wikilinks, merge_tags, note_link_keys, parse_page, render_page,
    summarize, ParsedTask,
};
use self::model::{
    AssetEntry, AssetInfo, AssetList, AssetReference, BacklinkRef, GraphData, GraphEdge, GraphNode,
    JournalPage, LinkRef, Note, NoteSummary, Notebook, PageList, PageOverview, Stats, TagCount,
};

const QUERY_MEM_LIMIT_BYTES: usize = 64 * 1024 * 1024;
const SUMMARY_CHARS: usize = 220;
const MAX_IMPORT_BYTES: u64 = 512 * 1024 * 1024;

/// User search text is not FTS syntax. Split it into alphanumeric words and
/// quote each one so punctuation and operator words cannot break the parser.
fn search_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = query
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|token| !token.is_empty())
        .map(str::to_lowercase)
        .collect();
    terms.sort_by_key(|term| std::cmp::Reverse(term.len()));
    terms.dedup();
    terms
}

fn search_excerpt(content: &str, terms: &[String]) -> Option<String> {
    if content.trim().is_empty() || terms.is_empty() {
        return None;
    }

    let lower = content.to_lowercase();
    let mut hit: Option<usize> = None;
    for term in terms {
        if let Some(position) = lower.find(term) {
            if hit.is_none_or(|earliest| position < earliest) {
                hit = Some(position);
            }
        }
    }
    let position = hit?;

    let start = floor_char_boundary(content, position.saturating_sub(52));
    let end = ceil_char_boundary(content, (position + 150).min(content.len()));
    let mut excerpt = clean_search_snippet(&content[start..end]);
    if start > 0 {
        excerpt.insert(0, '…');
    }
    if end < content.len() {
        excerpt.push('…');
    }
    Some(excerpt)
}

/// Keep snippets readable while preserving search terms. This handles the
/// common inline markdown constructs without pulling in a markdown parser.
fn clean_search_snippet(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;

    while index < chars.len() {
        if chars[index] == '[' {
            if index + 1 < chars.len() && chars[index + 1] == '[' {
                if let Some(end) = find_chars(&chars, index + 2, &[']', ']']) {
                    let inner: String = chars[index + 2..end].iter().collect();
                    let label = inner
                        .split_once('|')
                        .map(|(_, label)| label)
                        .unwrap_or(inner.as_str());
                    out.push_str(label);
                    index = end + 2;
                    continue;
                }
            } else if let Some(close) = find_char(&chars, index + 1, ']') {
                if close + 1 < chars.len() && chars[close + 1] == '(' {
                    if let Some(end) = find_char(&chars, close + 2, ')') {
                        let label: String = chars[index + 1..close].iter().collect();
                        out.push_str(&label);
                        index = end + 1;
                        continue;
                    }
                }
            }
        }

        if chars[index] == '`' {
            index += 1;
            continue;
        }

        out.push(if chars[index] == '\n' {
            ' '
        } else {
            chars[index]
        });
        index += 1;
    }

    let cleaned = out.split_whitespace().collect::<Vec<_>>().join(" ");
    cleaned
        .trim_start_matches(['#', '>', '-', '*', '+', ' '])
        .to_string()
}

fn find_char(chars: &[char], start: usize, needle: char) -> Option<usize> {
    (start..chars.len()).find(|index| chars[*index] == needle)
}

fn find_chars(chars: &[char], start: usize, needle: &[char; 2]) -> Option<usize> {
    (start..chars.len().saturating_sub(1))
        .find(|index| chars[*index] == needle[0] && chars[*index + 1] == needle[1])
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn normalize_fts_query(query: &str) -> String {
    query
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|token| !token.is_empty())
        .map(|token| format!("\"{token}\""))
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// Result of renaming/updating a notebook.
pub enum AssetRename {
    Renamed(AssetEntry),
    NotFound,
    Conflict,
}

pub enum NotebookUpdate {
    Updated(Notebook),
    NotFound,
    Conflict,
}

/// Result of updating a page.
pub enum NoteUpdate {
    Updated(Box<Note>),
    NotFound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteSection {
    Pages,
    Journals,
}

impl NoteSection {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pages" | "" => Some(Self::Pages),
            "journals" => Some(Self::Journals),
            _ => None,
        }
    }
}

pub struct Store {
    db: DbInstance,
    data_dir: PathBuf,
    notebooks_dir: PathBuf,
    fs_lock: Mutex<()>,
    default_query_timeout_secs: f64,
}

struct NotebookRow {
    id: String,
    name: String,
    description: String,
    created_at: f64,
    updated_at: f64,
}

impl NotebookRow {
    fn into_model(self, note_count: i64) -> Notebook {
        Notebook {
            id: self.id,
            name: self.name,
            description: self.description,
            created_at: fmt_ts(self.created_at),
            updated_at: fmt_ts(self.updated_at),
            note_count,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum PageSortKey {
    Title,
    Backlinks,
    Tags,
    CreatedAt,
    UpdatedAt,
}

impl PageSortKey {
    fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("updated_at") {
            "title" => Self::Title,
            "backlinks" => Self::Backlinks,
            "tags" => Self::Tags,
            "created_at" => Self::CreatedAt,
            "updated_at" => Self::UpdatedAt,
            _ => Self::UpdatedAt,
        }
    }

    fn compare(self, left: &PageOverview, right: &PageOverview) -> std::cmp::Ordering {
        match self {
            Self::Title => left.title.to_lowercase().cmp(&right.title.to_lowercase()),
            Self::Backlinks => left.backlink_count.cmp(&right.backlink_count),
            Self::Tags => left.tags.join(" ").cmp(&right.tags.join(" ")),
            Self::CreatedAt => left.created_at.cmp(&right.created_at),
            Self::UpdatedAt => left.updated_at.cmp(&right.updated_at),
        }
    }
}

struct IndexedNote {
    mtime_ns: i64,
    size: i64,
    created_at: f64,
}

struct PageRecord {
    path: String,
    title: String,
    body: String,
    summary: String,
    tags: Vec<String>,
    links: Vec<(String, String)>,
    tasks: Vec<ParsedTask>,
    mtime_ns: i64,
    size: i64,
    created_at: f64,
    updated_at: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct PageListOptions<'a> {
    pub limit: usize,
    pub offset: usize,
    pub query: Option<&'a str>,
    pub tag: Option<&'a str>,
    pub sort: Option<&'a str>,
    pub direction: Option<&'a str>,
}

#[derive(Debug, Clone, Copy)]
pub struct AssetListOptions<'a> {
    pub limit: usize,
    pub offset: usize,
    pub query: Option<&'a str>,
    pub kind: Option<&'a str>,
    pub sort: Option<&'a str>,
    pub direction: Option<&'a str>,
}

impl Store {
    pub fn open(data_dir: &Path, default_query_timeout_secs: f64) -> Result<Self> {
        let notebooks_dir = data_dir.join("notebooks");
        let index_dir = data_dir.join("index");
        fs::create_dir_all(&notebooks_dir)
            .with_context(|| format!("creating data dir {}", notebooks_dir.display()))?;
        fs::create_dir_all(&index_dir)
            .with_context(|| format!("creating index dir {}", index_dir.display()))?;

        let path = index_dir.join("opalnote.sqlite3");
        let legacy_index = index_dir.join("db");
        if legacy_index.exists() {
            tracing::warn!(
                path = %legacy_index.display(),
                "legacy RocksDB index found; SQLite uses index/opalnote.sqlite3 and the old directory can be deleted"
            );
        }

        let db = DbInstance::new("sqlite", &path, "")
            .map_err(|err| anyhow!("opening MnesticDB at {}: {err}", path.display()))?;

        let store = Self {
            db,
            data_dir: data_dir.to_path_buf(),
            notebooks_dir,
            fs_lock: Mutex::new(()),
            default_query_timeout_secs,
        };
        let task_backfill = store.init_schema()?;

        // Build/refresh the index from whatever is already on disk. A newly
        // added task relation needs a one-time full read so existing notes get
        // task rows without requiring a manual reindex.
        store.sync_all_locked(task_backfill)?;
        Ok(store)
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    fn init_schema(&self) -> Result<bool> {
        let existing = self.run_raw("::relations", BTreeMap::new(), ScriptMutability::Immutable)?;
        let names: HashSet<String> = existing
            .rows
            .iter()
            .filter_map(|row| row.first().and_then(DataValue::get_str).map(str::to_string))
            .collect();

        let mut created_task_relation = false;
        for (name, ddl) in queries::RELATIONS {
            if !names.contains(*name) {
                if *name == "task" {
                    created_task_relation = true;
                }
                self.run_raw(ddl, BTreeMap::new(), ScriptMutability::Mutable)
                    .with_context(|| format!("creating relation `{name}`"))?;
            }
        }

        for script in queries::INDEXES {
            if let Err(err) = self.run_raw(script, BTreeMap::new(), ScriptMutability::Mutable) {
                if !err.to_string().contains("already exists") {
                    return Err(err).context("creating index");
                }
            }
        }
        Ok(created_task_relation)
    }

    fn run_raw(
        &self,
        script: &str,
        params: BTreeMap<String, DataValue>,
        mutability: ScriptMutability,
    ) -> Result<NamedRows> {
        self.db
            .run_script(script, params, mutability)
            .map_err(|err| anyhow!(err.to_string()))
    }

    fn run(
        &self,
        script: &str,
        params: BTreeMap<String, DataValue>,
        mutability: ScriptMutability,
    ) -> Result<NamedRows> {
        self.run_raw(script, params, mutability)
    }

    /// Execute several statements atomically on a dedicated transaction thread.
    fn run_atomic(
        &self,
        statements: Vec<(&'static str, BTreeMap<String, DataValue>)>,
    ) -> Result<()> {
        if statements.is_empty() {
            return Ok(());
        }
        let transaction = self.db.multi_transaction(true);
        let mut committed = false;
        let outcome = (|| -> Result<()> {
            for (script, params) in statements {
                transaction
                    .run_script(script, params)
                    .map_err(|err| anyhow!(err.to_string()))?;
            }
            transaction
                .commit()
                .map_err(|err| anyhow!(err.to_string()))?;
            committed = true;
            Ok(())
        })();
        if !committed {
            let _ = transaction.abort();
        }
        outcome
    }

    // -----------------------------------------------------------------------
    // Sync
    // -----------------------------------------------------------------------

    fn lock_fs(&self) -> MutexGuard<'_, ()> {
        self.fs_lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// Reconcile the index with the filesystem. Reads always call this, so an
    /// external edit is visible on the very next request.
    fn ensure_synced(&self) -> Result<()> {
        let _guard = self.lock_fs();
        self.sync_all_locked(false)
    }

    fn sync_all_locked(&self, force: bool) -> Result<()> {
        let dirs = files::list_notebook_dirs(&self.notebooks_dir)?;
        let present: HashSet<String> = dirs.iter().cloned().collect();

        for id in &dirs {
            // A single unreadable folder should not take the whole server down;
            // log it and retry on the next sync.
            if let Err(err) = self.sync_notebook_locked(id, force) {
                tracing::warn!("indexing notebook `{id}` failed: {err:#}");
            }
        }

        let indexed = self.run(
            queries::NOTEBOOKS_INDEXED,
            BTreeMap::new(),
            ScriptMutability::Immutable,
        )?;
        for row in indexed.rows {
            let id = col_str(&row, 0);
            if !present.contains(&id) {
                self.delete_notebook_rows_locked(&id)?;
            }
        }

        Ok(())
    }

    fn sync_notebook_locked(&self, notebook_id: &str, force: bool) -> Result<()> {
        let notebook = self.notebook_dir(notebook_id)?;
        if !notebook.is_dir() {
            self.delete_notebook_rows_locked(notebook_id)?;
            return Ok(());
        }

        files::canonicalize_layout(&notebook)?;
        let meta = files::read_meta(&notebook);
        let existing = self.get_notebook_row_locked(notebook_id)?;
        let indexed = self.index_rows_locked(notebook_id)?;
        let page_files = files::list_page_files(&notebook)?;
        let times = files::notebook_times(&notebook)?;

        let mut seen: HashSet<String> = HashSet::new();
        let mut changed: Vec<PageRecord> = Vec::new();
        let mut max_updated = times.updated_at;

        for file in page_files {
            seen.insert(file.rel.clone());
            max_updated = max_updated.max(file.updated_at);

            if !force
                && indexed
                    .get(&file.rel)
                    .is_some_and(|row| row.mtime_ns == file.mtime_ns && row.size == file.size)
            {
                continue;
            }

            let raw = match files::read_text(&file.abs) {
                Ok(raw) => raw,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    seen.remove(&file.rel);
                    continue;
                }
                Err(err) => {
                    return Err(err).with_context(|| format!("reading {}", file.abs.display()));
                }
            };

            let parsed = parse_page(&raw);
            let title = files::title_from_path(Path::new(&file.rel));
            changed.push(PageRecord {
                tags: merge_tags(&parsed.body, &parsed.tags),
                links: extract_wikilinks(&parsed.body),
                tasks: extract_tasks(&parsed.body),
                summary: summarize(&parsed.body, SUMMARY_CHARS),
                path: file.rel.clone(),
                title,
                body: parsed.body,
                mtime_ns: file.mtime_ns,
                size: file.size,
                created_at: indexed
                    .get(&file.rel)
                    .map(|row| row.created_at)
                    .unwrap_or(file.created_at),
                updated_at: file.updated_at,
            });
        }

        let removed: Vec<String> = indexed
            .keys()
            .filter(|path| !seen.contains(*path))
            .cloned()
            .collect();

        let created_at = existing
            .as_ref()
            .map(|row| row.created_at)
            .unwrap_or(times.created_at);

        let notebook_changed = match &existing {
            None => true,
            Some(row) => {
                row.name != notebook_id
                    || row.description != meta.description
                    || (row.updated_at - max_updated).abs() > 1e-6
                    || (row.created_at - created_at).abs() > 1e-6
            }
        };

        if changed.is_empty() && removed.is_empty() && !notebook_changed {
            return Ok(());
        }

        let mut statements: Vec<(&'static str, BTreeMap<String, DataValue>)> = Vec::new();

        if !removed.is_empty() {
            let par = params([
                ("notebook_id", DataValue::from(notebook_id)),
                ("paths", dv_list(removed)),
            ]);
            statements.push((queries::DELETE_TAG_ROWS, par.clone()));
            statements.push((queries::DELETE_LINK_ROWS, par.clone()));
            statements.push((queries::DELETE_TASK_ROWS, par.clone()));
            statements.push((queries::DELETE_NOTE_ROWS, par));
        }

        if !changed.is_empty() {
            let rows = DataValue::List(
                changed
                    .iter()
                    .map(|page| note_row(notebook_id, page))
                    .collect(),
            );
            statements.push((queries::PUT_NOTE_ROWS, params([("rows", rows)])));

            let par = params([
                ("notebook_id", DataValue::from(notebook_id)),
                (
                    "paths",
                    dv_list(changed.iter().map(|page| page.path.clone()).collect()),
                ),
            ]);
            statements.push((queries::DELETE_TAG_ROWS, par.clone()));
            statements.push((queries::DELETE_LINK_ROWS, par.clone()));
            statements.push((queries::DELETE_TASK_ROWS, par));

            let tag_rows: Vec<DataValue> = changed
                .iter()
                .flat_map(|page| {
                    page.tags.iter().map(|tag| {
                        DataValue::List(vec![
                            DataValue::from(notebook_id),
                            DataValue::from(page.path.as_str()),
                            DataValue::from(tag.as_str()),
                        ])
                    })
                })
                .collect();
            if !tag_rows.is_empty() {
                statements.push((
                    queries::PUT_TAG_ROWS,
                    params([("rows", DataValue::List(tag_rows))]),
                ));
            }

            let link_rows: Vec<DataValue> = changed
                .iter()
                .flat_map(|page| {
                    page.links.iter().map(|(target, label)| {
                        DataValue::List(vec![
                            DataValue::from(notebook_id),
                            DataValue::from(page.path.as_str()),
                            DataValue::from(target.as_str()),
                            DataValue::from(label.as_str()),
                        ])
                    })
                })
                .collect();
            if !link_rows.is_empty() {
                statements.push((
                    queries::PUT_LINK_ROWS,
                    params([("rows", DataValue::List(link_rows))]),
                ));
            }

            let task_rows: Vec<DataValue> = changed
                .iter()
                .flat_map(|page| {
                    page.tasks.iter().map(|task| {
                        DataValue::List(vec![
                            DataValue::from(notebook_id),
                            DataValue::from(page.path.as_str()),
                            DataValue::from(task.line as i64),
                            DataValue::from(task.text.as_str()),
                            DataValue::from(task.status.as_str()),
                            DataValue::from(page.updated_at),
                        ])
                    })
                })
                .collect();
            if !task_rows.is_empty() {
                statements.push((
                    queries::PUT_TASK_ROWS,
                    params([("rows", DataValue::List(task_rows))]),
                ));
            }
        }

        if notebook_changed {
            statements.push((
                queries::PUT_NOTEBOOK,
                params([
                    ("id", DataValue::from(notebook_id)),
                    ("name", DataValue::from(notebook_id)),
                    ("description", DataValue::from(meta.description.as_str())),
                    ("created_at", DataValue::from(created_at)),
                    ("updated_at", DataValue::from(max_updated)),
                ]),
            ));
        }

        self.run_atomic(statements)
    }

    fn index_rows_locked(&self, notebook_id: &str) -> Result<HashMap<String, IndexedNote>> {
        let rows = self.run(
            queries::NOTE_INDEX_ROWS,
            params([("notebook_id", DataValue::from(notebook_id))]),
            ScriptMutability::Immutable,
        )?;
        Ok(rows
            .rows
            .iter()
            .map(|row| {
                (
                    col_str(row, 0),
                    IndexedNote {
                        mtime_ns: col_i64(row, 1),
                        size: col_i64(row, 2),
                        created_at: col_f64(row, 3),
                    },
                )
            })
            .collect())
    }

    fn delete_notebook_rows_locked(&self, notebook_id: &str) -> Result<()> {
        let par = params([("id", DataValue::from(notebook_id))]);
        self.run_atomic(vec![
            (queries::DELETE_NOTEBOOK_TAGS, par.clone()),
            (queries::DELETE_NOTEBOOK_LINKS, par.clone()),
            (queries::DELETE_NOTEBOOK_TASKS, par.clone()),
            (queries::DELETE_NOTEBOOK_NOTES, par.clone()),
            (queries::DELETE_NOTEBOOK, par),
        ])
    }

    // -----------------------------------------------------------------------
    // Notebooks
    // -----------------------------------------------------------------------

    pub fn list_notebooks(&self) -> Result<Vec<Notebook>> {
        self.ensure_synced()?;
        let rows = self.run(
            queries::LIST_NOTEBOOKS,
            BTreeMap::new(),
            ScriptMutability::Immutable,
        )?;
        let counts = self.notebook_note_counts()?;

        Ok(rows
            .rows
            .iter()
            .map(|row| {
                let row = notebook_row_from(row);
                let count = counts.get(&row.id).copied().unwrap_or(0);
                row.into_model(count)
            })
            .collect())
    }

    fn notebook_note_counts(&self) -> Result<HashMap<String, i64>> {
        let rows = self.run(
            queries::NOTEBOOK_COUNTS,
            BTreeMap::new(),
            ScriptMutability::Immutable,
        )?;
        Ok(rows
            .rows
            .iter()
            .map(|row| (col_str(row, 0), col_i64(row, 1)))
            .collect())
    }

    pub fn get_notebook(&self, id: &str) -> Result<Option<Notebook>> {
        self.ensure_synced()?;
        let Some(row) = self.get_notebook_row_locked(id)? else {
            return Ok(None);
        };
        let count = self.notebook_note_count_locked(id)?;
        Ok(Some(row.into_model(count)))
    }

    fn get_notebook_row_locked(&self, id: &str) -> Result<Option<NotebookRow>> {
        let rows = self.run(
            queries::GET_NOTEBOOK,
            params([("id", DataValue::from(id))]),
            ScriptMutability::Immutable,
        )?;
        Ok(rows.rows.first().map(|row| notebook_row_from(row)))
    }

    fn notebook_note_count_locked(&self, id: &str) -> Result<i64> {
        let rows = self.run(
            queries::NOTEBOOK_NOTE_COUNT,
            params([("id", DataValue::from(id))]),
            ScriptMutability::Immutable,
        )?;
        Ok(rows.rows.first().map(|row| col_i64(row, 0)).unwrap_or(0))
    }

    pub fn notebook_exists(&self, id: &str) -> Result<bool> {
        let Ok(dir) = self.notebook_dir(id) else {
            return Ok(false);
        };
        Ok(dir.is_dir())
    }

    pub fn create_notebook(&self, name: &str, description: &str) -> Result<Option<Notebook>> {
        let id = files::sanitize_name(name, "Notebook");
        let notebook = self.notebooks_dir.join(&id);
        let _guard = self.lock_fs();

        self.sync_all_locked(false)?;
        if notebook.exists() {
            return Ok(None);
        }

        files::ensure_layout(&notebook)?;
        if !description.trim().is_empty() {
            files::write_meta(&notebook, description)?;
        }
        self.sync_notebook_locked(&id, true)?;

        let row = self
            .get_notebook_row_locked(&id)?
            .ok_or_else(|| anyhow!("notebook vanished after create"))?;
        Ok(Some(row.into_model(0)))
    }

    pub fn update_notebook(
        &self,
        id: &str,
        name: &str,
        description: &str,
    ) -> Result<NotebookUpdate> {
        let _guard = self.lock_fs();
        self.sync_all_locked(false)?;

        let old_dir = self.notebook_dir(id)?;
        if !old_dir.is_dir() {
            return Ok(NotebookUpdate::NotFound);
        }

        let new_id = files::sanitize_name(name, "Notebook");
        if new_id != id {
            let new_dir = self.notebooks_dir.join(&new_id);
            if new_dir.exists() {
                return Ok(NotebookUpdate::Conflict);
            }
            fs::rename(&old_dir, &new_dir)
                .with_context(|| format!("renaming notebook `{id}` to `{new_id}`"))?;
            // The index is keyed by notebook id; drop the old rows and let the
            // next sync read the (unchanged) files under the new id.
            self.delete_notebook_rows_locked(id)?;
        }

        let dir = self.notebooks_dir.join(&new_id);
        if description.trim().is_empty() {
            files::remove_meta(&dir)?;
        } else {
            files::write_meta(&dir, description)?;
        }
        self.sync_notebook_locked(&new_id, false)?;

        let row = self
            .get_notebook_row_locked(&new_id)?
            .ok_or_else(|| anyhow!("notebook vanished after update"))?;
        let count = self.notebook_note_count_locked(&new_id)?;
        Ok(NotebookUpdate::Updated(row.into_model(count)))
    }

    pub fn delete_notebook(&self, id: &str) -> Result<bool> {
        let _guard = self.lock_fs();
        self.sync_all_locked(false)?;

        let dir = self.notebook_dir(id)?;
        if !dir.is_dir() {
            return Ok(false);
        }
        files::trash_notebook(&self.data_dir, id, &dir)?;
        self.delete_notebook_rows_locked(id)?;
        Ok(true)
    }

    // -----------------------------------------------------------------------
    // Notes
    // -----------------------------------------------------------------------

    pub fn list_notes(
        &self,
        notebook_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<NoteSummary>> {
        self.ensure_synced()?;
        let rows = self.run(
            queries::LIST_NOTES,
            params([
                ("notebook_id", DataValue::from(notebook_id)),
                ("limit", DataValue::from(limit as i64)),
                ("offset", DataValue::from(offset as i64)),
            ]),
            ScriptMutability::Immutable,
        )?;
        self.list_rows_to_summaries(&rows, notebook_id)
    }

    fn all_page_overviews_locked(&self, notebook_id: &str) -> Result<Vec<PageOverview>> {
        let rows = self.run(
            queries::LIST_ALL_NOTES,
            params([("notebook_id", DataValue::from(notebook_id))]),
            ScriptMutability::Immutable,
        )?;
        let notes = self.list_rows_to_summaries(&rows, notebook_id)?;
        let counts = self.backlink_counts_locked(notebook_id, &notes)?;
        let empty_by_path: HashMap<String, bool> = rows
            .rows
            .iter()
            .map(|row| (col_str(row, 0), col_str(row, 5).trim().is_empty()))
            .collect();

        Ok(notes
            .into_iter()
            .map(|note| {
                let backlink_count = counts.get(&note.id).copied().unwrap_or(0);
                PageOverview {
                    is_orphan: backlink_count == 0
                        && empty_by_path.get(&note.id).copied().unwrap_or(false),
                    backlink_count,
                    id: note.id,
                    notebook_id: note.notebook_id,
                    title: note.title,
                    tags: note.tags,
                    created_at: note.created_at,
                    updated_at: note.updated_at,
                }
            })
            .collect())
    }

    /// All notes in a notebook with resolved backlink counts and orphan flags,
    /// filtered/sorted/paginated for the pages directory.
    pub fn list_page_overviews(
        &self,
        notebook_id: &str,
        options: PageListOptions<'_>,
    ) -> Result<PageList> {
        let PageListOptions {
            limit,
            offset,
            query,
            tag,
            sort,
            direction,
        } = options;
        self.ensure_synced()?;
        let mut pages = self.all_page_overviews_locked(notebook_id)?;

        let needle = query.unwrap_or("").trim().to_lowercase();
        let tag = tag.map(str::trim).filter(|value| !value.is_empty());
        if !needle.is_empty() || tag.is_some() {
            pages.retain(|page| {
                if let Some(tag) = tag {
                    if !page.tags.iter().any(|candidate| candidate == tag) {
                        return false;
                    }
                }
                if needle.is_empty() {
                    return true;
                }
                format!("{} {} {}", page.title, page.id, page.tags.join(" "))
                    .to_lowercase()
                    .contains(&needle)
            });
        }

        let sort = PageSortKey::parse(sort);
        let ascending = matches!(direction, Some("asc"));
        pages.sort_by(|left, right| {
            let ordering = sort.compare(left, right);
            if ascending {
                ordering
            } else {
                ordering.reverse()
            }
        });

        let total = pages.len() as i64;
        let offset = offset.min(pages.len());
        let end = offset.saturating_add(limit).min(pages.len());
        Ok(PageList {
            pages: pages[offset..end].to_vec(),
            total,
            limit,
            offset,
        })
    }

    /// Empty pages with no resolved backlinks.
    pub fn list_orphan_pages(&self, notebook_id: &str) -> Result<Vec<PageOverview>> {
        self.ensure_synced()?;
        let mut pages = self.all_page_overviews_locked(notebook_id)?;
        pages.retain(|page| page.is_orphan);
        Ok(pages)
    }

    /// Nodes and resolved links for the notebook graph.
    pub fn graph(&self, notebook_id: &str) -> Result<GraphData> {
        self.ensure_synced()?;
        let rows = self.run(
            queries::LIST_ALL_NOTES,
            params([("notebook_id", DataValue::from(notebook_id))]),
            ScriptMutability::Immutable,
        )?;
        let notes = self.list_rows_to_summaries(&rows, notebook_id)?;

        let mut key_to_path: HashMap<String, String> = HashMap::new();
        for note in &notes {
            for key in note_link_keys(&note.title, &note.id) {
                key_to_path.entry(key).or_insert_with(|| note.id.clone());
            }
        }

        let edge_rows = self.run(
            queries::NOTEBOOK_LINK_EDGES,
            params([("notebook_id", DataValue::from(notebook_id))]),
            ScriptMutability::Immutable,
        )?;
        let mut edges = Vec::new();
        let mut seen = HashSet::new();
        for row in &edge_rows.rows {
            let target_key = col_str(row, 0);
            let source = col_str(row, 1);
            let Some(target) = key_to_path.get(&target_key) else {
                continue;
            };
            if seen.insert((source.clone(), target.clone())) {
                edges.push(GraphEdge {
                    source,
                    target: target.clone(),
                });
            }
        }

        Ok(GraphData {
            nodes: notes
                .into_iter()
                .map(|note| GraphNode {
                    id: note.id,
                    title: note.title,
                    tags: note.tags,
                })
                .collect(),
            edges,
        })
    }

    pub fn search_notes(
        &self,
        notebook_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<NoteSummary>> {
        self.ensure_synced()?;
        let terms = search_terms(query);
        let query = normalize_fts_query(query);
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let rows = self.run(
            queries::SEARCH_NOTES,
            params([
                ("notebook_id", DataValue::from(notebook_id)),
                ("query", DataValue::from(query.as_str())),
                // The FTS index is notebook-agnostic; over-fetch candidates
                // before filtering so one busy notebook cannot starve another.
                (
                    "k",
                    DataValue::from(limit.saturating_mul(4).min(400) as i64),
                ),
                ("limit", DataValue::from(limit as i64)),
            ]),
            ScriptMutability::Immutable,
        )?;
        let tags = self.tags_for_paths_locked(
            notebook_id,
            &rows
                .rows
                .iter()
                .map(|row| col_str(row, 0))
                .collect::<Vec<_>>(),
        )?;

        Ok(rows
            .rows
            .iter()
            .map(|row| {
                let path = col_str(row, 0);
                NoteSummary {
                    tags: tags.get(&path).cloned().unwrap_or_default(),
                    id: path,
                    notebook_id: notebook_id.to_string(),
                    title: col_str(row, 1),
                    excerpt: search_excerpt(&col_str(row, 6), &terms)
                        .unwrap_or_else(|| col_str(row, 2)),
                    created_at: fmt_ts(col_f64(row, 3)),
                    updated_at: fmt_ts(col_f64(row, 4)),
                    score: Some(col_f64(row, 5)),
                }
            })
            .collect())
    }

    fn list_rows_to_summaries(
        &self,
        rows: &NamedRows,
        notebook_id: &str,
    ) -> Result<Vec<NoteSummary>> {
        let paths: Vec<String> = rows.rows.iter().map(|row| col_str(row, 0)).collect();
        let tags = self.tags_for_paths_locked(notebook_id, &paths)?;

        Ok(rows
            .rows
            .iter()
            .map(|row| {
                let path = col_str(row, 0);
                NoteSummary {
                    tags: tags.get(&path).cloned().unwrap_or_default(),
                    id: path,
                    notebook_id: notebook_id.to_string(),
                    title: col_str(row, 1),
                    excerpt: col_str(row, 2),
                    created_at: fmt_ts(col_f64(row, 3)),
                    updated_at: fmt_ts(col_f64(row, 4)),
                    score: None,
                }
            })
            .collect())
    }

    fn backlink_counts_locked(
        &self,
        notebook_id: &str,
        notes: &[NoteSummary],
    ) -> Result<HashMap<String, i64>> {
        let rows = self.run(
            queries::NOTEBOOK_LINK_EDGES,
            params([("notebook_id", DataValue::from(notebook_id))]),
            ScriptMutability::Immutable,
        )?;

        let mut by_target: HashMap<String, HashSet<String>> = HashMap::new();
        for row in &rows.rows {
            by_target
                .entry(col_str(row, 0))
                .or_default()
                .insert(col_str(row, 1));
        }

        let mut counts = HashMap::with_capacity(notes.len());
        for note in notes {
            let mut sources = HashSet::new();
            for key in note_link_keys(&note.title, &note.id) {
                if let Some(from_notes) = by_target.get(&key) {
                    sources.extend(from_notes.iter().cloned());
                }
            }
            counts.insert(note.id.clone(), sources.len() as i64);
        }
        Ok(counts)
    }

    fn tags_for_paths_locked(
        &self,
        notebook_id: &str,
        paths: &[String],
    ) -> Result<HashMap<String, Vec<String>>> {
        if paths.is_empty() {
            return Ok(HashMap::new());
        }
        let rows = self.run(
            queries::NOTE_TAGS_BY_PATHS,
            params([
                ("notebook_id", DataValue::from(notebook_id)),
                ("paths", dv_list(paths.to_vec())),
            ]),
            ScriptMutability::Immutable,
        )?;

        let mut by_path: HashMap<String, Vec<String>> = HashMap::new();
        for row in &rows.rows {
            by_path
                .entry(col_str(row, 0))
                .or_default()
                .push(col_str(row, 1));
        }
        for tags in by_path.values_mut() {
            tags.sort();
            tags.dedup();
        }
        Ok(by_path)
    }

    pub fn get_note(&self, notebook_id: &str, path: &str) -> Result<Option<Note>> {
        self.ensure_synced()?;
        self.get_note_locked(notebook_id, path)
    }

    fn get_note_locked(&self, notebook_id: &str, path: &str) -> Result<Option<Note>> {
        let notebook = self.notebook_dir(notebook_id)?;
        if !notebook.is_dir() {
            return Ok(None);
        }
        let absolute = match files::resolve_note_path(&notebook, path) {
            Ok(path) => path,
            Err(_) => return Ok(None),
        };
        let raw = match files::read_text(&absolute) {
            Ok(raw) => raw,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => {
                return Err(err).with_context(|| format!("reading {}", absolute.display()));
            }
        };

        let parsed = parse_page(&raw);
        let title = files::title_from_path(&absolute);
        let (created_fallback, updated_at) = files::note_times(&absolute)?;
        let created_at = self
            .note_created_locked(notebook_id, path)?
            .unwrap_or(created_fallback);
        let tags = merge_tags(&parsed.body, &parsed.tags);

        Ok(Some(Note {
            id: path.to_string(),
            notebook_id: notebook_id.to_string(),
            title,
            content: parsed.body,
            created_at: fmt_ts(created_at),
            updated_at: fmt_ts(updated_at),
            explicit_tags: parsed.tags,
            tags,
            links: self.links_for_note_locked(notebook_id, path)?,
            backlinks: self.backlinks_for_note_locked(notebook_id, path)?,
        }))
    }

    fn note_created_locked(&self, notebook_id: &str, path: &str) -> Result<Option<f64>> {
        let rows = self.run(
            queries::NOTE_CREATED,
            params([
                ("notebook_id", DataValue::from(notebook_id)),
                ("path", DataValue::from(path)),
            ]),
            ScriptMutability::Immutable,
        )?;
        Ok(rows.rows.first().map(|row| col_f64(row, 0)))
    }

    fn links_for_note_locked(&self, notebook_id: &str, path: &str) -> Result<Vec<LinkRef>> {
        let rows = self.run(
            queries::NOTE_LINKS,
            params([
                ("notebook_id", DataValue::from(notebook_id)),
                ("path", DataValue::from(path)),
            ]),
            ScriptMutability::Immutable,
        )?;
        if rows.rows.is_empty() {
            return Ok(Vec::new());
        }

        let title_rows = self.run(
            queries::NOTEBOOK_TITLES,
            params([("notebook_id", DataValue::from(notebook_id))]),
            ScriptMutability::Immutable,
        )?;
        let mut by_key: HashMap<String, (String, String)> = HashMap::new();
        for row in &title_rows.rows {
            let note_path = col_str(row, 0);
            let note_title = col_str(row, 1);
            for key in note_link_keys(&note_title, &note_path) {
                by_key
                    .entry(key)
                    .or_insert_with(|| (note_path.clone(), note_title.clone()));
            }
        }

        Ok(rows
            .rows
            .iter()
            .map(|row| {
                let target = col_str(row, 0);
                let label = col_str(row, 1);
                let resolved = by_key.get(&target);
                LinkRef {
                    note_id: resolved.map(|(note_path, _)| note_path.clone()),
                    title: resolved.map(|(_, title)| title.clone()),
                    target,
                    label,
                }
            })
            .collect())
    }

    fn backlinks_for_note_locked(&self, notebook_id: &str, path: &str) -> Result<Vec<BacklinkRef>> {
        let title = files::title_from_path(Path::new(path));
        let targets = note_link_keys(&title, path);
        if targets.is_empty() {
            return Ok(Vec::new());
        }

        let rows = self.run(
            queries::NOTE_BACKLINKS,
            params([
                ("notebook_id", DataValue::from(notebook_id)),
                ("targets", dv_list(targets)),
            ]),
            ScriptMutability::Immutable,
        )?;

        let mut seen = HashSet::new();
        Ok(rows
            .rows
            .iter()
            .filter_map(|row| {
                let id = col_str(row, 0);
                if !seen.insert(id.clone()) {
                    return None;
                }
                Some(BacklinkRef {
                    id,
                    title: col_str(row, 1),
                    updated_at: fmt_ts(col_f64(row, 2)),
                })
            })
            .collect())
    }

    pub fn list_assets(
        &self,
        notebook_id: &str,
        options: AssetListOptions<'_>,
    ) -> Result<Option<AssetList>> {
        let AssetListOptions {
            limit,
            offset,
            query,
            kind,
            sort,
            direction,
        } = options;
        let notebook = self.notebook_dir(notebook_id)?;
        if !notebook.is_dir() {
            return Ok(None);
        }
        let needle = query.unwrap_or_default().trim().to_lowercase();
        let kind = kind.unwrap_or_default().trim().to_lowercase();
        let mut assets = files::list_asset_files(&notebook)?;

        if !needle.is_empty() {
            assets.retain(|asset| {
                asset.rel.to_lowercase().contains(&needle)
                    || asset.name.to_lowercase().contains(&needle)
            });
        }
        if !kind.is_empty() {
            assets.retain(|asset| asset.kind == kind);
        }

        match sort.unwrap_or_default() {
            "name" => assets.sort_by(|left, right| left.name.cmp(&right.name)),
            "size" => assets.sort_by_key(|left| left.size),
            _ => assets.sort_by(|left, right| {
                left.updated_at
                    .partial_cmp(&right.updated_at)
                    .unwrap_or(std::cmp::Ordering::Equal)
            }),
        }
        if direction.unwrap_or_default() != "asc" {
            assets.reverse();
        }

        let total = assets.len() as i64;
        let assets = assets
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(asset_entry)
            .collect();
        Ok(Some(AssetList {
            assets,
            total,
            limit,
            offset,
        }))
    }

    pub fn asset_info(&self, notebook_id: &str, path: &str) -> Result<Option<AssetInfo>> {
        let notebook = self.notebook_dir(notebook_id)?;
        if !notebook.is_dir() {
            return Ok(None);
        }
        let asset = match files::asset_file(&notebook, path) {
            Ok(asset) => asset,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };
        let needle = format!("assets/{}", asset.rel);
        let mut references = Vec::new();
        for page in files::list_page_files(&notebook)? {
            let raw = match files::read_text(&page.abs) {
                Ok(raw) => raw,
                Err(_) => continue,
            };
            let Some(index) = raw.find(&needle) else {
                continue;
            };
            let line_start = raw[..index].rfind('\n').map(|value| value + 1).unwrap_or(0);
            let line_end = raw[index..]
                .find('\n')
                .map(|value| index + value)
                .unwrap_or(raw.len());
            let excerpt = raw[line_start..line_end]
                .trim()
                .chars()
                .take(240)
                .collect::<String>();
            references.push(AssetReference {
                note_path: page.rel,
                title: files::title_from_path(&page.abs),
                excerpt,
            });
        }
        Ok(Some(AssetInfo {
            asset: asset_entry(asset),
            references,
        }))
    }

    pub fn read_asset(&self, notebook_id: &str, path: &str) -> Result<Option<(Vec<u8>, String)>> {
        let notebook = self.notebook_dir(notebook_id)?;
        if !notebook.is_dir() {
            return Ok(None);
        }
        let absolute = match files::resolve_asset_path(&notebook, path) {
            Ok(path) => path,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };
        let mime = files::asset_mime(&absolute);
        Ok(Some((fs::read(absolute)?, mime)))
    }

    pub fn rename_asset(&self, notebook_id: &str, path: &str, name: &str) -> Result<AssetRename> {
        let _guard = self.lock_fs();
        self.sync_all_locked(false)?;
        let notebook = self.notebook_dir(notebook_id)?;
        if !notebook.is_dir() {
            return Ok(AssetRename::NotFound);
        }
        let old = match files::resolve_asset_path(&notebook, path) {
            Ok(path) => path,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(AssetRename::NotFound);
            }
            Err(err) => return Err(err.into()),
        };
        let new_name = files::sanitize_name(name, "asset");
        let parent = Path::new(path).parent().unwrap_or(Path::new(""));
        let new_rel = if parent.as_os_str().is_empty() {
            new_name
        } else {
            format!("{}/{}", parent.to_string_lossy(), new_name)
        };
        if new_rel == path {
            return Ok(AssetRename::Renamed(asset_entry(files::asset_file(
                &notebook, path,
            )?)));
        }
        let target = notebook.join(files::ASSET_DIR).join(&new_rel);
        if target.exists() {
            return Ok(AssetRename::Conflict);
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&old, &target)?;

        let old_needle = format!("assets/{path}");
        let new_needle = format!("assets/{new_rel}");
        for page in files::list_page_files(&notebook)? {
            let raw = files::read_text(&page.abs)?;
            if !raw.contains(&old_needle) {
                continue;
            }
            files::write_atomic(&page.abs, &raw.replace(&old_needle, &new_needle))?;
        }
        self.sync_notebook_locked(notebook_id, false)?;
        Ok(AssetRename::Renamed(asset_entry(files::asset_file(
            &notebook, &new_rel,
        )?)))
    }

    pub fn import_notebook_zip(&self, requested_name: &str, bytes: &[u8]) -> Result<Notebook> {
        if bytes.len() as u64 > MAX_IMPORT_BYTES {
            bail!("zip file must be at most {MAX_IMPORT_BYTES} bytes");
        }
        let _guard = self.lock_fs();
        self.sync_all_locked(false)?;

        let base = files::sanitize_name(requested_name, "Imported Notebook");
        let mut name = base.clone();
        let mut suffix = 2;
        while self.notebooks_dir.join(&name).exists() {
            name = format!("{base} {suffix}");
            suffix += 1;
            if suffix > 10_000 {
                bail!("could not find an available notebook name");
            }
        }
        let notebook = self.notebooks_dir.join(&name);
        files::ensure_layout(&notebook)?;

        let extracted = (|| -> Result<()> {
            let mut archive =
                zip::ZipArchive::new(Cursor::new(bytes)).context("opening notebook zip")?;
            let mut imported = 0usize;
            let mut total = 0u64;
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index)?;
                if entry.is_dir() {
                    continue;
                }
                let raw = entry.name().replace('\\', "/");
                let Some(rel) = normalize_zip_path(&raw) else {
                    continue;
                };
                total = total.saturating_add(entry.size());
                if total > MAX_IMPORT_BYTES {
                    bail!("zip contents exceed {MAX_IMPORT_BYTES} bytes");
                }
                let target = notebook.join(&rel);
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut output = fs::File::create(&target)?;
                std::io::copy(&mut entry, &mut output)?;
                imported += 1;
            }
            if imported == 0 {
                bail!("zip contains no Logseq pages, journals or assets");
            }
            Ok(())
        })();

        if let Err(err) = extracted {
            let _ = fs::remove_dir_all(&notebook);
            return Err(err);
        }
        if let Err(err) = self.sync_notebook_locked(&name, true) {
            let _ = fs::remove_dir_all(&notebook);
            return Err(err);
        }

        let row = self
            .get_notebook_row_locked(&name)?
            .ok_or_else(|| anyhow!("notebook vanished after import"))?;
        let count = self.notebook_note_count_locked(&name)?;
        Ok(row.into_model(count))
    }

    pub fn create_note(
        &self,
        notebook_id: &str,
        title: &str,
        content: &str,
        explicit_tags: &[String],
    ) -> Result<Option<Note>> {
        self.create_note_in_section(
            notebook_id,
            NoteSection::Pages,
            title,
            content,
            explicit_tags,
        )
    }

    pub fn create_note_in_section(
        &self,
        notebook_id: &str,
        section: NoteSection,
        title: &str,
        content: &str,
        explicit_tags: &[String],
    ) -> Result<Option<Note>> {
        let _guard = self.lock_fs();
        self.sync_all_locked(false)?;

        let notebook = self.notebook_dir(notebook_id)?;
        if !notebook.is_dir() {
            return Ok(None);
        }
        files::canonicalize_layout(&notebook)?;
        let directory =
            files::section_dir_for_new_notes(&notebook, section == NoteSection::Journals)?;
        let absolute = files::unique_file_path(&directory, title, files::NOTE_EXT);
        let raw = render_page(content, explicit_tags, "");
        files::write_atomic(&absolute, &raw)?;

        self.sync_notebook_locked(notebook_id, false)?;

        let path = files::relative_path(&notebook, &absolute);
        self.get_note_locked(notebook_id, &path)
    }

    pub fn update_note(
        &self,
        notebook_id: &str,
        path: &str,
        title: &str,
        content: &str,
        explicit_tags: &[String],
    ) -> Result<NoteUpdate> {
        let _guard = self.lock_fs();
        self.sync_all_locked(false)?;

        let notebook = self.notebook_dir(notebook_id)?;
        if !notebook.is_dir() {
            return Ok(NoteUpdate::NotFound);
        }
        let absolute = match files::resolve_note_path(&notebook, path) {
            Ok(path) => path,
            Err(_) => return Ok(NoteUpdate::NotFound),
        };
        let raw = match files::read_text(&absolute) {
            Ok(raw) => raw,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(NoteUpdate::NotFound);
            }
            Err(err) => {
                return Err(err).with_context(|| format!("reading {}", absolute.display()));
            }
        };

        let current_title = files::title_from_path(&absolute);
        let new_title = files::sanitize_name(title, "Untitled");
        let rendered = render_page(content, explicit_tags, &raw);

        let (target, new_path) = if new_title != current_title {
            let parent = absolute
                .parent()
                .ok_or_else(|| anyhow!("note path has no parent"))?;
            let target = files::unique_file_path(parent, &new_title, files::NOTE_EXT);
            let relative = files::relative_path(&notebook, &target);
            (target, relative)
        } else {
            (absolute.clone(), path.to_string())
        };

        files::write_atomic(&target, &rendered)?;
        if target != absolute {
            fs::remove_file(&absolute)
                .with_context(|| format!("removing old note {}", absolute.display()))?;
        }

        self.sync_notebook_locked(notebook_id, false)?;

        match self.get_note_locked(notebook_id, &new_path)? {
            Some(note) => Ok(NoteUpdate::Updated(Box::new(note))),
            None => Ok(NoteUpdate::NotFound),
        }
    }

    pub fn delete_note(&self, notebook_id: &str, path: &str) -> Result<bool> {
        let _guard = self.lock_fs();
        self.sync_all_locked(false)?;

        let notebook = self.notebook_dir(notebook_id)?;
        if !notebook.is_dir() {
            return Ok(false);
        }
        let absolute = match files::resolve_note_path(&notebook, path) {
            Ok(path) => path,
            Err(_) => return Ok(false),
        };

        files::trash_file(&self.data_dir, notebook_id, path, &absolute)?;
        self.sync_notebook_locked(notebook_id, false)?;
        Ok(true)
    }

    /// Journal pages ordered by path descending (newest date first).
    ///
    /// `before` is the exclusive relative path cursor; `None` starts at the
    /// newest page.
    pub fn list_journals(
        &self,
        notebook_id: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Vec<JournalPage>> {
        self.ensure_synced()?;
        let before = before.unwrap_or("journals~");
        let rows = self.run(
            queries::LIST_JOURNALS,
            params([
                ("notebook_id", DataValue::from(notebook_id)),
                ("prefix", DataValue::from("journals/")),
                ("before", DataValue::from(before)),
                ("limit", DataValue::from(limit.max(1) as i64)),
            ]),
            ScriptMutability::Immutable,
        )?;
        let paths: Vec<String> = rows.rows.iter().map(|row| col_str(row, 0)).collect();
        let tags = self.tags_for_paths_locked(notebook_id, &paths)?;

        Ok(rows
            .rows
            .iter()
            .map(|row| {
                let path = col_str(row, 0);
                JournalPage {
                    tags: tags.get(&path).cloned().unwrap_or_default(),
                    id: path,
                    notebook_id: notebook_id.to_string(),
                    title: col_str(row, 1),
                    content: col_str(row, 2),
                    created_at: fmt_ts(col_f64(row, 3)),
                    updated_at: fmt_ts(col_f64(row, 4)),
                }
            })
            .collect())
    }

    pub fn list_tags(&self, notebook_id: &str) -> Result<Vec<TagCount>> {
        self.ensure_synced()?;
        let rows = self.run(
            queries::LIST_TAGS,
            params([("notebook_id", DataValue::from(notebook_id))]),
            ScriptMutability::Immutable,
        )?;
        let mut tags: Vec<TagCount> = rows
            .rows
            .iter()
            .map(|row| TagCount {
                tag: col_str(row, 0),
                count: col_i64(row, 1),
            })
            .collect();
        tags.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
        Ok(tags)
    }

    pub fn stats(&self) -> Result<Stats> {
        self.ensure_synced()?;
        self.stats_inner()
    }

    fn stats_inner(&self) -> Result<Stats> {
        let count = |script: &str| -> Result<i64> {
            let rows = self.run(script, BTreeMap::new(), ScriptMutability::Immutable)?;
            Ok(rows.rows.first().map(|row| col_i64(row, 0)).unwrap_or(0))
        };
        Ok(Stats {
            notebooks: count(queries::COUNT_NOTEBOOKS)?,
            notes: count(queries::COUNT_NOTES)?,
            tags: count(queries::COUNT_TAGS)?,
            links: count(queries::COUNT_LINKS)?,
        })
    }

    /// Force a full re-read of every page on disk.
    pub fn reindex(&self) -> Result<Stats> {
        let _guard = self.lock_fs();
        self.sync_all_locked(true)?;
        self.stats_inner()
    }

    /// Ad-hoc read-only Datalog. Callers are responsible for rejecting `::` ops.
    pub fn run_query(
        &self,
        script: &str,
        params: BTreeMap<String, DataValue>,
        timeout_secs: Option<f64>,
    ) -> Result<NamedRows> {
        self.ensure_synced()?;
        let options = ScriptRunOptions {
            timeout: Some(timeout_secs.unwrap_or(self.default_query_timeout_secs)),
            mem_limit: Some(QUERY_MEM_LIMIT_BYTES),
        };
        self.db
            .run_script_with_options(script, params, ScriptMutability::Immutable, options)
            .map_err(|err| anyhow!(err.to_string()))
    }

    pub fn ping(&self) -> Result<()> {
        self.run_raw(queries::PING, BTreeMap::new(), ScriptMutability::Immutable)?;
        Ok(())
    }

    fn notebook_dir(&self, id: &str) -> Result<PathBuf> {
        if id.is_empty()
            || id == "."
            || id == ".."
            || id.contains('/')
            || id.contains('\\')
            || id.contains('\0')
        {
            bail!("invalid notebook id");
        }
        Ok(self.notebooks_dir.join(id))
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn notebook_row_from(row: &[DataValue]) -> NotebookRow {
    NotebookRow {
        id: col_str(row, 0),
        name: col_str(row, 1),
        description: col_str(row, 2),
        created_at: col_f64(row, 3),
        updated_at: col_f64(row, 4),
    }
}

fn note_row(notebook_id: &str, page: &PageRecord) -> DataValue {
    DataValue::List(vec![
        DataValue::from(notebook_id),
        DataValue::from(page.path.as_str()),
        DataValue::from(page.title.as_str()),
        DataValue::from(page.body.as_str()),
        DataValue::from(page.summary.as_str()),
        DataValue::from(page.mtime_ns),
        DataValue::from(page.size),
        DataValue::from(page.created_at),
        DataValue::from(page.updated_at),
    ])
}

fn dv_list(values: Vec<String>) -> DataValue {
    DataValue::List(values.into_iter().map(DataValue::from).collect())
}

fn params(
    items: impl IntoIterator<Item = (&'static str, DataValue)>,
) -> BTreeMap<String, DataValue> {
    items
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect()
}

fn col_str(row: &[DataValue], index: usize) -> String {
    row.get(index)
        .and_then(DataValue::get_str)
        .unwrap_or_default()
        .to_string()
}

fn col_f64(row: &[DataValue], index: usize) -> f64 {
    row.get(index).and_then(DataValue::get_float).unwrap_or(0.0)
}

fn col_i64(row: &[DataValue], index: usize) -> i64 {
    row.get(index).and_then(DataValue::get_int).unwrap_or(0)
}

fn normalize_zip_path(raw: &str) -> Option<String> {
    let parts = raw
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>();
    if parts.is_empty() || parts.contains(&"..") {
        return None;
    }
    let known = |part: &str| -> Option<&'static str> {
        match part.to_ascii_lowercase().as_str() {
            "pages" => Some(files::PAGE_DIR),
            "journals" | "journal" => Some(files::JOURNAL_DIR),
            "assets" => Some(files::ASSET_DIR),
            "draws" => Some("draws"),
            _ => None,
        }
    };
    let (dir, rest) = if let Some(dir) = known(parts[0]) {
        (dir, &parts[1..])
    } else if parts.len() > 1 {
        let dir = known(parts[1])?;
        (dir, &parts[2..])
    } else {
        return None;
    };
    if rest.is_empty() {
        return None;
    }
    Some(format!("{dir}/{}", rest.join("/")))
}

fn asset_entry(asset: files::AssetFile) -> AssetEntry {
    AssetEntry {
        path: asset.rel,
        name: asset.name,
        kind: asset.kind.to_string(),
        mime: asset.mime,
        size: asset.size,
        updated_at: fmt_ts(asset.updated_at),
    }
}

fn fmt_ts(ts: f64) -> String {
    DateTime::<Utc>::from_timestamp_millis((ts * 1000.0).round() as i64)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = Store::open(dir.path(), 5.0).expect("open store");
        (dir, store)
    }

    fn notebook_path(root: &Path, id: &str) -> PathBuf {
        root.join("notebooks").join(id)
    }

    #[test]
    fn creates_folders_and_markdown_files() {
        let (dir, store) = store();
        let notebook = store
            .create_notebook("My Notes", "a notebook")
            .unwrap()
            .unwrap();
        assert_eq!(notebook.id, "My Notes");

        let root = notebook_path(dir.path(), "My Notes");
        assert!(root.join("pages").is_dir());
        assert!(root.join("journals").is_dir());
        assert!(root.join("assets").is_dir());

        let note = store
            .create_note(&notebook.id, "hello", "Hello #rust", &["explicit".into()])
            .unwrap()
            .unwrap();
        assert_eq!(note.id, "pages/hello.md");
        assert_eq!(note.explicit_tags, vec!["explicit"]);
        assert_eq!(note.tags, vec!["explicit", "rust"]);

        let raw = fs::read_to_string(root.join("pages/hello.md")).unwrap();
        assert_eq!(raw, "---\ntags:\n- explicit\n---\nHello #rust");
    }

    #[test]
    fn renames_move_the_file() {
        let (dir, store) = store();
        let notebook = store.create_notebook("Rename", "").unwrap().unwrap();
        let note = store
            .create_note(&notebook.id, "before", "body", &[])
            .unwrap()
            .unwrap();

        let updated = match store
            .update_note(&notebook.id, &note.id, "after", "body2", &[])
            .unwrap()
        {
            NoteUpdate::Updated(note) => *note,
            NoteUpdate::NotFound => panic!("note not found"),
        };
        assert_eq!(updated.id, "pages/after.md");
        let root = notebook_path(dir.path(), "Rename");
        assert!(!root.join("pages/before.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("pages/after.md")).unwrap(),
            "body2"
        );
    }

    #[test]
    fn external_files_are_indexed_and_removed() {
        let (dir, store) = store();
        let notebook = store.create_notebook("External", "").unwrap().unwrap();
        let root = notebook_path(dir.path(), "External");

        fs::write(
            root.join("pages/outside.md"),
            "---\ntags:\n- import\ndate: \"2023-05-26\"\n---\nOutside #inline [[Local]]\n",
        )
        .unwrap();
        fs::write(root.join("pages/Local.md"), "target\n").unwrap();

        // No explicit reindex: reads reconcile with the filesystem by themselves.
        let notes = store.list_notes(&notebook.id, 50, 0).unwrap();
        assert_eq!(notes.len(), 2);
        let outside = store
            .get_note(&notebook.id, "pages/outside.md")
            .unwrap()
            .unwrap();
        assert_eq!(outside.title, "outside");
        assert_eq!(outside.explicit_tags, vec!["import"]);
        assert_eq!(outside.tags, vec!["import", "inline"]);
        assert_eq!(outside.links.len(), 1);
        assert_eq!(outside.links[0].note_id.as_deref(), Some("pages/Local.md"));

        // Search sees the synced content.
        let hits = store.search_notes(&notebook.id, "outside", 10).unwrap();
        assert_eq!(hits.len(), 1);

        // External edits are picked up without restarting or forcing a reindex.
        std::thread::sleep(std::time::Duration::from_millis(5));
        fs::write(
            root.join("pages/Local.md"),
            "target changed #externaledit\n",
        )
        .unwrap();
        assert_eq!(
            store
                .search_notes(&notebook.id, "externaledit", 10)
                .unwrap()
                .len(),
            1
        );

        fs::remove_file(root.join("pages/outside.md")).unwrap();
        assert!(store
            .get_note(&notebook.id, "pages/outside.md")
            .unwrap()
            .is_none());
        assert_eq!(store.list_notes(&notebook.id, 50, 0).unwrap().len(), 1);
    }

    #[test]
    fn migrates_capitalized_logseq_folders() {
        let (dir, store) = store();
        let root = notebook_path(dir.path(), "Imported");
        fs::create_dir_all(root.join("Pages")).unwrap();
        fs::create_dir_all(root.join("Journal")).unwrap();
        fs::write(root.join("Pages/Page.md"), "page").unwrap();
        fs::write(root.join("Journal/2023-03-29.md"), "journal").unwrap();

        store.reindex().unwrap();
        assert!(root.join("pages/Page.md").is_file());
        assert!(root.join("journals/2023-03-29.md").is_file());
        assert!(!root.join("Pages").exists());
        assert!(!root.join("Journal").exists());

        let notebook = store.get_notebook("Imported").unwrap().unwrap();
        assert_eq!(notebook.note_count, 2);
        let note = store
            .get_note("Imported", "journals/2023-03-29.md")
            .unwrap()
            .unwrap();
        assert_eq!(note.title, "2023-03-29");
    }

    #[test]
    fn links_resolve_by_title_and_journal_path() {
        let (dir, store) = store();
        let root = notebook_path(dir.path(), "Links");
        fs::create_dir_all(root.join("pages")).unwrap();
        fs::create_dir_all(root.join("journals")).unwrap();
        fs::write(
            root.join("pages/index.md"),
            "[[Journal/2023-03-29]] and [[Daily]] and [[Missing]]",
        )
        .unwrap();
        fs::write(root.join("journals/2023-03-29.md"), "journal").unwrap();
        fs::write(root.join("pages/Daily.md"), "daily").unwrap();
        store.reindex().unwrap();

        let note = store.get_note("Links", "pages/index.md").unwrap().unwrap();
        assert_eq!(note.links.len(), 3);
        let by_target: HashMap<_, _> = note
            .links
            .iter()
            .map(|link| (link.target.as_str(), link.note_id.clone()))
            .collect();
        assert_eq!(
            by_target.get("journals/2023-03-29"),
            Some(&Some("journals/2023-03-29.md".to_string()))
        );
        assert_eq!(
            by_target.get("daily"),
            Some(&Some("pages/Daily.md".to_string()))
        );
        assert_eq!(by_target.get("missing"), Some(&None));

        let journal = store
            .get_note("Links", "journals/2023-03-29.md")
            .unwrap()
            .unwrap();
        assert_eq!(journal.backlinks.len(), 1);
        assert_eq!(journal.backlinks[0].id, "pages/index.md");
    }

    #[test]
    fn search_tracks_updates_and_deletes() {
        let (dir, store) = store();
        let notebook = store.create_notebook("Search", "").unwrap().unwrap();
        let note = store
            .create_note(&notebook.id, "Alpha", "hello world", &[])
            .unwrap()
            .unwrap();
        assert_eq!(
            store.search_notes(&notebook.id, "hello", 10).unwrap().len(),
            1
        );
        // Punctuation must be treated as a token separator, not FTS syntax.
        assert_eq!(
            store
                .search_notes(&notebook.id, "hello-world", 10)
                .unwrap()
                .len(),
            1
        );
        assert!(store
            .search_notes(&notebook.id, "zzzz-no-hit", 10)
            .unwrap()
            .is_empty());

        let deep_body = format!("{} needle {}", "prefix ".repeat(40), "suffix ".repeat(40));
        store
            .create_note(&notebook.id, "Deep", &deep_body, &[])
            .unwrap();
        let deep_hits = store.search_notes(&notebook.id, "needle", 10).unwrap();
        assert_eq!(deep_hits.len(), 1);
        assert!(deep_hits[0].excerpt.contains("needle"));

        let updated = match store
            .update_note(&notebook.id, &note.id, "Alpha", "only replaced", &[])
            .unwrap()
        {
            NoteUpdate::Updated(note) => *note,
            NoteUpdate::NotFound => panic!("missing"),
        };
        assert_eq!(updated.title, "Alpha");
        assert!(store
            .search_notes(&notebook.id, "hello", 10)
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .search_notes(&notebook.id, "replaced", 10)
                .unwrap()
                .len(),
            1
        );

        store.delete_note(&notebook.id, &note.id).unwrap();
        assert!(store
            .search_notes(&notebook.id, "replaced", 10)
            .unwrap()
            .is_empty());
        assert!(!notebook_path(dir.path(), "Search")
            .join("pages/Alpha.md")
            .exists());
        assert!(dir.path().join(".trash").is_dir());
    }

    #[test]
    fn page_overviews_include_tags_and_backlink_counts() {
        let (_dir, store) = store();
        let notebook = store.create_notebook("Overview", "").unwrap().unwrap();
        store
            .create_note(
                &notebook.id,
                "Target",
                "target body",
                &["explicit".to_string()],
            )
            .unwrap();
        store
            .create_note(&notebook.id, "Empty Linked", "", &[])
            .unwrap();
        store
            .create_note(
                &notebook.id,
                "Source",
                "[[Target]] [[Empty Linked]] and [[journals/2023-03-29]] #inline",
                &[],
            )
            .unwrap();

        store.create_note(&notebook.id, "Empty", "", &[]).unwrap();

        let page_list = store
            .list_page_overviews(
                &notebook.id,
                PageListOptions {
                    limit: 50,
                    offset: 0,
                    query: None,
                    tag: None,
                    sort: None,
                    direction: None,
                },
            )
            .unwrap();
        assert_eq!(page_list.total, 4);
        let pages = page_list.pages;
        let target = pages
            .iter()
            .find(|page| page.id == "pages/Target.md")
            .expect("target page");
        assert_eq!(target.backlink_count, 1);
        assert!(target.tags.contains(&"explicit".to_string()));

        let source = pages
            .iter()
            .find(|page| page.id == "pages/Source.md")
            .expect("source page");
        assert_eq!(source.backlink_count, 0);
        assert!(!source.is_orphan);
        assert!(source.tags.contains(&"inline".to_string()));

        let empty_linked = pages
            .iter()
            .find(|page| page.id == "pages/Empty Linked.md")
            .expect("empty linked page");
        assert_eq!(empty_linked.backlink_count, 1);
        assert!(!empty_linked.is_orphan);

        let empty = pages
            .iter()
            .find(|page| page.id == "pages/Empty.md")
            .expect("empty page");
        assert!(empty.is_orphan);
        let orphans = store.list_orphan_pages(&notebook.id).unwrap();
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].id, "pages/Empty.md");

        let first = store
            .list_page_overviews(
                &notebook.id,
                PageListOptions {
                    limit: 2,
                    offset: 0,
                    query: None,
                    tag: None,
                    sort: Some("title"),
                    direction: Some("asc"),
                },
            )
            .unwrap();
        assert_eq!(first.pages.len(), 2);
        assert_eq!(first.total, 4);
        let second = store
            .list_page_overviews(
                &notebook.id,
                PageListOptions {
                    limit: 2,
                    offset: 2,
                    query: None,
                    tag: None,
                    sort: Some("title"),
                    direction: Some("asc"),
                },
            )
            .unwrap();
        assert_eq!(second.pages.len(), 2);
        assert_eq!(second.offset, 2);

        let tagged = store
            .list_page_overviews(
                &notebook.id,
                PageListOptions {
                    limit: 50,
                    offset: 0,
                    query: None,
                    tag: Some("inline"),
                    sort: None,
                    direction: None,
                },
            )
            .unwrap();
        assert_eq!(tagged.total, 1);
        assert_eq!(tagged.pages[0].id, "pages/Source.md");
    }

    #[test]
    fn graph_contains_resolved_links_only() {
        let (_dir, store) = store();
        let notebook = store.create_notebook("Graph", "").unwrap().unwrap();
        store.create_note(&notebook.id, "One", "body", &[]).unwrap();
        store
            .create_note(&notebook.id, "Two", "[[One]] and [[Missing]]", &[])
            .unwrap();

        let graph = store.graph(&notebook.id).unwrap();
        assert_eq!(graph.nodes.len(), 2);
        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.edges[0].source, "pages/Two.md");
        assert_eq!(graph.edges[0].target, "pages/One.md");
    }

    #[test]
    fn deletes_notebook_to_trash() {
        let (dir, store) = store();
        let notebook = store.create_notebook("Gone", "").unwrap().unwrap();
        store.create_note(&notebook.id, "n", "body", &[]).unwrap();
        assert!(store.delete_notebook(&notebook.id).unwrap());
        assert!(!notebook_path(dir.path(), "Gone").exists());
        assert!(dir.path().join(".trash/notebooks").is_dir());
        assert_eq!(store.stats().unwrap().notes, 0);
    }

    #[test]
    fn same_relative_path_in_two_notebooks() {
        let (_dir, store) = store();
        let one = store.create_notebook("One", "").unwrap().unwrap();
        let two = store.create_notebook("Two", "").unwrap().unwrap();
        let a = store
            .create_note(&one.id, "Page", "from one", &[])
            .unwrap()
            .unwrap();
        let b = store
            .create_note(&two.id, "Page", "from two", &[])
            .unwrap()
            .unwrap();
        assert_eq!(a.id, "pages/Page.md");
        assert_eq!(b.id, "pages/Page.md");
        assert_eq!(
            store.get_note(&one.id, &a.id).unwrap().unwrap().content,
            "from one"
        );
        assert_eq!(
            store.get_note(&two.id, &b.id).unwrap().unwrap().content,
            "from two"
        );
        assert_eq!(store.list_notes(&one.id, 10, 0).unwrap().len(), 1);
        assert_eq!(store.stats().unwrap().notes, 2);
    }

    #[test]
    fn journals_are_created_in_the_journals_directory() {
        let (_dir, store) = store();
        let notebook = store.create_notebook("Journal", "").unwrap().unwrap();
        let note = store
            .create_note_in_section(
                &notebook.id,
                NoteSection::Journals,
                "2026-11-12",
                "daily",
                &[],
            )
            .unwrap()
            .unwrap();
        assert_eq!(note.id, "journals/2026-11-12.md");
        assert_eq!(
            store
                .get_note(&notebook.id, &note.id)
                .unwrap()
                .unwrap()
                .content,
            "daily"
        );
    }

    #[test]
    fn journal_feed_is_newest_first_and_paginates() {
        let (_dir, store) = store();
        let notebook = store.create_notebook("Feed", "").unwrap().unwrap();
        for date in ["2026-11-10", "2026-11-12", "2026-11-11"] {
            store
                .create_note_in_section(&notebook.id, NoteSection::Journals, date, "entry", &[])
                .unwrap();
        }
        store
            .create_note(&notebook.id, "Not a journal", "page", &[])
            .unwrap();

        let first = store.list_journals(&notebook.id, None, 2).unwrap();
        assert_eq!(
            first
                .iter()
                .map(|page| page.title.as_str())
                .collect::<Vec<_>>(),
            vec!["2026-11-12", "2026-11-11"]
        );
        let second = store
            .list_journals(&notebook.id, Some(&first[1].id), 2)
            .unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].title, "2026-11-10");
    }

    #[test]
    fn duplicate_titles_get_a_suffix() {
        let (_dir, store) = store();
        let notebook = store.create_notebook("Dup", "").unwrap().unwrap();
        let first = store
            .create_note(&notebook.id, "Same", "1", &[])
            .unwrap()
            .unwrap();
        let second = store
            .create_note(&notebook.id, "Same", "2", &[])
            .unwrap()
            .unwrap();
        assert_eq!(first.id, "pages/Same.md");
        assert_eq!(second.id, "pages/Same 2.md");
    }

    #[test]
    fn ad_hoc_query_is_read_only() {
        let (_dir, store) = store();
        let notebook = store.create_notebook("Q", "").unwrap().unwrap();
        store.create_note(&notebook.id, "N", "body", &[]).unwrap();

        let rows = store
            .run_query(
                "?[path, title] := *note{notebook_id, path, title}, notebook_id = $nb",
                BTreeMap::from([("nb".to_string(), DataValue::from(notebook.id.as_str()))]),
                Some(2.0),
            )
            .unwrap();
        assert_eq!(rows.rows.len(), 1);

        let write = store.run_query(
            "?[notebook_id, path, title, content, summary, mtime_ns, size, created_at, updated_at] <- [['x', 'pages/x.md', 'X', '', '', 0, 0, 0.0, 0.0]] :put note {notebook_id, path => title, content, summary, mtime_ns, size, created_at, updated_at}",
            BTreeMap::new(),
            Some(2.0),
        );
        assert!(write.is_err());
    }

    #[test]
    fn notebook_rename_moves_folder() {
        let (dir, store) = store();
        let notebook = store.create_notebook("Old Name", "").unwrap().unwrap();
        store.create_note(&notebook.id, "n", "body", &[]).unwrap();

        let updated = match store
            .update_notebook(&notebook.id, "New Name", "desc")
            .unwrap()
        {
            NotebookUpdate::Updated(notebook) => notebook,
            _ => panic!("rename failed"),
        };
        assert_eq!(updated.id, "New Name");
        assert_eq!(updated.note_count, 1);
        assert!(notebook_path(dir.path(), "New Name").is_dir());
        assert!(!notebook_path(dir.path(), "Old Name").exists());
        assert!(store.get_notebook("Old Name").unwrap().is_none());

        // A second notebook with the target name conflicts.
        store.create_notebook("Taken", "").unwrap().unwrap();
        assert!(matches!(
            store.update_notebook("New Name", "Taken", "").unwrap(),
            NotebookUpdate::Conflict
        ));
    }

    #[test]
    fn notebook_metadata_and_birth_times_are_stable() {
        let (dir, store) = store();
        let notebook = store.create_notebook("Meta", "first").unwrap().unwrap();
        let note = store
            .create_note(&notebook.id, "n", "body", &[])
            .unwrap()
            .unwrap();
        let before = store.get_note(&notebook.id, &note.id).unwrap().unwrap();
        let after = store.get_note(&notebook.id, &note.id).unwrap().unwrap();
        assert_eq!(before.created_at, after.created_at);
        assert_eq!(
            store
                .get_notebook(&notebook.id)
                .unwrap()
                .unwrap()
                .description,
            "first"
        );
        assert!(notebook_path(dir.path(), "Meta")
            .join(".opalnote.json")
            .is_file());
    }
}
