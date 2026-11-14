//! Small, sandboxed JavaScript plugins for journal widgets.
//!
//! Each run gets a fresh QuickJS runtime and may call the read-only Datalog
//! query host. There is no filesystem/network host API. The runtime is dropped
//! after one execution; a deadline interrupts JS and bounds each query.
//!
//! Built-in plugins live in `plugins/builtin/<id>/` and are embedded into the
//! binary. User plugins live in `<data-dir>/plugins/<id>/`. A data plugin with
//! the same id as a built-in is rejected so the embedded layer always wins.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context as _, Result};
use cozo::{DataValue, JsonData};
use rquickjs::{Context, Ctx, Function, Runtime};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::store::Store;

const MAX_MANIFEST_BYTES: usize = 16 * 1024;
const MAX_SCRIPT_BYTES: usize = 20_000;
const MAX_PARAMS: usize = 100;
const MAX_ITEMS: usize = 200;
const MAX_ID_CHARS: usize = 96;
const MAX_TITLE_CHARS: usize = 120;
const MAX_DESCRIPTION_CHARS: usize = 500;
const MEMORY_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const STACK_LIMIT_BYTES: usize = 512 * 1024;

#[derive(RustEmbed)]
#[folder = "plugins/builtin/"]
struct BuiltinPluginAssets;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginSource {
    Builtin,
    Data,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginInfo {
    pub id: String,
    pub title: String,
    pub description: String,
    pub source: PluginSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginLoadError {
    pub folder: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginList {
    pub directory: String,
    pub plugins: Vec<PluginInfo>,
    pub errors: Vec<PluginLoadError>,
}

#[derive(Debug, Clone)]
struct PluginDefinition {
    id: String,
    title: String,
    description: String,
    script: String,
    source: PluginSource,
    path: Option<String>,
}

#[derive(Default, Clone)]
struct RegistryState {
    plugins: Vec<PluginDefinition>,
    errors: Vec<PluginLoadError>,
}

/// Loaded plugin registry. `reload` swaps the state atomically so in-flight
/// journal runs keep using their snapshot.
pub struct PluginRegistry {
    directory: PathBuf,
    state: RwLock<RegistryState>,
}

impl PluginRegistry {
    pub fn new(data_dir: &Path) -> Result<Self> {
        let directory = data_dir.join("plugins");
        fs::create_dir_all(&directory)
            .with_context(|| format!("creating plugin directory {}", directory.display()))?;
        let state = load_registry(&directory)?;
        Ok(Self {
            directory,
            state: RwLock::new(state),
        })
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn reload(&self) -> Result<PluginList> {
        let state = load_registry(&self.directory)?;
        *self
            .state
            .write()
            .unwrap_or_else(|poison| poison.into_inner()) = state;
        Ok(self.list())
    }

    pub fn list(&self) -> PluginList {
        let state = self
            .state
            .read()
            .unwrap_or_else(|poison| poison.into_inner());
        PluginList {
            directory: self.directory.display().to_string(),
            plugins: state
                .plugins
                .iter()
                .map(|plugin| PluginInfo {
                    id: plugin.id.clone(),
                    title: plugin.title.clone(),
                    description: plugin.description.clone(),
                    source: plugin.source,
                    path: plugin.path.clone(),
                })
                .collect(),
            errors: state.errors.clone(),
        }
    }

    /// Run every registered plugin once for a notebook.
    pub fn run_journal(
        &self,
        store: &Arc<Store>,
        notebook_id: &str,
        timeout_secs: f64,
    ) -> Vec<JournalPluginResult> {
        let timeout = timeout_secs.clamp(0.1, 30.0);
        let plugins = self
            .state
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .plugins
            .clone();
        plugins
            .iter()
            .map(
                |plugin| match run_plugin(store.clone(), notebook_id, plugin, timeout) {
                    Ok(items) => JournalPluginResult {
                        id: plugin.id.clone(),
                        title: plugin.title.clone(),
                        description: plugin.description.clone(),
                        items,
                        error: None,
                    },
                    Err(err) => JournalPluginResult {
                        id: plugin.id.clone(),
                        title: plugin.title.clone(),
                        description: plugin.description.clone(),
                        items: json!([]),
                        error: Some(err.to_string()),
                    },
                },
            )
            .collect()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct JournalPluginResult {
    pub id: String,
    pub title: String,
    pub description: String,
    pub items: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn load_registry(directory: &Path) -> Result<RegistryState> {
    let mut plugins = BTreeMap::new();
    let mut errors = Vec::new();

    for plugin in load_builtin_plugins()? {
        plugins.insert(plugin.id.clone(), plugin);
    }

    for (folder, result) in load_data_plugins(directory) {
        match result {
            Ok(plugin) => {
                if let Some(existing) = plugins.get(&plugin.id) {
                    let reason = match existing.source {
                        PluginSource::Builtin => "a built-in plugin",
                        PluginSource::Data => "another data plugin",
                    };
                    errors.push(PluginLoadError {
                        folder,
                        message: format!("plugin id `{}` conflicts with {reason}", plugin.id),
                    });
                } else {
                    plugins.insert(plugin.id.clone(), plugin);
                }
            }
            Err(err) => errors.push(PluginLoadError {
                folder,
                message: format!("{err:#}"),
            }),
        }
    }

    Ok(RegistryState {
        plugins: plugins.into_values().collect(),
        errors,
    })
}

fn load_builtin_plugins() -> Result<Vec<PluginDefinition>> {
    let mut folders = BTreeSet::new();
    for path in BuiltinPluginAssets::iter() {
        if let Some(folder) = path.as_ref().strip_suffix("/plugin.json") {
            folders.insert(folder.to_string());
        }
    }

    let mut plugins = Vec::new();
    for folder in folders {
        let manifest = BuiltinPluginAssets::get(&format!("{folder}/plugin.json"))
            .with_context(|| format!("reading built-in plugin manifest `{folder}`"))?;
        let script = BuiltinPluginAssets::get(&format!("{folder}/plugin.js"))
            .with_context(|| format!("reading built-in plugin source `{folder}`"))?;
        let manifest = std::str::from_utf8(&manifest.data)
            .with_context(|| format!("built-in plugin manifest `{folder}` is not UTF-8"))?;
        let script = std::str::from_utf8(&script.data)
            .with_context(|| format!("built-in plugin source `{folder}` is not UTF-8"))?;
        plugins.push(parse_plugin(
            &folder,
            manifest,
            script,
            PluginSource::Builtin,
            Some(format!("plugins/builtin/{folder}")),
        )?);
    }
    Ok(plugins)
}

fn load_data_plugins(directory: &Path) -> Vec<(String, Result<PluginDefinition>)> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(err) => {
            return vec![(
                directory.display().to_string(),
                Err(err).with_context(|| format!("reading {}", directory.display())),
            )];
        }
    };

    let mut results = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let folder = entry.file_name().to_string_lossy().to_string();
        let result = (|| {
            let manifest = read_text(&path.join("plugin.json"), MAX_MANIFEST_BYTES)?;
            let script = read_text(&path.join("plugin.js"), MAX_SCRIPT_BYTES)?;
            parse_plugin(
                &folder,
                &manifest,
                &script,
                PluginSource::Data,
                Some(path.display().to_string()),
            )
        })();
        results.push((folder, result));
    }
    results.sort_by(|left, right| left.0.cmp(&right.0));
    results
}

fn read_text(path: &Path, max_bytes: usize) -> Result<String> {
    let raw = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    if raw.len() > max_bytes {
        bail!("{} must be at most {max_bytes} bytes", path.display());
    }
    String::from_utf8(raw).with_context(|| format!("{} is not UTF-8", path.display()))
}

fn valid_plugin_id(id: &str) -> bool {
    let mut parts = id.split('/');
    let Some(domain) = parts.next() else {
        return false;
    };
    let Some(extension) = parts.next() else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }
    [domain, extension].iter().all(|part| {
        !part.is_empty()
            && part
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_alphanumeric())
            && part
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    })
}

#[derive(Deserialize)]
struct PluginManifest {
    id: String,
    title: String,
    description: String,
}

fn parse_plugin(
    folder: &str,
    manifest_raw: &str,
    script: &str,
    source: PluginSource,
    path: Option<String>,
) -> Result<PluginDefinition> {
    let manifest: PluginManifest = serde_json::from_str(manifest_raw)
        .with_context(|| format!("parsing plugin.json for `{folder}`"))?;
    let id = manifest.id.trim();
    if id.is_empty() || id.chars().count() > MAX_ID_CHARS || !valid_plugin_id(id) {
        bail!(
            "plugin `{folder}` has an invalid id; use `<domain>/<extension>` with letters, digits, `-`, `_`, and `.`"
        );
    }
    let title = manifest.title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
        bail!("plugin `{folder}` title must be 1-{MAX_TITLE_CHARS} characters");
    }
    let description = manifest.description.trim();
    if description.is_empty() || description.chars().count() > MAX_DESCRIPTION_CHARS {
        bail!("plugin `{folder}` description must be 1-{MAX_DESCRIPTION_CHARS} characters");
    }
    if script.trim().is_empty() {
        bail!("plugin `{folder}` source must not be empty");
    }

    Ok(PluginDefinition {
        id: id.to_string(),
        title: title.to_string(),
        description: description.to_string(),
        script: script.to_string(),
        source,
        path,
    })
}

fn run_plugin(
    store: Arc<Store>,
    notebook_id: &str,
    plugin: &PluginDefinition,
    timeout_secs: f64,
) -> Result<Value> {
    let deadline = Instant::now() + Duration::from_secs_f64(timeout_secs);
    let runtime = Runtime::new().context("creating QuickJS runtime")?;
    runtime.set_memory_limit(MEMORY_LIMIT_BYTES);
    runtime.set_max_stack_size(STACK_LIMIT_BYTES);
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));

    let context = Context::full(&runtime).context("creating QuickJS context")?;
    let output = context.with(|ctx| -> Result<String> {
        let host = host_query(ctx.clone(), store, deadline)?;
        ctx.globals()
            .set("__queryHost", host)
            .context("installing __queryHost")?;
        ctx.eval::<(), _>(
            r#"
            globalThis.__query = function (script, params) {
              const result = JSON.parse(__queryHost(script, JSON.stringify(params || {})));
              return result.rows || [];
            };
            "#,
        )
        .context("installing query bridge")?;

        let notebook = serde_json::to_string(notebook_id)?;
        let source = format!("const __notebook_id = {notebook};\n{}\n", plugin.script);
        ctx.eval::<String, _>(source)
            .with_context(|| format!("running plugin `{}`", plugin.id))
    })?;

    let value: Value = serde_json::from_str(&output)
        .with_context(|| format!("plugin `{}` returned invalid JSON", plugin.id))?;
    let items = value.get("items").cloned().unwrap_or(value);
    if !items.is_array() {
        return Err(anyhow!("plugin `{}` must return an items array", plugin.id));
    }
    let mut items = items.as_array().cloned().unwrap_or_default();
    items.truncate(MAX_ITEMS);
    Ok(Value::Array(items))
}

fn host_query<'js>(ctx: Ctx<'js>, store: Arc<Store>, deadline: Instant) -> Result<Function<'js>> {
    Function::new(
        ctx,
        move |script: String, params_json: String| -> rquickjs::Result<String> {
            let script = script.trim().to_string();
            if script.is_empty() {
                return Err(rquickjs::Error::new_from_js_message(
                    "host",
                    "query",
                    "query script must not be empty",
                ));
            }
            if script.len() > MAX_SCRIPT_BYTES {
                return Err(rquickjs::Error::new_from_js_message(
                    "host",
                    "query",
                    format!("query script must be at most {MAX_SCRIPT_BYTES} bytes"),
                ));
            }
            if script.contains("::") {
                return Err(rquickjs::Error::new_from_js_message(
                    "host",
                    "query",
                    "system commands (`::`) are not allowed in plugins",
                ));
            }

            let params = parse_params(&params_json).map_err(|err| {
                rquickjs::Error::new_from_js_message("host", "query", err.to_string())
            })?;
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .as_secs_f64();
            if remaining <= 0.0 {
                return Err(rquickjs::Error::new_from_js_message(
                    "host",
                    "query",
                    "plugin deadline exceeded",
                ));
            }

            let rows = store
                .run_query(&script, params, Some(remaining))
                .map_err(|err| {
                    rquickjs::Error::new_from_js_message("host", "query", err.to_string())
                })?;
            serde_json::to_string(&rows.into_json()).map_err(|err| {
                rquickjs::Error::new_from_js_message("host", "query", err.to_string())
            })
        },
    )
    .map_err(|err| anyhow!(err.to_string()))
}

fn parse_params(params_json: &str) -> Result<BTreeMap<String, DataValue>> {
    let value: Value = serde_json::from_str(params_json).unwrap_or(Value::Null);
    let Value::Object(object) = value else {
        return Ok(BTreeMap::new());
    };
    if object.len() > MAX_PARAMS {
        return Err(anyhow!("at most {MAX_PARAMS} query parameters are allowed"));
    }
    Ok(object
        .iter()
        .map(|(key, value)| (key.clone(), to_data_value(value)))
        .collect())
}

fn to_data_value(value: &Value) -> DataValue {
    match value {
        Value::Null => DataValue::Null,
        Value::Bool(boolean) => DataValue::Bool(*boolean),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                DataValue::from(int)
            } else {
                DataValue::from(number.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(text) => DataValue::from(text.as_str()),
        Value::Array(items) => DataValue::List(items.iter().map(to_data_value).collect()),
        Value::Object(_) => DataValue::Json(JsonData(value.clone())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn interrupts_runaway_plugin() {
        let dir = tempdir().unwrap();
        let store = Arc::new(Store::open(dir.path(), 1.0).unwrap());
        let plugin = PluginDefinition {
            id: "Test/runaway".to_string(),
            title: "Runaway".to_string(),
            description: "test".to_string(),
            script: "while (true) {}".to_string(),
            source: PluginSource::Data,
            path: None,
        };
        let started = Instant::now();
        let error = run_plugin(store, "test", &plugin, 0.1).unwrap_err();
        assert!(!error.to_string().is_empty());
        assert!(started.elapsed().as_secs_f64() < 2.0);
    }

    #[test]
    fn registry_loads_builtins_and_data_plugins() {
        let dir = tempdir().unwrap();
        let plugin_dir = dir.path().join("plugins").join("hello");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"id":"Acme/hello","title":"Hello","description":"A test plugin."}"#,
        )
        .unwrap();
        fs::write(
            plugin_dir.join("plugin.js"),
            "return JSON.stringify({ items: [] });",
        )
        .unwrap();

        let registry = PluginRegistry::new(dir.path()).unwrap();
        let list = registry.list();
        assert!(list
            .plugins
            .iter()
            .any(|plugin| plugin.id == "OpalNote/todos" && plugin.source == PluginSource::Builtin));
        assert!(list
            .plugins
            .iter()
            .any(|plugin| plugin.id == "Acme/hello" && plugin.source == PluginSource::Data));
        assert!(list.errors.is_empty());
    }

    #[test]
    fn data_plugin_cannot_shadow_a_builtin_id() {
        let dir = tempdir().unwrap();
        let plugin_dir = dir.path().join("plugins").join("todos");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"id":"OpalNote/todos","title":"Shadow","description":"Should not load."}"#,
        )
        .unwrap();
        fs::write(
            plugin_dir.join("plugin.js"),
            "return JSON.stringify({ items: [] });",
        )
        .unwrap();

        let registry = PluginRegistry::new(dir.path()).unwrap();
        let list = registry.list();
        assert!(list.errors.iter().any(|error| error.folder == "todos"));
        assert!(list
            .plugins
            .iter()
            .any(|plugin| plugin.id == "OpalNote/todos" && plugin.source == PluginSource::Builtin));
    }
}
