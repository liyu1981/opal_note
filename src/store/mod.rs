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
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use cozo::{DataValue, DbInstance, NamedRows, ScriptMutability, ScriptRunOptions};

use self::markdown::{
    extract_wikilinks, merge_tags, note_link_keys, parse_page, render_page, summarize,
};
use self::model::{BacklinkRef, LinkRef, Note, NoteSummary, Notebook, Stats, TagCount};

const QUERY_MEM_LIMIT_BYTES: usize = 64 * 1024 * 1024;
const SUMMARY_CHARS: usize = 220;

/// Result of renaming/updating a notebook.
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
    mtime_ns: i64,
    size: i64,
    created_at: f64,
    updated_at: f64,
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
        store.init_schema()?;

        // Build/refresh the index from whatever is already on disk.
        store.sync_all_locked(false)?;
        Ok(store)
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    fn init_schema(&self) -> Result<()> {
        let existing = self.run_raw("::relations", BTreeMap::new(), ScriptMutability::Immutable)?;
        let names: HashSet<String> = existing
            .rows
            .iter()
            .filter_map(|row| row.first().and_then(DataValue::get_str).map(str::to_string))
            .collect();

        for (name, ddl) in queries::RELATIONS {
            if !names.contains(*name) {
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
        Ok(())
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
            statements.push((queries::DELETE_LINK_ROWS, par));

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

    pub fn search_notes(
        &self,
        notebook_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<NoteSummary>> {
        self.ensure_synced()?;
        let rows = self.run(
            queries::SEARCH_NOTES,
            params([
                ("notebook_id", DataValue::from(notebook_id)),
                ("query", DataValue::from(query)),
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
                    excerpt: col_str(row, 2),
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

    pub fn create_note(
        &self,
        notebook_id: &str,
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
        let pages = files::page_dir_for_new_notes(&notebook)?;
        let absolute = files::unique_file_path(&pages, title, files::NOTE_EXT);
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
