//! Small, sandboxed JavaScript plugins for journal widgets.
//!
//! Each run gets a fresh QuickJS runtime and may call the read-only Datalog
//! query host. There is no filesystem/network host API. The runtime is dropped
//! after one execution; a deadline interrupts JS and bounds each query.
//!
//! Built-in plugins live in `builtin/plugins/<id>/` and are embedded into the
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
#[cfg(not(debug_assertions))]
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::store::files;
use crate::store::Store;

const MAX_MANIFEST_BYTES: usize = 16 * 1024;
const MAX_SCRIPT_BYTES: usize = 20_000;
const MAX_VIEWER_EXTENSIONS: usize = 8;
const MAX_VIEWER_ENTRY_CHARS: usize = 200;
pub const MAX_VIEWER_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PARAMS: usize = 100;
const MAX_ITEMS: usize = 200;
const MAX_ID_CHARS: usize = 96;
const MAX_TITLE_CHARS: usize = 120;
const MAX_DESCRIPTION_CHARS: usize = 500;
const MAX_UI_BYTES: usize = 64 * 1024;
const MAX_UI_DEPTH: usize = 8;
const MAX_UI_NODES: usize = 200;
const MAX_UI_STRING_CHARS: usize = 2_000;
const MAX_UI_MARKDOWN_CHARS: usize = 48_000;
const MAX_UI_LIST_ITEMS: usize = 200;
const MEMORY_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const STACK_LIMIT_BYTES: usize = 512 * 1024;

#[cfg(not(debug_assertions))]
#[derive(RustEmbed)]
#[folder = "builtin/plugins/"]
struct BuiltinPluginAssets;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginSource {
    Builtin,
    Data,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    Server,
    Viewer,
}

/// Metadata for an iframe `viewer` plugin: the host mounts `file/<entry>` in a
/// sandbox and exchanges content over `postMessage`.
#[derive(Debug, Clone, Serialize)]
pub struct ViewerInfo {
    pub extensions: Vec<String>,
    pub role: String,
    pub entry: String,
    /// Extra CSP directives the viewer needs (e.g. `connect-src` for fetches).
    /// Only self/data/blob sources are accepted; the base policy is never
    /// weakened for scripts or framing.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub csp: BTreeMap<String, Vec<String>>,
    /// `opaque` (default) sandboxes the frame to an opaque origin; `same-origin`
    /// keeps the app origin so same-origin fetches and fonts work. Only safe
    /// for trusted, built-in bundles.
    pub sandbox: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginInfo {
    pub id: String,
    pub title: String,
    pub description: String,
    pub source: PluginSource,
    #[serde(rename = "type")]
    pub kind: PluginKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewer: Option<ViewerInfo>,
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
    kind: PluginKind,
    /// QuickJS source for server plugins; empty for viewers.
    script: String,
    viewer: Option<ViewerInfo>,
    source: PluginSource,
    /// Built-in folder (`OpalNote/mermaid`) or the data plugin directory.
    folder: String,
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
                    kind: plugin.kind,
                    viewer: plugin.viewer.clone(),
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
            .filter(|plugin| plugin.kind == PluginKind::Server)
            .map(
                |plugin| match run_plugin(store.clone(), notebook_id, plugin, timeout) {
                    Ok(output) => JournalPluginResult {
                        id: plugin.id.clone(),
                        title: plugin.title.clone(),
                        description: plugin.description.clone(),
                        items: output.items,
                        ui: output.ui,
                        error: None,
                    },
                    Err(err) => JournalPluginResult {
                        id: plugin.id.clone(),
                        title: plugin.title.clone(),
                        description: plugin.description.clone(),
                        items: json!([]),
                        ui: None,
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
    /// Optional declarative UI supplied by the plugin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug)]
struct PluginOutput {
    items: Value,
    ui: Option<Value>,
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
    for path in builtin_plugin_paths()? {
        if let Some(folder) = path.strip_suffix("/plugin.json") {
            folders.insert(folder.to_string());
        }
    }

    let mut plugins = Vec::new();
    for folder in folders {
        let manifest = read_builtin_plugin(&format!("{folder}/plugin.json"))
            .with_context(|| format!("reading built-in plugin manifest `{folder}`"))?;
        let manifest = std::str::from_utf8(&manifest)
            .with_context(|| format!("built-in plugin manifest `{folder}` is not UTF-8"))?;
        let manifest_json: Value = serde_json::from_str(manifest)
            .with_context(|| format!("parsing built-in plugin manifest `{folder}`"))?;
        // Client plugins live in the same OpalNote package tree but are built
        // into the web bundle; the QuickJS registry must not execute them.
        if manifest_json.get("type").and_then(Value::as_str) == Some("client") {
            continue;
        }
        let script = if is_viewer_manifest(&manifest_json) {
            String::new()
        } else {
            let script = read_builtin_plugin(&format!("{folder}/plugin.js"))
                .with_context(|| format!("reading built-in plugin source `{folder}`"))?;
            std::str::from_utf8(&script)
                .with_context(|| format!("built-in plugin source `{folder}` is not UTF-8"))?
                .to_string()
        };
        plugins.push(parse_plugin(
            &folder,
            manifest,
            &script,
            PluginSource::Builtin,
            &folder,
            Some(format!("builtin/plugins/{folder}")),
        )?);
    }
    Ok(plugins)
}

#[cfg(not(debug_assertions))]
fn builtin_plugin_paths() -> Result<Vec<String>> {
    Ok(BuiltinPluginAssets::iter()
        .map(|path| path.into_owned())
        .collect())
}

#[cfg(debug_assertions)]
fn builtin_plugin_paths() -> Result<Vec<String>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("builtin/plugins");
    Ok(files::list_files_recursive(&root)?)
}

#[cfg(not(debug_assertions))]
fn read_builtin_plugin_opt(path: &str) -> Option<Vec<u8>> {
    BuiltinPluginAssets::get(path).map(|file| file.data.into_owned())
}

#[cfg(not(debug_assertions))]
fn read_builtin_plugin(path: &str) -> Result<Vec<u8>> {
    Ok(BuiltinPluginAssets::get(path)
        .with_context(|| format!("missing embedded built-in plugin file `{path}`"))?
        .data
        .into_owned())
}

#[cfg(debug_assertions)]
fn read_builtin_plugin_opt(path: &str) -> Option<Vec<u8>> {
    fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("builtin/plugins")
            .join(path),
    )
    .ok()
}

#[cfg(debug_assertions)]
fn read_builtin_plugin(path: &str) -> Result<Vec<u8>> {
    fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("builtin/plugins")
            .join(path),
    )
    .with_context(|| format!("reading built-in plugin file `{path}`"))
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
            let manifest_json: Value = serde_json::from_str(&manifest)
                .with_context(|| format!("parsing plugin.json for `{folder}`"))?;
            let script = if is_viewer_manifest(&manifest_json) {
                String::new()
            } else {
                read_text(&path.join("plugin.js"), MAX_SCRIPT_BYTES)?
            };
            let definition = parse_plugin(
                &folder,
                &manifest,
                &script,
                PluginSource::Data,
                &path.display().to_string(),
                Some(path.display().to_string()),
            )?;
            if let (PluginKind::Viewer, Some(viewer)) =
                (definition.kind, definition.viewer.as_ref())
            {
                let entry = path.join(&viewer.entry);
                if !entry.is_file() {
                    bail!("viewer plugin `{folder}` is missing `{}`", viewer.entry);
                }
            }
            Ok(definition)
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

fn default_plugin_type() -> String {
    "server".to_string()
}

#[derive(Deserialize)]
struct PluginManifest {
    id: String,
    title: String,
    description: String,
    #[serde(default = "default_plugin_type", rename = "type")]
    plugin_type: String,
    #[serde(default)]
    extensions: Vec<String>,
    #[serde(default)]
    entry: String,
    #[serde(default)]
    role: String,
    #[serde(default)]
    csp: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    sandbox: String,
}

fn is_viewer_manifest(manifest: &Value) -> bool {
    manifest.get("type").and_then(Value::as_str) == Some("viewer")
}

/// Directives a viewer may extend. `default-src`, `script-src`,
/// `frame-ancestors`, `base-uri` and `form-action` stay host-controlled.
const VIEWER_CSP_DIRECTIVES: &[&str] = &[
    "connect-src",
    "font-src",
    "img-src",
    "media-src",
    "style-src",
    "worker-src",
    // `script-src` may only add WebAssembly compilation, never JS eval.
    "script-src",
];

fn viewer_csp_source_allowed(directive: &str, source: &str) -> bool {
    match source {
        "'self'" | "data:" | "blob:" => true,
        "'unsafe-inline'" => directive == "style-src",
        "'wasm-unsafe-eval'" => directive == "script-src",
        _ => false,
    }
}

fn parse_viewer_csp(
    folder: &str,
    raw: &BTreeMap<String, Vec<String>>,
) -> Result<BTreeMap<String, Vec<String>>> {
    let mut csp = BTreeMap::new();
    for (directive, sources) in raw {
        let directive = directive.trim();
        if !VIEWER_CSP_DIRECTIVES.contains(&directive) {
            bail!(
                "viewer plugin `{folder}` csp directive `{directive}` is not allowed; use {}",
                VIEWER_CSP_DIRECTIVES.join(", ")
            );
        }
        let mut values = Vec::new();
        for source in sources {
            let source = source.trim();
            if !viewer_csp_source_allowed(directive, source) {
                bail!(
                    "viewer plugin `{folder}` csp source `{source}` is not allowed in `{directive}`"
                );
            }
            if !values.iter().any(|value| value == source) {
                values.push(source.to_string());
            }
        }
        if values.is_empty() {
            bail!("viewer plugin `{folder}` csp directive `{directive}` needs a source");
        }
        csp.insert(directive.to_string(), values);
    }
    Ok(csp)
}

fn valid_viewer_extension(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= 16
        && value
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
}

/// A viewer file path: relative, forward slashes, no traversal.
pub fn is_safe_viewer_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains("//")
        && !path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
}

fn parse_plugin(
    folder: &str,
    manifest_raw: &str,
    script: &str,
    source: PluginSource,
    base_folder: &str,
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
    let kind = match manifest.plugin_type.trim() {
        "server" => PluginKind::Server,
        "viewer" => PluginKind::Viewer,
        "client" => {
            bail!("plugin `{folder}` is a client plugin and cannot run in the server registry")
        }
        other => {
            bail!("plugin `{folder}` has unknown type `{other}`; use server, client or viewer")
        }
    };

    if kind == PluginKind::Server && script.trim().is_empty() {
        bail!("plugin `{folder}` source must not be empty");
    }

    let mut viewer = None;
    if kind == PluginKind::Viewer {
        let extensions: Vec<String> = manifest
            .extensions
            .iter()
            .map(|value| value.trim().trim_start_matches('.').to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .collect();
        if extensions.is_empty() || extensions.len() > MAX_VIEWER_EXTENSIONS {
            bail!("viewer plugin `{folder}` must declare 1-{MAX_VIEWER_EXTENSIONS} extensions");
        }
        if let Some(bad) = extensions
            .iter()
            .find(|value| !valid_viewer_extension(value))
        {
            bail!(
                "viewer plugin `{folder}` has invalid extension `{bad}`; use lower-case letters and digits"
            );
        }
        let entry = manifest.entry.trim();
        if entry.is_empty()
            || entry.chars().count() > MAX_VIEWER_ENTRY_CHARS
            || !entry.ends_with(".html")
            || !is_safe_viewer_path(entry)
        {
            bail!("viewer plugin `{folder}` entry must be a relative `.html` path");
        }
        let role = manifest.role.trim();
        if role != "renderer" && role != "editor" {
            bail!("viewer plugin `{folder}` role must be `renderer` or `editor`");
        }
        let sandbox = match manifest.sandbox.trim() {
            "" | "opaque" => "opaque",
            "same-origin" => "same-origin",
            other => bail!(
                "viewer plugin `{folder}` sandbox `{other}` must be `opaque` or `same-origin`"
            ),
        };
        viewer = Some(ViewerInfo {
            extensions,
            role: role.to_string(),
            entry: entry.to_string(),
            csp: parse_viewer_csp(folder, &manifest.csp)?,
            sandbox: sandbox.to_string(),
        });
    }

    Ok(PluginDefinition {
        id: id.to_string(),
        title: title.to_string(),
        description: description.to_string(),
        kind,
        script: script.to_string(),
        viewer,
        source,
        folder: base_folder.to_string(),
        path,
    })
}

/// Viewer CSP. Built-in viewers run same-origin (`'self'`), so the policy works
/// behind any proxy; host-derived sources are added as a fallback for opaque
/// data viewers, where `'self'` cannot match. Manifest `csp` directives are
/// merged last, and the `sandbox` directive mirrors the iframe tokens.
pub fn viewer_csp_for(
    hosts: &[String],
    plugin_id: &str,
    sandbox: &str,
    extra: &BTreeMap<String, Vec<String>>,
) -> String {
    let mut bases: Vec<String> = Vec::new();
    for host in hosts {
        for scheme in ["https", "http"] {
            let base = format!("{scheme}://{host}/static/plugins/{plugin_id}/");
            if !bases.contains(&base) {
                bases.push(base);
            }
        }
    }
    let mut csp: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut extend = |directive: &str, values: &[&str]| {
        let slot = csp.entry(directive.to_string()).or_default();
        for value in values {
            let value = value.to_string();
            if !slot.iter().any(|existing| existing == &value) {
                slot.push(value);
            }
        }
    };

    fn with<'a>(bases: &'a [String], extra: &[&'a str]) -> Vec<&'a str> {
        let mut values: Vec<&'a str> = vec!["'self'"];
        values.extend(bases.iter().map(String::as_str));
        values.extend(extra.iter().copied());
        values
    }

    extend("default-src", &["'none'"]);
    extend("script-src", &with(&bases, &[]));
    extend("style-src", &with(&bases, &["'unsafe-inline'"]));
    extend("img-src", &with(&bases, &["data:", "blob:"]));
    extend("font-src", &with(&bases, &["data:", "blob:"]));
    extend("connect-src", &with(&bases, &[]));
    extend("worker-src", &with(&bases, &["blob:"]));
    extend("frame-ancestors", &["'self'"]);

    for (directive, values) in extra {
        if !VIEWER_CSP_DIRECTIVES.contains(&directive.as_str()) {
            continue;
        }
        for value in values {
            let slot = csp.entry(directive.clone()).or_default();
            if !slot.iter().any(|existing| existing == value) {
                slot.push(value.clone());
            }
        }
    }

    let mut rendered = csp
        .iter()
        .map(|(directive, values)| format!("{directive} {}", values.join(" ")))
        .collect::<Vec<_>>()
        .join("; ");
    // Keep a document opened as a top-level tab sandboxed as well, with the
    // same tokens as the iframe attribute.
    rendered.push_str(if sandbox == "same-origin" {
        "; sandbox allow-scripts allow-same-origin"
    } else {
        "; sandbox allow-scripts"
    });
    rendered
}

impl PluginRegistry {
    /// CSP directives a viewer declared in `opal_note.csp`.
    pub fn viewer_csp_extra(&self, id: &str) -> BTreeMap<String, Vec<String>> {
        let state = self
            .state
            .read()
            .unwrap_or_else(|poison| poison.into_inner());
        state
            .plugins
            .iter()
            .find(|plugin| plugin.id == id)
            .and_then(|plugin| plugin.viewer.as_ref())
            .map(|viewer| viewer.csp.clone())
            .unwrap_or_default()
    }

    /// Declared sandbox mode for a viewer (`opaque` or `same-origin`).
    pub fn viewer_sandbox(&self, id: &str) -> String {
        let state = self
            .state
            .read()
            .unwrap_or_else(|poison| poison.into_inner());
        state
            .plugins
            .iter()
            .find(|plugin| plugin.id == id)
            .and_then(|plugin| plugin.viewer.as_ref())
            .map(|viewer| viewer.sandbox.clone())
            .unwrap_or_else(|| "opaque".to_string())
    }

    /// Serve one file of a viewer bundle (`viewer.html`, `viewer.js`, fonts…).
    pub fn viewer_file(&self, id: &str, rel: &str) -> Result<Option<Vec<u8>>> {
        if !is_safe_viewer_path(rel) {
            bail!("invalid viewer file path");
        }
        let state = self
            .state
            .read()
            .unwrap_or_else(|poison| poison.into_inner());
        let Some(plugin) = state.plugins.iter().find(|plugin| plugin.id == id) else {
            return Ok(None);
        };
        if plugin.kind != PluginKind::Viewer {
            return Ok(None);
        }
        match plugin.source {
            PluginSource::Builtin => {
                let path = format!("{}/{rel}", plugin.folder);
                let Some(bytes) = read_builtin_plugin_opt(&path) else {
                    return Ok(None);
                };
                if bytes.len() as u64 > MAX_VIEWER_FILE_BYTES {
                    bail!("viewer file `{path}` is too large");
                }
                Ok(Some(bytes))
            }
            PluginSource::Data => {
                let root = PathBuf::from(&plugin.folder);
                let target = root.join(rel);
                let root = fs::canonicalize(&root)
                    .with_context(|| format!("resolving viewer folder {}", root.display()))?;
                let target = match fs::canonicalize(&target) {
                    Ok(target) => target,
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                        return Ok(None);
                    }
                    Err(err) => {
                        return Err(err)
                            .with_context(|| format!("resolving viewer file {}", target.display()))
                    }
                };
                if !target.starts_with(&root) {
                    bail!("viewer file escapes the plugin folder");
                }
                let metadata = fs::metadata(&target)?;
                if !metadata.is_file() {
                    bail!("viewer file is not a file");
                }
                if metadata.len() > MAX_VIEWER_FILE_BYTES {
                    bail!("viewer file is too large");
                }
                Ok(Some(fs::read(&target)?))
            }
        }
    }
}

fn run_plugin(
    store: Arc<Store>,
    notebook_id: &str,
    plugin: &PluginDefinition,
    timeout_secs: f64,
) -> Result<PluginOutput> {
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
    let ui = match value.get("ui") {
        Some(ui) if !ui.is_null() => Some(validate_plugin_ui(ui)?),
        _ => None,
    };
    let items = value.get("items").cloned().unwrap_or(value);
    if !items.is_array() {
        return Err(anyhow!("plugin `{}` must return an items array", plugin.id));
    }
    let mut items = items.as_array().cloned().unwrap_or_default();
    items.truncate(MAX_ITEMS);
    Ok(PluginOutput {
        items: Value::Array(items),
        ui,
    })
}

fn validate_plugin_ui(value: &Value) -> Result<Value> {
    let encoded = serde_json::to_vec(value).context("serializing plugin ui")?;
    if encoded.len() > MAX_UI_BYTES {
        bail!("plugin ui must be at most {MAX_UI_BYTES} bytes");
    }
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("plugin ui must be an object"))?;

    if let Some(schema) = object.get("schema") {
        if schema.as_i64() != Some(1) {
            bail!("plugin ui schema must be 1");
        }
        let root = object
            .get("root")
            .ok_or_else(|| anyhow!("plugin ui schema requires a root node"))?;
        let mut nodes = 0;
        validate_ui_node(root, 0, &mut nodes)?;
        return Ok(value.clone());
    }

    if let Some(kind) = object.get("kind") {
        let kind = kind
            .as_str()
            .ok_or_else(|| anyhow!("plugin ui kind must be a string"))?;
        if kind.trim().is_empty() || kind.chars().count() > 64 {
            bail!("plugin ui kind must be 1-64 characters");
        }
        if let Some(title) = object.get("title") {
            validate_ui_string_value(title, "plugin ui title")?;
        }
        return Ok(value.clone());
    }

    bail!("plugin ui requires either schema or kind")
}

fn validate_ui_node(node: &Value, depth: usize, nodes: &mut usize) -> Result<()> {
    if depth > MAX_UI_DEPTH {
        bail!("plugin ui nesting exceeds {MAX_UI_DEPTH} levels");
    }
    *nodes += 1;
    if *nodes > MAX_UI_NODES {
        bail!("plugin ui has more than {MAX_UI_NODES} nodes");
    }
    let object = node
        .as_object()
        .ok_or_else(|| anyhow!("plugin ui nodes must be objects"))?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("plugin ui node requires a type"))?;

    match kind {
        "card" | "section" | "row" => {
            validate_optional_ui_string(object, "title")?;
            validate_optional_ui_string(object, "emptyText")?;
            validate_ui_children(object, depth, nodes)?;
        }
        "heading" => {
            validate_ui_string(object, "text", "plugin ui heading text")?;
            if let Some(level) = object.get("level") {
                let level = level
                    .as_i64()
                    .ok_or_else(|| anyhow!("plugin ui heading level must be an integer"))?;
                if !(1..=3).contains(&level) {
                    bail!("plugin ui heading level must be 1-3");
                }
            }
        }
        "text" | "empty" => {
            validate_optional_ui_string(object, "text")?;
            validate_ui_tone(object)?;
        }
        "badge" => {
            validate_ui_string(object, "text", "plugin ui badge text")?;
            validate_ui_tone(object)?;
        }
        "list" => {
            validate_optional_ui_string(object, "emptyText")?;
            let items = object
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("plugin ui list requires an items array"))?;
            if items.len() > MAX_UI_LIST_ITEMS {
                bail!("plugin ui list supports at most {MAX_UI_LIST_ITEMS} items");
            }
            for item in items {
                validate_ui_list_item(item)?;
            }
        }
        "button" => {
            validate_ui_string(object, "label", "plugin ui button label")?;
            validate_ui_variant(object)?;
            validate_ui_action(
                object
                    .get("action")
                    .ok_or_else(|| anyhow!("plugin ui button requires an action"))?,
            )?;
        }
        "link" => {
            validate_ui_string(object, "label", "plugin ui link label")?;
            validate_ui_action(
                object
                    .get("action")
                    .ok_or_else(|| anyhow!("plugin ui link requires an action"))?,
            )?;
        }
        "markdown" => {
            let value = object
                .get("value")
                .ok_or_else(|| anyhow!("plugin ui markdown value is required"))?
                .as_str()
                .ok_or_else(|| anyhow!("plugin ui markdown value must be a string"))?;
            if value.chars().count() > MAX_UI_MARKDOWN_CHARS {
                bail!("plugin ui markdown value is too long");
            }
        }
        "graph" => {
            validate_optional_ui_string(object, "title")?;
            if let Some(scope) = object.get("scope") {
                let scope = scope
                    .as_str()
                    .ok_or_else(|| anyhow!("plugin ui graph scope must be a string"))?;
                if !matches!(scope, "local" | "all") {
                    bail!("plugin ui graph scope must be local or all");
                }
            }
            if let Some(include_tags) = object.get("includeTags") {
                if !include_tags.is_boolean() {
                    bail!("plugin ui graph includeTags must be a boolean");
                }
            }
            if let Some(height) = object.get("height") {
                let height = height
                    .as_i64()
                    .ok_or_else(|| anyhow!("plugin ui graph height must be an integer"))?;
                if !(120..=480).contains(&height) {
                    bail!("plugin ui graph height must be 120-480");
                }
            }
        }
        "separator" => {}
        other => bail!("plugin ui node type `{other}` is not supported"),
    }
    Ok(())
}

fn validate_ui_children(
    object: &serde_json::Map<String, Value>,
    depth: usize,
    nodes: &mut usize,
) -> Result<()> {
    let Some(children) = object.get("children") else {
        return Ok(());
    };
    let children = children
        .as_array()
        .ok_or_else(|| anyhow!("plugin ui children must be an array"))?;
    for child in children {
        validate_ui_node(child, depth + 1, nodes)?;
    }
    Ok(())
}

fn validate_ui_list_item(value: &Value) -> Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("plugin ui list items must be objects"))?;
    validate_ui_string(object, "title", "plugin ui list item title")?;
    validate_optional_ui_string(object, "detail")?;
    validate_optional_ui_string(object, "note_path")?;
    validate_optional_ui_string(object, "status")?;
    if let Some(action) = object.get("action") {
        validate_ui_action(action)?;
    }
    Ok(())
}

fn validate_ui_action(value: &Value) -> Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("plugin ui action must be an object"))?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("plugin ui action requires a type"))?;
    match kind {
        "openNote" => {
            validate_ui_string(object, "path", "plugin ui openNote path")?;
        }
        "openTag" => {
            validate_ui_string(object, "tag", "plugin ui openTag tag")?;
        }
        "openExternal" => {
            let url = validate_ui_string(object, "url", "plugin ui openExternal url")?;
            if !["http://", "https://", "mailto:"]
                .iter()
                .any(|prefix| url.starts_with(prefix))
            {
                bail!("plugin ui openExternal url must use http, https or mailto");
            }
        }
        "runCommand" => {
            validate_ui_string(object, "id", "plugin ui runCommand id")?;
        }
        other => bail!("plugin ui action type `{other}` is not supported"),
    }
    Ok(())
}

fn validate_ui_tone(object: &serde_json::Map<String, Value>) -> Result<()> {
    if let Some(tone) = object.get("tone") {
        let tone = tone
            .as_str()
            .ok_or_else(|| anyhow!("plugin ui tone must be a string"))?;
        if !matches!(tone, "muted" | "accent" | "danger" | "success") {
            bail!("plugin ui tone `{tone}` is not supported");
        }
    }
    Ok(())
}

fn validate_ui_variant(object: &serde_json::Map<String, Value>) -> Result<()> {
    if let Some(variant) = object.get("variant") {
        let variant = variant
            .as_str()
            .ok_or_else(|| anyhow!("plugin ui variant must be a string"))?;
        if !matches!(variant, "default" | "ghost" | "danger") {
            bail!("plugin ui variant `{variant}` is not supported");
        }
    }
    Ok(())
}

fn validate_ui_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<&'a str> {
    let value = object
        .get(key)
        .ok_or_else(|| anyhow!("{label} is required"))?
        .as_str()
        .ok_or_else(|| anyhow!("{label} must be a string"))?;
    if value.chars().count() > MAX_UI_STRING_CHARS {
        bail!("{label} is too long");
    }
    Ok(value)
}

fn validate_optional_ui_string(object: &serde_json::Map<String, Value>, key: &str) -> Result<()> {
    if let Some(value) = object.get(key) {
        validate_ui_string_value(value, &format!("plugin ui {key}"))?;
    }
    Ok(())
}

fn validate_ui_string_value(value: &Value, label: &str) -> Result<()> {
    let value = value
        .as_str()
        .ok_or_else(|| anyhow!("{label} must be a string"))?;
    if value.chars().count() > MAX_UI_STRING_CHARS {
        bail!("{label} is too long");
    }
    Ok(())
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
            kind: PluginKind::Server,
            script: "while (true) {}".to_string(),
            viewer: None,
            source: PluginSource::Data,
            folder: String::new(),
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
    fn registry_loads_viewer_plugins_and_serves_files() {
        let dir = tempdir().unwrap();
        let viewer_dir = dir.path().join("plugins").join("mermaid");
        fs::create_dir_all(&viewer_dir).unwrap();
        fs::write(
            viewer_dir.join("plugin.json"),
            r#"{
                "id": "Acme/mermaid",
                "title": "Mermaid",
                "description": "Viewer test",
                "type": "viewer",
                "extensions": ["Mermaid", ".mmd"],
                "entry": "viewer.html",
                "role": "renderer"
            }"#,
        )
        .unwrap();
        fs::write(viewer_dir.join("viewer.html"), "<!doctype html>ok").unwrap();
        fs::write(viewer_dir.join("viewer.js"), "console.log(1)").unwrap();

        let registry = PluginRegistry::new(dir.path()).unwrap();
        let list = registry.list();
        let viewer = list
            .plugins
            .iter()
            .find(|plugin| plugin.id == "Acme/mermaid")
            .expect("viewer plugin loaded");
        assert_eq!(viewer.kind, PluginKind::Viewer);
        let meta = viewer.viewer.as_ref().unwrap();
        assert_eq!(meta.extensions, vec!["mermaid", "mmd"]);
        assert_eq!(meta.role, "renderer");
        assert_eq!(meta.entry, "viewer.html");

        let html = registry
            .viewer_file("Acme/mermaid", "viewer.html")
            .unwrap()
            .expect("viewer file");
        assert_eq!(html, b"<!doctype html>ok");
        assert!(registry
            .viewer_file("Acme/mermaid", "../../secret")
            .is_err());
        assert!(registry
            .viewer_file("Acme/missing", "viewer.html")
            .unwrap()
            .is_none());

        // Viewers never run as journal plugins.
        let store = Arc::new(Store::open(dir.path(), 1.0).unwrap());
        store.create_notebook("Notes", "").unwrap();
        let results = registry.run_journal(&store, "Notes", 0.5);
        assert!(results.iter().all(|result| result.id != "Acme/mermaid"));
    }

    #[test]
    fn allows_wasm_but_not_js_eval_in_viewer_csp() {
        let wasm = r#"{"id":"A/canvas","title":"C","description":"D","type":"viewer",
            "extensions":["canvas"],"entry":"viewer.html","role":"editor",
            "csp":{"script-src":["'self'","'wasm-unsafe-eval'"]}}"#;
        assert!(parse_plugin("case", wasm, "", PluginSource::Data, "case", None).is_ok());

        let eval = r#"{"id":"A/canvas","title":"C","description":"D","type":"viewer",
            "extensions":["canvas"],"entry":"viewer.html","role":"editor",
            "csp":{"script-src":["'self'","'unsafe-eval'"]}}"#;
        assert!(parse_plugin("case", eval, "", PluginSource::Data, "case", None).is_err());

        let inline = r#"{"id":"A/canvas","title":"C","description":"D","type":"viewer",
            "extensions":["canvas"],"entry":"viewer.html","role":"editor",
            "csp":{"script-src":["'self'","'unsafe-inline'"]}}"#;
        assert!(parse_plugin("case", inline, "", PluginSource::Data, "case", None).is_err());
    }

    #[test]
    fn composes_viewer_csp_from_the_manifest() {
        let manifest = r#"{
            "id": "A/canvas",
            "title": "Canvas",
            "description": "Viewer with wasm",
            "type": "viewer",
            "extensions": ["canvas"],
            "entry": "viewer.html",
            "role": "editor",
            "csp": { "script-src": ["'wasm-unsafe-eval'"], "worker-src": ["blob:"] }
        }"#;
        let plugin = parse_plugin("case", manifest, "", PluginSource::Data, "case", None).unwrap();
        let rendered = viewer_csp_for(
            &["notes.example:7827".to_string()],
            "A/canvas",
            "opaque",
            &plugin.viewer.as_ref().unwrap().csp,
        );
        assert!(
            rendered.contains("https://notes.example:7827/static/plugins/A/canvas/"),
            "{rendered}"
        );
        assert!(rendered.contains("'wasm-unsafe-eval'"), "{rendered}");
        assert!(rendered.contains("blob:"), "{rendered}");
        assert!(rendered.contains("frame-ancestors 'self'"), "{rendered}");
        assert!(rendered.contains("sandbox allow-scripts"), "{rendered}");
        assert!(!rendered.contains("'unsafe-eval'"), "{rendered}");
        assert!(!rendered.contains("esm.sh"), "{rendered}");
        assert!(rendered.contains("script-src 'self'"), "{rendered}");
        assert!(rendered.contains("font-src 'self'"), "{rendered}");
        assert!(rendered.contains("sandbox allow-scripts"), "{rendered}");
    }

    #[test]
    fn rejects_unsafe_viewer_csp_declarations() {
        let cases = [
            r#""csp": { "default-src": ["'self'"] }"#,
            r#""csp": { "frame-ancestors": ["'self'"] }"#,
            r#""csp": { "connect-src": ["https://evil.example"] }"#,
            r#""csp": { "img-src": ["'unsafe-inline'"] }"#,
            r#""csp": { "connect-src": [] }"#,
        ];
        for csp in cases {
            let manifest = format!(
                r#"{{"id":"A/canvas","title":"Canvas","description":"D","type":"viewer",
                    "extensions":["canvas"],"entry":"viewer.html","role":"editor",{csp}}}"#
            );
            assert!(
                parse_plugin("case", &manifest, "", PluginSource::Data, "case", None).is_err(),
                "csp should be rejected: {csp}"
            );
        }
    }

    #[test]
    fn rejects_invalid_viewer_manifests() {
        let cases = [
            r#"{"id":"A/b","title":"T","description":"D","type":"viewer","entry":"viewer.html","role":"renderer"}"#,
            r#"{"id":"A/b","title":"T","description":"D","type":"viewer","extensions":["mermaid"],"entry":"viewer.txt","role":"renderer"}"#,
            r#"{"id":"A/b","title":"T","description":"D","type":"viewer","extensions":["mermaid"],"entry":"../viewer.html","role":"renderer"}"#,
            r#"{"id":"A/b","title":"T","description":"D","type":"viewer","extensions":["mermaid"],"entry":"viewer.html","role":"canvas"}"#,
        ];
        for manifest in cases {
            assert!(
                parse_plugin("case", manifest, "", PluginSource::Data, "case", None).is_err(),
                "manifest should be rejected: {manifest}"
            );
        }
    }

    #[test]
    fn validates_declarative_plugin_ui() {
        let ui = json!({
            "schema": 1,
            "root": {
                "type": "card",
                "title": "Open todos",
                "children": [{
                    "type": "list",
                    "items": [{
                        "title": "Task",
                        "action": { "type": "openNote", "path": "pages/task.md" }
                    }]
                }]
            }
        });
        assert!(validate_plugin_ui(&ui).is_ok());

        let host_components = json!({
            "schema": 1,
            "root": {
                "type": "card",
                "children": [
                    { "type": "markdown", "value": "# Hello" },
                    {
                        "type": "graph",
                        "scope": "all",
                        "includeTags": true,
                        "height": 240
                    }
                ]
            }
        });
        assert!(validate_plugin_ui(&host_components).is_ok());

        let bad_graph = json!({
            "schema": 1,
            "root": { "type": "graph", "height": 20 }
        });
        assert!(validate_plugin_ui(&bad_graph).is_err());

        let bad_action = json!({
            "schema": 1,
            "root": {
                "type": "button",
                "label": "Unsafe",
                "action": { "type": "openExternal", "url": "javascript:alert(1)" }
            }
        });
        assert!(validate_plugin_ui(&bad_action).is_err());

        let bad_node = json!({
            "schema": 1,
            "root": { "type": "script", "text": "nope" }
        });
        assert!(validate_plugin_ui(&bad_node).is_err());
    }

    #[test]
    fn rejects_client_plugins_in_the_server_registry() {
        let dir = tempdir().unwrap();
        let plugin_dir = dir.path().join("plugins").join("client");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"id":"Acme/client","title":"Client","description":"Client only.","type":"client"}"#,
        )
        .unwrap();
        fs::write(
            plugin_dir.join("plugin.js"),
            "return JSON.stringify({items: []});",
        )
        .unwrap();

        let registry = PluginRegistry::new(dir.path()).unwrap();
        let list = registry.list();
        assert!(list.errors.iter().any(|error| error.folder == "client"));
        assert!(!list.plugins.iter().any(|plugin| plugin.id == "Acme/client"));
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
