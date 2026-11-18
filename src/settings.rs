use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Result};
use serde_json::Value;

use crate::system_db::SystemDb;

pub const DEFAULT_TRASH_RETENTION_DAYS: u64 = 30;
const MAX_TRASH_RETENTION_DAYS: u64 = 3_650;
/// Default per-file upload limit: 4 GiB.
pub const DEFAULT_MAX_UPLOAD_MB: u64 = 4_096;
const MIN_MAX_UPLOAD_MB: u64 = 1;
const MAX_MAX_UPLOAD_MB: u64 = 102_400;

/// Sparse user settings, stored as one JSON object in the durable server
/// database (`<data-dir>/opalnote.db`, `app_settings`). System defaults live in
/// the client, so the document only holds overrides.
pub struct SettingsStore {
    system: Arc<SystemDb>,
    /// Serializes read-modify-write cycles over the single settings row.
    lock: Mutex<()>,
}

impl SettingsStore {
    pub fn new(system: Arc<SystemDb>) -> Result<Self> {
        Ok(Self {
            system,
            lock: Mutex::new(()),
        })
    }

    /// Path of the database that holds the settings document.
    pub fn path(&self) -> &Path {
        self.system.path()
    }

    pub fn load(&self) -> Result<Value> {
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        self.system.settings()
    }

    /// How long deleted files stay recoverable. Sparse settings may omit the
    /// key; clamp bad values instead of failing the whole trash view.
    pub fn trash_retention_days(&self) -> u64 {
        self.load()
            .ok()
            .and_then(|value| value.get("trashRetentionDays").and_then(Value::as_u64))
            .unwrap_or(DEFAULT_TRASH_RETENTION_DAYS)
            .clamp(1, MAX_TRASH_RETENTION_DAYS)
    }

    /// Maximum size of a single uploaded asset in bytes. Sparse settings may
    /// omit `maxUploadMb`; bad values clamp instead of failing uploads.
    pub fn max_upload_mb(&self) -> u64 {
        self.load()
            .ok()
            .and_then(|value| value.get("maxUploadMb").and_then(Value::as_u64))
            .unwrap_or(DEFAULT_MAX_UPLOAD_MB)
            .clamp(MIN_MAX_UPLOAD_MB, MAX_MAX_UPLOAD_MB)
    }

    pub fn max_upload_bytes(&self) -> u64 {
        self.max_upload_mb().saturating_mul(1024 * 1024)
    }

    pub fn save(&self, value: &Value) -> Result<()> {
        if !value.is_object() {
            bail!("settings must be a JSON object");
        }
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        self.system.save_settings(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn settings(dir: &Path) -> SettingsStore {
        let system = Arc::new(SystemDb::open(dir).unwrap());
        SettingsStore::new(system).unwrap()
    }

    #[test]
    fn settings_are_sparse_json_and_round_trip() {
        let dir = tempdir().unwrap();
        let store = settings(dir.path());
        assert_eq!(store.load().unwrap(), json!({}));

        let value = json!({
            "fonts": {
                "ui": { "family": "Inter", "google": false }
            }
        });
        store.save(&value).unwrap();
        assert_eq!(store.load().unwrap(), value);
        assert_eq!(store.path(), dir.path().join("opalnote.db"));
        assert!(store.path().is_file());
    }

    #[test]
    fn trash_retention_defaults_and_clamps() {
        let dir = tempdir().unwrap();
        let store = settings(dir.path());
        assert_eq!(store.trash_retention_days(), DEFAULT_TRASH_RETENTION_DAYS);

        store.save(&json!({ "trashRetentionDays": 7 })).unwrap();
        assert_eq!(store.trash_retention_days(), 7);

        store.save(&json!({ "trashRetentionDays": 0 })).unwrap();
        assert_eq!(store.trash_retention_days(), 1);

        store
            .save(&json!({ "trashRetentionDays": 99_999 }))
            .unwrap();
        assert_eq!(store.trash_retention_days(), 3_650);

        store
            .save(&json!({ "trashRetentionDays": "seven" }))
            .unwrap();
        assert_eq!(store.trash_retention_days(), DEFAULT_TRASH_RETENTION_DAYS);
    }

    #[test]
    fn max_upload_defaults_and_clamps() {
        let dir = tempdir().unwrap();
        let store = settings(dir.path());
        assert_eq!(store.max_upload_mb(), 4_096);
        assert_eq!(store.max_upload_bytes(), 4_096 * 1024 * 1024);

        store.save(&json!({ "maxUploadMb": 12 })).unwrap();
        assert_eq!(store.max_upload_bytes(), 12 * 1024 * 1024);

        store.save(&json!({ "maxUploadMb": 0 })).unwrap();
        assert_eq!(store.max_upload_mb(), 1);

        store.save(&json!({ "maxUploadMb": 999_999 })).unwrap();
        assert_eq!(store.max_upload_mb(), 102_400);

        store.save(&json!({ "maxUploadMb": "lots" })).unwrap();
        assert_eq!(store.max_upload_mb(), DEFAULT_MAX_UPLOAD_MB);
    }

    #[test]
    fn rejects_non_object_settings() {
        let dir = tempdir().unwrap();
        let store = settings(dir.path());
        assert!(store.save(&json!(["not", "an", "object"])).is_err());
    }
}
