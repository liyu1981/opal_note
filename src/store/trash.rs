//! Separate metadata database for the trash/bin.
//!
//! The disposable note index lives in `data/index/`; trash records must survive
//! deleting that directory, so they use their own SQLite database under
//! `data/.trash/trash.sqlite3`. Payload files live beside it in
//! `data/.trash/entries/<uuid>/`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use cozo::{DataValue, DbInstance, ScriptMutability};

use super::queries::{TRASH_CREATE, TRASH_DELETE, TRASH_GET, TRASH_LIST, TRASH_PUT};

#[derive(Debug, Clone)]
pub struct TrashRecord {
    pub id: String,
    pub notebook_id: String,
    pub notebook_name: String,
    pub original_path: String,
    pub kind: String,
    pub title: String,
    pub size: i64,
    pub deleted_at: f64,
    /// Path relative to the data directory, e.g. `.trash/entries/<id>/x.md`.
    pub trashed_path: String,
    pub mime: String,
    pub preview: String,
}

pub struct TrashDb {
    db: DbInstance,
    entries: PathBuf,
}

impl TrashDb {
    pub fn open(data_dir: &Path) -> Result<Self> {
        let root = data_dir.join(".trash");
        let entries = root.join("entries");
        fs::create_dir_all(&entries)
            .with_context(|| format!("creating trash directory {}", entries.display()))?;

        let path = root.join("trash.sqlite3");
        let db = DbInstance::new("sqlite", &path, "")
            .map_err(|err| anyhow!("opening trash database at {}: {err}", path.display()))?;
        let trash = Self { db, entries };
        trash.init()?;
        Ok(trash)
    }

    pub fn entries_dir(&self) -> &Path {
        &self.entries
    }

    fn init(&self) -> Result<()> {
        let existing = self.run("::relations", BTreeMap::new(), ScriptMutability::Immutable)?;
        let has_entries = existing.rows.iter().any(|row| {
            row.first()
                .and_then(DataValue::get_str)
                .is_some_and(|name| name == "trash_entry")
        });
        if !has_entries {
            self.run(TRASH_CREATE, BTreeMap::new(), ScriptMutability::Mutable)?;
        }
        Ok(())
    }

    pub fn put(&self, record: &TrashRecord) -> Result<()> {
        self.run(
            TRASH_PUT,
            params([
                ("id", DataValue::from(record.id.as_str())),
                ("notebook_id", DataValue::from(record.notebook_id.as_str())),
                (
                    "notebook_name",
                    DataValue::from(record.notebook_name.as_str()),
                ),
                (
                    "original_path",
                    DataValue::from(record.original_path.as_str()),
                ),
                ("kind", DataValue::from(record.kind.as_str())),
                ("title", DataValue::from(record.title.as_str())),
                ("size", DataValue::from(record.size)),
                ("deleted_at", DataValue::from(record.deleted_at)),
                (
                    "trashed_path",
                    DataValue::from(record.trashed_path.as_str()),
                ),
                ("mime", DataValue::from(record.mime.as_str())),
                ("preview", DataValue::from(record.preview.as_str())),
            ]),
            ScriptMutability::Mutable,
        )?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<TrashRecord>> {
        let rows = self.run(TRASH_LIST, BTreeMap::new(), ScriptMutability::Immutable)?;
        let mut records: Vec<TrashRecord> = rows.rows.iter().map(|row| record_from(row)).collect();
        records.sort_by(|left, right| {
            right
                .deleted_at
                .partial_cmp(&left.deleted_at)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(records)
    }

    pub fn get(&self, id: &str) -> Result<Option<TrashRecord>> {
        let rows = self.run(
            TRASH_GET,
            params([("id", DataValue::from(id))]),
            ScriptMutability::Immutable,
        )?;
        Ok(rows.rows.first().map(|row| record_from(row)))
    }

    /// Keep file entries pointing at their notebook after a folder rename.
    pub fn rename_notebook(&self, old_id: &str, new_id: &str) -> Result<()> {
        for mut record in self.list()? {
            if record.notebook_id != old_id || record.kind == "notebook" {
                continue;
            }
            record.notebook_id = new_id.to_string();
            record.notebook_name = new_id.to_string();
            self.put(&record)?;
        }
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        self.run(
            TRASH_DELETE,
            params([("id", DataValue::from(id))]),
            ScriptMutability::Mutable,
        )?;
        Ok(())
    }

    fn run(
        &self,
        script: &str,
        params: BTreeMap<String, DataValue>,
        mutability: ScriptMutability,
    ) -> Result<cozo::NamedRows> {
        self.db
            .run_script(script, params, mutability)
            .map_err(|err| anyhow!(err.to_string()))
    }
}

fn record_from(row: &[DataValue]) -> TrashRecord {
    TrashRecord {
        id: col_str(row, 0),
        notebook_id: col_str(row, 1),
        notebook_name: col_str(row, 2),
        original_path: col_str(row, 3),
        kind: col_str(row, 4),
        title: col_str(row, 5),
        size: col_i64(row, 6),
        deleted_at: col_f64(row, 7),
        trashed_path: col_str(row, 8),
        mime: col_str(row, 9),
        preview: col_str(row, 10),
    }
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
