//! Metadata + content store backed by a single MnesticDB (RocksDB) instance.

pub mod markdown;
pub mod model;
mod queries;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use cozo::{DataValue, DbInstance, NamedRows, ScriptMutability, ScriptRunOptions};

use self::markdown::{extract_wikilinks, merge_tags, normalize_title, summarize};
use self::model::{BacklinkRef, LinkRef, Note, NoteSummary, Notebook, Stats, TagCount};

const QUERY_MEM_LIMIT_BYTES: usize = 64 * 1024 * 1024;
const SUMMARY_CHARS: usize = 220;

pub struct Store {
    db: DbInstance,
    data_dir: PathBuf,
    default_query_timeout_secs: f64,
}

impl Store {
    pub fn open(
        data_dir: &Path,
        memory_mb: usize,
        default_query_timeout_secs: f64,
    ) -> Result<Self> {
        std::fs::create_dir_all(data_dir)
            .with_context(|| format!("creating data dir {}", data_dir.display()))?;

        let path = data_dir.join("db");
        let options = if memory_mb > 0 {
            format!(
                r#"{{"shared_memory":{{"total_bytes":{}}}}}"#,
                memory_mb.saturating_mul(1024 * 1024)
            )
        } else {
            "{}".to_string()
        };

        let db = DbInstance::new("rocksdb", &path, &options)
            .map_err(|e| anyhow!("opening MnesticDB at {}: {e}", path.display()))?;

        let store = Self {
            db,
            data_dir: data_dir.to_path_buf(),
            default_query_timeout_secs,
        };
        store.init_schema()?;
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
            .map_err(|e| anyhow!(e.to_string()))
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
    ///
    /// MnesticDB's plain `run_script` accepts only one Datalog query per
    /// payload, so related writes (note + tags + links) need an explicit
    /// multi-transaction to stay all-or-nothing.
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

    pub fn ping(&self) -> Result<()> {
        self.run_raw(queries::PING, BTreeMap::new(), ScriptMutability::Immutable)?;
        Ok(())
    }

    /// Ad-hoc read-only Datalog. Callers are responsible for rejecting `::` ops.
    pub fn run_query(
        &self,
        script: &str,
        params: BTreeMap<String, DataValue>,
        timeout_secs: Option<f64>,
    ) -> Result<NamedRows> {
        let options = ScriptRunOptions {
            timeout: Some(timeout_secs.unwrap_or(self.default_query_timeout_secs)),
            mem_limit: Some(QUERY_MEM_LIMIT_BYTES),
        };
        self.db
            .run_script_with_options(script, params, ScriptMutability::Immutable, options)
            .map_err(|e| anyhow!(e.to_string()))
    }

    // -----------------------------------------------------------------------
    // Notebooks
    // -----------------------------------------------------------------------

    pub fn list_notebooks(&self) -> Result<Vec<Notebook>> {
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
                let id = col_str(row, 0);
                Notebook {
                    note_count: counts.get(&id).copied().unwrap_or(0),
                    id,
                    name: col_str(row, 1),
                    description: col_str(row, 2),
                    created_at: fmt_ts(col_f64(row, 3)),
                    updated_at: fmt_ts(col_f64(row, 4)),
                }
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
        let rows = self.run(
            queries::GET_NOTEBOOK,
            params([("id", DataValue::from(id))]),
            ScriptMutability::Immutable,
        )?;
        let Some(row) = rows.rows.first() else {
            return Ok(None);
        };
        let count = self
            .run(
                queries::NOTEBOOK_NOTE_COUNT,
                params([("id", DataValue::from(id))]),
                ScriptMutability::Immutable,
            )?
            .rows
            .first()
            .map(|row| col_i64(row, 0))
            .unwrap_or(0);

        Ok(Some(Notebook {
            id: col_str(row, 0),
            name: col_str(row, 1),
            description: col_str(row, 2),
            created_at: fmt_ts(col_f64(row, 3)),
            updated_at: fmt_ts(col_f64(row, 4)),
            note_count: count,
        }))
    }

    pub fn notebook_exists(&self, id: &str) -> Result<bool> {
        let rows = self.run(
            queries::NOTEBOOK_EXISTS,
            params([("id", DataValue::from(id))]),
            ScriptMutability::Immutable,
        )?;
        Ok(!rows.rows.is_empty())
    }

    pub fn create_notebook(&self, name: &str, description: &str) -> Result<Notebook> {
        let id = unique_notebook_id(name);
        let now = now_ts();
        self.run(
            queries::CREATE_NOTEBOOK,
            params([
                ("id", DataValue::from(id.as_str())),
                ("name", DataValue::from(name)),
                ("description", DataValue::from(description)),
                ("now", DataValue::from(now)),
            ]),
            ScriptMutability::Mutable,
        )?;

        Ok(Notebook {
            id,
            name: name.to_string(),
            description: description.to_string(),
            created_at: fmt_ts(now),
            updated_at: fmt_ts(now),
            note_count: 0,
        })
    }

    pub fn update_notebook(
        &self,
        id: &str,
        name: &str,
        description: &str,
    ) -> Result<Option<Notebook>> {
        if !self.notebook_exists(id)? {
            return Ok(None);
        }
        self.run(
            queries::UPDATE_NOTEBOOK,
            params([
                ("id", DataValue::from(id)),
                ("name", DataValue::from(name)),
                ("description", DataValue::from(description)),
                ("now", DataValue::from(now_ts())),
            ]),
            ScriptMutability::Mutable,
        )?;
        self.get_notebook(id)
    }

    /// Cascade-delete a notebook and everything inside it.
    pub fn delete_notebook(&self, id: &str) -> Result<bool> {
        if !self.notebook_exists(id)? {
            return Ok(false);
        }
        let par = params([("id", DataValue::from(id))]);
        self.run_atomic(vec![
            (queries::DELETE_NOTEBOOK_TAGS, par.clone()),
            (queries::DELETE_NOTEBOOK_LINKS, par.clone()),
            (queries::DELETE_NOTEBOOK_NOTES, par.clone()),
            (queries::DELETE_NOTEBOOK, par),
        ])?;
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
        let tags = self.tags_for(
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
                let id = col_str(row, 0);
                NoteSummary {
                    tags: tags.get(&id).cloned().unwrap_or_default(),
                    id,
                    notebook_id: col_str(row, 1),
                    title: col_str(row, 2),
                    excerpt: col_str(row, 3),
                    created_at: fmt_ts(col_f64(row, 4)),
                    updated_at: fmt_ts(col_f64(row, 5)),
                    score: Some(col_f64(row, 6)),
                }
            })
            .collect())
    }

    fn list_rows_to_summaries(
        &self,
        rows: &NamedRows,
        notebook_id: &str,
    ) -> Result<Vec<NoteSummary>> {
        let ids: Vec<String> = rows.rows.iter().map(|row| col_str(row, 0)).collect();
        let tags = self.tags_for(&ids)?;

        Ok(rows
            .rows
            .iter()
            .map(|row| {
                let id = col_str(row, 0);
                NoteSummary {
                    tags: tags.get(&id).cloned().unwrap_or_default(),
                    excerpt: col_str(row, 2),
                    id,
                    notebook_id: notebook_id.to_string(),
                    title: col_str(row, 1),
                    created_at: fmt_ts(col_f64(row, 3)),
                    updated_at: fmt_ts(col_f64(row, 4)),
                    score: None,
                }
            })
            .collect())
    }

    fn tags_for(&self, ids: &[String]) -> Result<HashMap<String, Vec<String>>> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows = self.run(
            queries::NOTE_TAGS_BY_IDS,
            params([(
                "ids",
                DataValue::List(ids.iter().map(|id| DataValue::from(id.as_str())).collect()),
            )]),
            ScriptMutability::Immutable,
        )?;

        let mut tags_by_note: HashMap<String, Vec<String>> = HashMap::new();
        for row in &rows.rows {
            tags_by_note
                .entry(col_str(row, 0))
                .or_default()
                .push(col_str(row, 1));
        }
        for tags in tags_by_note.values_mut() {
            tags.sort();
            tags.dedup();
        }
        Ok(tags_by_note)
    }

    pub fn note_exists(&self, id: &str) -> Result<bool> {
        let rows = self.run(
            "?[id] := *note{id}, id = $id",
            params([("id", DataValue::from(id))]),
            ScriptMutability::Immutable,
        )?;
        Ok(!rows.rows.is_empty())
    }

    pub fn get_note(&self, id: &str) -> Result<Option<Note>> {
        let rows = self.run(
            queries::GET_NOTE,
            params([("id", DataValue::from(id))]),
            ScriptMutability::Immutable,
        )?;
        let Some(row) = rows.rows.first() else {
            return Ok(None);
        };

        let id = col_str(row, 0);
        let notebook_id = col_str(row, 1);
        let title = col_str(row, 2);
        let content = col_str(row, 3);

        let tag_rows = self.run(
            queries::NOTE_TAGS,
            params([("id", DataValue::from(id.as_str()))]),
            ScriptMutability::Immutable,
        )?;
        let tags: Vec<String> = tag_rows.rows.iter().map(|row| col_str(row, 0)).collect();

        let title_rows = self.run(
            queries::NOTEBOOK_TITLES,
            params([("notebook_id", DataValue::from(notebook_id.as_str()))]),
            ScriptMutability::Immutable,
        )?;
        let mut by_title: HashMap<String, (String, String)> = HashMap::new();
        for row in &title_rows.rows {
            by_title
                .entry(normalize_title(&col_str(row, 1)))
                .or_insert_with(|| (col_str(row, 0), col_str(row, 1)));
        }

        let link_rows = self.run(
            queries::NOTE_LINKS,
            params([("id", DataValue::from(id.as_str()))]),
            ScriptMutability::Immutable,
        )?;
        let links = link_rows
            .rows
            .iter()
            .map(|row| {
                let target = col_str(row, 0);
                let label = col_str(row, 1);
                let resolved = by_title.get(&target);
                LinkRef {
                    note_id: resolved.map(|(note_id, _)| note_id.clone()),
                    title: resolved.map(|(_, title)| title.clone()),
                    target,
                    label,
                }
            })
            .collect();

        let backlink_rows = self.run(
            queries::NOTE_BACKLINKS,
            params([("target", DataValue::from(normalize_title(&title)))]),
            ScriptMutability::Immutable,
        )?;
        let backlinks = backlink_rows
            .rows
            .iter()
            .map(|row| BacklinkRef {
                id: col_str(row, 0),
                title: col_str(row, 1),
                updated_at: fmt_ts(col_f64(row, 2)),
            })
            .collect();

        Ok(Some(Note {
            id,
            notebook_id,
            title,
            content,
            created_at: fmt_ts(col_f64(row, 4)),
            updated_at: fmt_ts(col_f64(row, 5)),
            tags,
            links,
            backlinks,
        }))
    }

    pub fn create_note(
        &self,
        notebook_id: &str,
        title: &str,
        content: &str,
        explicit_tags: &[String],
    ) -> Result<Note> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ts();
        let tags = merge_tags(content, explicit_tags);
        let links = extract_wikilinks(content);
        let summary = summarize(content, SUMMARY_CHARS);

        let note_params = params([
            ("id", DataValue::from(id.as_str())),
            ("notebook_id", DataValue::from(notebook_id)),
            ("title", DataValue::from(title)),
            ("content", DataValue::from(content)),
            ("summary", DataValue::from(summary.as_str())),
            ("now", DataValue::from(now)),
        ]);

        let mut statements = vec![(queries::CREATE_NOTE, note_params)];
        if !tags.is_empty() {
            statements.push((
                queries::PUT_TAGS,
                params([("tag_rows", tag_rows(&id, &tags))]),
            ));
        }
        if !links.is_empty() {
            statements.push((
                queries::PUT_LINKS,
                params([("link_rows", link_rows(&id, &links))]),
            ));
        }

        self.run_atomic(statements)?;
        self.get_note(&id)?
            .ok_or_else(|| anyhow!("note vanished after create"))
    }

    pub fn update_note(
        &self,
        id: &str,
        title: &str,
        content: &str,
        explicit_tags: &[String],
    ) -> Result<Option<Note>> {
        if !self.note_exists(id)? {
            return Ok(None);
        }
        let tags = merge_tags(content, explicit_tags);
        let links = extract_wikilinks(content);
        let summary = summarize(content, SUMMARY_CHARS);

        let note_params = params([
            ("id", DataValue::from(id)),
            ("title", DataValue::from(title)),
            ("content", DataValue::from(content)),
            ("summary", DataValue::from(summary.as_str())),
            ("now", DataValue::from(now_ts())),
        ]);
        let id_params = params([("id", DataValue::from(id))]);

        let mut statements = vec![
            (queries::UPDATE_NOTE, note_params),
            (queries::DELETE_NOTE_TAGS, id_params.clone()),
            (queries::DELETE_NOTE_LINKS, id_params),
        ];
        if !tags.is_empty() {
            statements.push((
                queries::PUT_TAGS,
                params([("tag_rows", tag_rows(id, &tags))]),
            ));
        }
        if !links.is_empty() {
            statements.push((
                queries::PUT_LINKS,
                params([("link_rows", link_rows(id, &links))]),
            ));
        }

        self.run_atomic(statements)?;
        self.get_note(id)
    }

    pub fn delete_note(&self, id: &str) -> Result<bool> {
        if !self.note_exists(id)? {
            return Ok(false);
        }
        let par = params([("id", DataValue::from(id))]);
        self.run_atomic(vec![
            (queries::DELETE_NOTE_TAGS, par.clone()),
            (queries::DELETE_NOTE_LINKS, par.clone()),
            (queries::DELETE_NOTE, par),
        ])?;
        Ok(true)
    }

    pub fn list_tags(&self, notebook_id: &str) -> Result<Vec<TagCount>> {
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
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn tag_rows(note_id: &str, tags: &[String]) -> DataValue {
    DataValue::List(
        tags.iter()
            .map(|tag| {
                DataValue::List(vec![
                    DataValue::from(note_id),
                    DataValue::from(tag.as_str()),
                ])
            })
            .collect(),
    )
}

fn link_rows(note_id: &str, links: &[(String, String)]) -> DataValue {
    DataValue::List(
        links
            .iter()
            .map(|(target, label)| {
                DataValue::List(vec![
                    DataValue::from(note_id),
                    DataValue::from(target.as_str()),
                    DataValue::from(label.as_str()),
                ])
            })
            .collect(),
    )
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

fn now_ts() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn fmt_ts(ts: f64) -> String {
    DateTime::<Utc>::from_timestamp_millis((ts * 1000.0).round() as i64)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn unique_notebook_id(name: &str) -> String {
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_lowercase().to_string()
            } else {
                "-".to_string()
            }
        })
        .collect();
    let slug = slug.trim_matches('-');
    let slug: String = if slug.is_empty() {
        "notebook".to_string()
    } else {
        slug.chars().take(40).collect()
    };
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..6];
    format!("{}-{suffix}", slug.trim_matches('-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = Store::open(dir.path(), 0, 5.0).expect("open store");
        (dir, store)
    }

    #[test]
    fn notebook_note_lifecycle() {
        let (_dir, store) = store();

        let notebook = store.create_notebook("Test", "a notebook").unwrap();
        assert_eq!(notebook.name, "Test");
        assert_eq!(store.list_notebooks().unwrap().len(), 1);

        let alpha = store
            .create_note(
                &notebook.id,
                "Alpha",
                "Hello #rust\n\nSee [[Beta]].",
                &["explicit".into()],
            )
            .unwrap();
        assert_eq!(alpha.tags, vec!["explicit", "rust"]);
        assert_eq!(alpha.links.len(), 1);
        assert!(alpha.links[0].note_id.is_none());

        let beta = store
            .create_note(&notebook.id, "Beta", "Back to [[Alpha]]", &[])
            .unwrap();

        let alpha = store.get_note(&alpha.id).unwrap().unwrap();
        assert_eq!(alpha.links[0].note_id.as_deref(), Some(beta.id.as_str()));
        assert_eq!(alpha.backlinks.len(), 1);
        assert_eq!(alpha.backlinks[0].id, beta.id);

        // FTS is updated in the same transaction as the note row.
        let hits = store.search_notes(&notebook.id, "hello", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, alpha.id);
        assert!(hits[0].score.is_some());

        // Updating replaces tags and links rather than accumulating them.
        let updated = store
            .update_note(&alpha.id, "Alpha", "Only #new", &[])
            .unwrap()
            .unwrap();
        assert_eq!(updated.tags, vec!["new"]);
        assert!(updated.links.is_empty());
        assert_eq!(
            store.get_note(&beta.id).unwrap().unwrap().backlinks.len(),
            0
        );

        assert!(store.delete_note(&beta.id).unwrap());
        assert!(store.get_note(&beta.id).unwrap().is_none());
        assert_eq!(store.list_tags(&notebook.id).unwrap().len(), 1);

        assert!(store.delete_notebook(&notebook.id).unwrap());
        assert_eq!(store.stats().unwrap().notebooks, 0);
        assert_eq!(store.stats().unwrap().notes, 0);
    }

    #[test]
    fn cascade_delete_removes_orphans() {
        let (_dir, store) = store();
        let notebook = store.create_notebook("Cascade", "").unwrap();
        let note = store
            .create_note(&notebook.id, "One", "[[Two]] #tag", &[])
            .unwrap();
        store
            .create_note(&notebook.id, "Two", "content", &[])
            .unwrap();

        assert_eq!(store.stats().unwrap().tags, 1);
        assert_eq!(store.stats().unwrap().links, 1);
        store.delete_notebook(&notebook.id).unwrap();

        let stats = store.stats().unwrap();
        assert_eq!(stats.notebooks, 0);
        assert_eq!(stats.notes, 0);
        assert_eq!(stats.tags, 0);
        assert_eq!(stats.links, 0);
        assert!(store.get_note(&note.id).unwrap().is_none());
    }

    #[test]
    fn ad_hoc_query_is_read_only() {
        let (_dir, store) = store();
        let notebook = store.create_notebook("Q", "").unwrap();
        store.create_note(&notebook.id, "N", "body", &[]).unwrap();

        let rows = store
            .run_query(
                "?[id, title] := *note{id, title}",
                BTreeMap::new(),
                Some(2.0),
            )
            .unwrap();
        assert_eq!(rows.rows.len(), 1);

        let write = store.run_query(
            "?[id, title] <- [['x', 'X']] :put note {id => notebook_id, title, content, summary, created_at, updated_at}",
            BTreeMap::new(),
            Some(2.0),
        );
        assert!(write.is_err());
    }
}
