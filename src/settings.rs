use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use serde_json::Value;

const MAX_SETTINGS_BYTES: usize = 256 * 1024;

/// Sparse user settings stored as one JSON object at `<data-dir>/settings.json`.
/// System defaults live in the client; the file only contains overrides.
pub struct SettingsStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl SettingsStore {
    pub fn new(data_dir: &Path) -> Result<Self> {
        fs::create_dir_all(data_dir)
            .with_context(|| format!("creating data dir {}", data_dir.display()))?;
        Ok(Self {
            path: data_dir.join("settings.json"),
            lock: Mutex::new(()),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<Value> {
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match fs::read_to_string(&self.path) {
            Ok(raw) => {
                let value: Value = serde_json::from_str(&raw)
                    .with_context(|| format!("parsing {}", self.path.display()))?;
                if !value.is_object() {
                    bail!("settings must be a JSON object");
                }
                Ok(value)
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Ok(Value::Object(serde_json::Map::new()))
            }
            Err(err) => Err(err).with_context(|| format!("reading {}", self.path.display())),
        }
    }

    pub fn save(&self, value: &Value) -> Result<()> {
        if !value.is_object() {
            bail!("settings must be a JSON object");
        }
        let raw = serde_json::to_vec_pretty(value)?;
        if raw.len() > MAX_SETTINGS_BYTES {
            bail!("settings must be at most {MAX_SETTINGS_BYTES} bytes");
        }

        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, raw).with_context(|| format!("writing {}", temp.display()))?;
        fs::rename(&temp, &self.path)
            .with_context(|| format!("replacing {}", self.path.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn settings_are_sparse_json_and_round_trip() {
        let dir = tempdir().unwrap();
        let store = SettingsStore::new(dir.path()).unwrap();
        assert_eq!(store.load().unwrap(), json!({}));

        let value = json!({
            "fonts": {
                "ui": { "family": "Inter", "google": false }
            }
        });
        store.save(&value).unwrap();
        assert_eq!(store.load().unwrap(), value);
        assert!(store.path().is_file());
    }

    #[test]
    fn rejects_non_object_settings() {
        let dir = tempdir().unwrap();
        let store = SettingsStore::new(dir.path()).unwrap();
        assert!(store.save(&json!(["not", "an", "object"])).is_err());
    }
}
