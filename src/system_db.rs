//! Durable OpalNote state, stored outside the document store.
//!
//! Notes and assets are files under `data/notebooks/`; the search index is
//! derived and disposable under `data/index/`. Everything the *application*
//! owns — sparse settings and the agent provider configuration — lives here, in
//! `<data-dir>/opalnote.db`, so deleting the index can never cost anything. See
//! `doc/adr/0001-durable-server-state.md`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use cozo::{DataValue, DbInstance, NamedRows, ScriptMutability};
use serde_json::Value;

use crate::store::queries;

/// Name of the durable database inside the data directory.
const DATABASE_FILE: &str = "opalnote.db";
/// Settings larger than this are rejected; the client only sends overrides.
pub const MAX_SETTINGS_BYTES: usize = 256 * 1024;
/// Upper bound for one stored key envelope (base64 ciphertext + KDF params).
pub const MAX_ENVELOPE_BYTES: usize = 16 * 1024;
/// Schema history of `opalnote.db`. Add a new version for every change; never
/// edit a shipped one (see `crate::migrations`).
const MIGRATIONS: &[crate::migrations::Migration] = &[crate::migrations::Migration {
    version: 1,
    name: "settings and agent config",
    steps: &[
        crate::migrations::Step::Create("app_settings", queries::APP_SETTINGS_CREATE),
        crate::migrations::Step::Create("agent_config", queries::AGENT_CONFIG_CREATE),
    ],
}];

/// Agent provider connection as the server stores it: readable connection
/// details plus the browser-made envelope for the upstream credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAgentConfig {
    pub base_url: String,
    pub models: Vec<String>,
    /// JSON envelope (`v`, `kdf`, `salt`, nonce, ciphertext); empty when the
    /// endpoint needs no credential at all (a local server).
    pub key_envelope: String,
    pub updated_at: i64,
}

/// Durable server database. Cheap to clone references to (`Arc<SystemDb>`).
pub struct SystemDb {
    db: DbInstance,
    path: PathBuf,
}

impl SystemDb {
    /// Open (or create) `<data-dir>/opalnote.db` and make sure both relations
    /// exist. Opening is idempotent.
    pub fn open(data_dir: &Path) -> Result<Self> {
        fs::create_dir_all(data_dir)
            .with_context(|| format!("creating data dir {}", data_dir.display()))?;
        let path = data_dir.join(DATABASE_FILE);
        let db = DbInstance::new("sqlite", &path, "")
            .map_err(|err| anyhow!("opening {}: {err}", path.display()))?;
        let system = Self { db, path };
        system.init()?;
        Ok(system)
    }

    /// Path of the database file (for logs and backups).
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn init(&self) -> Result<()> {
        let report = crate::migrations::apply(
            &self.db,
            DATABASE_FILE,
            MIGRATIONS,
            // Version 1 predates the migration table: a database that already
            // has `app_settings` is adopted instead of re-created.
            Some("app_settings"),
        )?;
        if report.applied > 0 {
            tracing::info!(
                path = %self.path.display(),
                from = report.from,
                to = report.to,
                applied = report.applied,
                "migrated OpalNote database"
            );
        }
        Ok(())
    }

    fn run(
        &self,
        script: &str,
        params: BTreeMap<String, DataValue>,
        mutability: ScriptMutability,
    ) -> Result<NamedRows> {
        self.db
            .run_script(script, params, mutability)
            .map_err(|err| anyhow!(err.to_string()))
    }

    /// Sparse settings document; `{}` when nothing has been saved yet.
    pub fn settings(&self) -> Result<Value> {
        let rows = self.run(
            queries::APP_SETTINGS_GET,
            BTreeMap::new(),
            ScriptMutability::Immutable,
        )?;
        let Some(row) = rows.rows.first() else {
            return Ok(Value::Object(serde_json::Map::new()));
        };
        let raw = row.first().and_then(DataValue::get_str).unwrap_or_default();
        let value: Value = serde_json::from_str(raw).context("parsing stored settings")?;
        if !value.is_object() {
            bail!("stored settings are not a JSON object");
        }
        Ok(value)
    }

    /// Replace the whole settings document.
    pub fn save_settings(&self, value: &Value) -> Result<()> {
        if !value.is_object() {
            bail!("settings must be a JSON object");
        }
        let raw = serde_json::to_string(value)?;
        if raw.len() > MAX_SETTINGS_BYTES {
            bail!("settings must be at most {MAX_SETTINGS_BYTES} bytes");
        }
        self.run(
            queries::APP_SETTINGS_PUT,
            params([
                ("json", DataValue::from(raw.as_str())),
                ("updated_at", DataValue::from(now_secs())),
            ]),
            ScriptMutability::Mutable,
        )?;
        Ok(())
    }

    /// Stored agent provider configuration, when one has been saved.
    pub fn agent_config(&self) -> Result<Option<StoredAgentConfig>> {
        let rows = self.run(
            queries::AGENT_CONFIG_GET,
            BTreeMap::new(),
            ScriptMutability::Immutable,
        )?;
        let Some(row) = rows.rows.first() else {
            return Ok(None);
        };
        let text = |index: usize| {
            row.get(index)
                .and_then(DataValue::get_str)
                .unwrap_or_default()
                .to_string()
        };
        let models: Vec<String> = serde_json::from_str(&text(1)).unwrap_or_default();
        let updated_at = row
            .get(3)
            .and_then(DataValue::get_float)
            .map(|value| value as i64)
            .unwrap_or_default();
        Ok(Some(StoredAgentConfig {
            base_url: text(0),
            models,
            key_envelope: text(2),
            updated_at,
        }))
    }

    /// Insert or replace the agent provider configuration.
    // The write path is wired up with the encrypted-key routes; the read path
    // is already live through `GET /api/agent`.
    #[allow(dead_code)]
    pub fn save_agent_config(&self, config: &StoredAgentConfig) -> Result<()> {
        let base_url = config.base_url.trim();
        if base_url.is_empty() {
            bail!("agent base URL must not be empty");
        }
        if config.key_envelope.len() > MAX_ENVELOPE_BYTES {
            bail!("agent key envelope must be at most {MAX_ENVELOPE_BYTES} bytes");
        }
        let models = serde_json::to_string(&config.models)?;
        self.run(
            queries::AGENT_CONFIG_PUT,
            params([
                ("base_url", DataValue::from(base_url)),
                ("models", DataValue::from(models.as_str())),
                (
                    "key_envelope",
                    DataValue::from(config.key_envelope.as_str()),
                ),
                ("updated_at", DataValue::from(now_secs())),
            ]),
            ScriptMutability::Mutable,
        )?;
        Ok(())
    }

    /// Forget the stored configuration (the UI is the only writer).
    #[allow(dead_code)]
    pub fn clear_agent_config(&self) -> Result<()> {
        self.run(
            queries::AGENT_CONFIG_DELETE,
            BTreeMap::new(),
            ScriptMutability::Mutable,
        )?;
        Ok(())
    }
}

/// Import a legacy `<data-dir>/settings.json` into the database exactly once.
///
/// The file is renamed rather than deleted, so a downgrade still finds it. A
/// failed import leaves it untouched.
pub fn import_legacy_settings(data_dir: &Path, system: &SystemDb) -> Result<bool> {
    let legacy = data_dir.join("settings.json");
    if !legacy.is_file() {
        return Ok(false);
    }
    let has_row = !system
        .run(
            queries::APP_SETTINGS_GET,
            BTreeMap::new(),
            ScriptMutability::Immutable,
        )?
        .rows
        .is_empty();
    if has_row {
        return Ok(false);
    }

    let raw = fs::read_to_string(&legacy)
        .with_context(|| format!("reading legacy settings {}", legacy.display()))?;
    let value: Value = serde_json::from_str(&raw)
        .with_context(|| format!("parsing legacy settings {}", legacy.display()))?;
    if !value.is_object() {
        bail!("legacy settings are not a JSON object");
    }
    system.save_settings(&value)?;

    let archived = data_dir.join("settings.json.imported");
    fs::rename(&legacy, &archived)
        .with_context(|| format!("archiving legacy settings to {}", archived.display()))?;
    Ok(true)
}

fn params<const N: usize>(pairs: [(&str, DataValue); N]) -> BTreeMap<String, DataValue> {
    pairs
        .into_iter()
        .map(|(name, value)| (name.to_string(), value))
        .collect()
}

fn now_secs() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn settings_round_trip_and_are_sparse() {
        let dir = tempdir().unwrap();
        let system = SystemDb::open(dir.path()).unwrap();
        assert_eq!(system.settings().unwrap(), json!({}));

        let value = json!({ "codeTheme": "github-dark", "maxUploadMb": 64 });
        system.save_settings(&value).unwrap();
        assert_eq!(system.settings().unwrap(), value);
        assert!(system.path().is_file());
    }

    #[test]
    fn legacy_settings_json_is_imported_once_and_archived() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            br#"{ "trashRetentionDays": 7 }"#,
        )
        .unwrap();

        let system = SystemDb::open(dir.path()).unwrap();
        assert!(import_legacy_settings(dir.path(), &system).unwrap());
        assert_eq!(
            system.settings().unwrap(),
            json!({ "trashRetentionDays": 7 })
        );
        assert!(!dir.path().join("settings.json").exists());
        assert!(dir.path().join("settings.json.imported").is_file());

        // A second run is a no-op and cannot resurrect the old file.
        assert!(!import_legacy_settings(dir.path(), &system).unwrap());
    }

    #[test]
    fn agent_config_round_trips_and_clears() {
        let dir = tempdir().unwrap();
        let system = SystemDb::open(dir.path()).unwrap();
        assert!(system.agent_config().unwrap().is_none());

        let config = StoredAgentConfig {
            base_url: "https://openrouter.ai/api/v1".to_string(),
            models: vec!["openai/gpt-4o-mini".to_string()],
            key_envelope: r#"{"v":1,"ciphertext":"abc"}"#.to_string(),
            updated_at: 0,
        };
        system.save_agent_config(&config).unwrap();

        let stored = system.agent_config().unwrap().expect("stored config");
        assert_eq!(stored.base_url, config.base_url);
        assert_eq!(stored.models, config.models);
        assert_eq!(stored.key_envelope, config.key_envelope);
        assert!(stored.updated_at > 0);

        system.clear_agent_config().unwrap();
        assert!(system.agent_config().unwrap().is_none());
    }

    #[test]
    fn agent_config_rejects_empty_url_and_oversized_envelope() {
        let dir = tempdir().unwrap();
        let system = SystemDb::open(dir.path()).unwrap();
        let mut config = StoredAgentConfig {
            base_url: "  ".to_string(),
            models: Vec::new(),
            key_envelope: String::new(),
            updated_at: 0,
        };
        assert!(system.save_agent_config(&config).is_err());

        config.base_url = "http://localhost:11434/v1".to_string();
        config.key_envelope = "x".repeat(MAX_ENVELOPE_BYTES + 1);
        assert!(system.save_agent_config(&config).is_err());
    }

    /// The durable database is a separate file from the note index, so a
    /// rebuilt or deleted index cannot take the settings with it.
    #[test]
    fn settings_survive_deleting_the_index_directory() {
        let dir = tempdir().unwrap();
        let store = crate::store::Store::open(dir.path(), 5.0).unwrap();
        let system = SystemDb::open(dir.path()).unwrap();
        system
            .save_settings(&json!({ "codeTheme": "github-dark" }))
            .unwrap();

        fs::remove_dir_all(dir.path().join("index")).unwrap();
        store.reindex().unwrap();

        let reopened = SystemDb::open(dir.path()).unwrap();
        assert_eq!(
            reopened.settings().unwrap(),
            json!({ "codeTheme": "github-dark" })
        );
    }
}
