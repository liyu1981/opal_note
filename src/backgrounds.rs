//! Background registry.
//!
//! Backgrounds are declarative plugins: a folder holds `background.json` and
//! optional assets. Built-in backgrounds live in `builtin/backgrounds/` and
//! are embedded into release builds; user backgrounds live in
//! `<data-dir>/backgrounds/`. The client renders supported `kind` values and
//! fetches image assets through the authenticated API.
//!
//! Built-in ids always win over a data folder with the same id. Invalid
//! folders are reported instead of breaking the whole registry.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

use anyhow::{bail, Context as _, Result};
#[cfg(not(debug_assertions))]
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MANIFEST_FILE: &str = "background.json";
const MAX_MANIFEST_BYTES: usize = 16 * 1024;
const MAX_OPTIONS_BYTES: usize = 32 * 1024;
const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ID_CHARS: usize = 96;
const MAX_TITLE_CHARS: usize = 120;
const MAX_DESCRIPTION_CHARS: usize = 500;
const MAX_KIND_CHARS: usize = 40;

const SUPPORTED_KINDS: &[&str] = &[
    "none",
    "dot-grid",
    "image",
    "gradient",
    "galaxy",
    "grid-scan",
    "letter-glitch",
    "shape-grid",
];

#[cfg(not(debug_assertions))]
#[derive(RustEmbed)]
#[folder = "builtin/backgrounds/"]
struct BuiltinBackgroundAssets;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackgroundSource {
    Builtin,
    Data,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackgroundInfo {
    pub id: String,
    pub title: String,
    pub description: String,
    pub kind: String,
    pub options: Value,
    pub source: BackgroundSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackgroundLoadError {
    pub folder: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackgroundList {
    pub directory: String,
    pub backgrounds: Vec<BackgroundInfo>,
    pub errors: Vec<BackgroundLoadError>,
}

#[derive(Debug, Clone)]
enum Location {
    Builtin(String),
    Data(PathBuf),
}

#[derive(Debug, Clone)]
struct BackgroundDefinition {
    info: BackgroundInfo,
    location: Location,
}

#[derive(Default, Clone)]
struct RegistryState {
    backgrounds: Vec<BackgroundDefinition>,
    errors: Vec<BackgroundLoadError>,
}

/// Loaded background registry. Reload swaps the state atomically; readers keep
/// using the snapshot they already resolved.
pub struct BackgroundRegistry {
    directory: PathBuf,
    state: RwLock<RegistryState>,
}

impl BackgroundRegistry {
    pub fn new(data_dir: &Path) -> Result<Self> {
        let directory = data_dir.join("backgrounds");
        fs::create_dir_all(&directory)
            .with_context(|| format!("creating background directory {}", directory.display()))?;
        let state = load_registry(&directory)?;
        Ok(Self {
            directory,
            state: RwLock::new(state),
        })
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn list(&self) -> BackgroundList {
        let state = self
            .state
            .read()
            .unwrap_or_else(|poison| poison.into_inner());
        BackgroundList {
            directory: self.directory.display().to_string(),
            backgrounds: state
                .backgrounds
                .iter()
                .map(|background| background.info.clone())
                .collect(),
            errors: state.errors.clone(),
        }
    }

    pub fn reload(&self) -> Result<BackgroundList> {
        let state = load_registry(&self.directory)?;
        *self
            .state
            .write()
            .unwrap_or_else(|poison| poison.into_inner()) = state;
        Ok(self.list())
    }

    /// Read an asset from a background folder. Only normalized relative paths
    /// inside the registered folder are accepted.
    pub fn read_asset(&self, id: &str, path: &str) -> Result<Option<(Vec<u8>, String)>> {
        let definition = {
            let state = self
                .state
                .read()
                .unwrap_or_else(|poison| poison.into_inner());
            state
                .backgrounds
                .iter()
                .find(|background| background.info.id == id)
                .cloned()
        };
        let Some(definition) = definition else {
            return Ok(None);
        };

        let Some(relative) = safe_relative_path(path) else {
            bail!("invalid background asset path");
        };

        let bytes = match &definition.location {
            Location::Builtin(folder) => {
                let embedded = format!("{folder}/{relative}");
                match read_builtin(&embedded) {
                    Ok(bytes) => bytes,
                    Err(_) => return Ok(None),
                }
            }
            Location::Data(root) => {
                let root = match fs::canonicalize(root) {
                    Ok(root) => root,
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                    Err(err) => return Err(err.into()),
                };
                let absolute = root.join(&relative);
                let absolute = match fs::canonicalize(&absolute) {
                    Ok(path) => path,
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                    Err(err) => return Err(err.into()),
                };
                if !absolute.starts_with(&root) {
                    bail!("background asset escapes its folder");
                }
                let metadata = fs::metadata(&absolute)?;
                if !metadata.is_file() {
                    return Ok(None);
                }
                if metadata.len() > MAX_ASSET_BYTES {
                    bail!("background asset must be at most {MAX_ASSET_BYTES} bytes");
                }
                fs::read(&absolute)?
            }
        };
        if bytes.len() as u64 > MAX_ASSET_BYTES {
            bail!("background asset must be at most {MAX_ASSET_BYTES} bytes");
        }
        let mime = mime_guess::from_path(&relative)
            .first_or_octet_stream()
            .essence_str()
            .to_string();
        Ok(Some((bytes, mime)))
    }
}

fn load_registry(directory: &Path) -> Result<RegistryState> {
    let mut backgrounds = BTreeMap::new();
    let mut errors = Vec::new();

    for background in load_builtin_backgrounds()? {
        backgrounds.insert(background.info.id.clone(), background);
    }

    for (folder, result) in load_data_backgrounds(directory) {
        match result {
            Ok(background) => {
                if let Some(existing) = backgrounds.get(&background.info.id) {
                    let reason = match existing.info.source {
                        BackgroundSource::Builtin => "a built-in background",
                        BackgroundSource::Data => "another data background",
                    };
                    errors.push(BackgroundLoadError {
                        folder,
                        message: format!(
                            "background id `{}` conflicts with {reason}",
                            background.info.id
                        ),
                    });
                } else {
                    backgrounds.insert(background.info.id.clone(), background);
                }
            }
            Err(err) => errors.push(BackgroundLoadError {
                folder,
                message: format!("{err:#}"),
            }),
        }
    }

    Ok(RegistryState {
        backgrounds: backgrounds.into_values().collect(),
        errors,
    })
}

fn load_builtin_backgrounds() -> Result<Vec<BackgroundDefinition>> {
    let mut folders = BTreeSet::new();
    for path in builtin_paths()? {
        if let Some(folder) = path.strip_suffix(&format!("/{MANIFEST_FILE}")) {
            folders.insert(folder.to_string());
        }
    }

    let mut backgrounds = Vec::new();
    for folder in folders {
        let manifest = read_builtin(&format!("{folder}/{MANIFEST_FILE}"))
            .with_context(|| format!("reading built-in background manifest `{folder}`"))?;
        let manifest = std::str::from_utf8(&manifest)
            .with_context(|| format!("built-in background manifest `{folder}` is not UTF-8"))?;
        let info = parse_manifest(
            &folder,
            manifest,
            BackgroundSource::Builtin,
            Some(format!("builtin/backgrounds/{folder}")),
        )?;
        let definition = BackgroundDefinition {
            info,
            location: Location::Builtin(folder.clone()),
        };
        validate_asset(&definition)?;
        backgrounds.push(definition);
    }
    Ok(backgrounds)
}

fn load_data_backgrounds(directory: &Path) -> Vec<(String, Result<BackgroundDefinition>)> {
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
            let manifest = read_text(&path.join(MANIFEST_FILE), MAX_MANIFEST_BYTES)?;
            let info = parse_manifest(
                &folder,
                &manifest,
                BackgroundSource::Data,
                Some(path.display().to_string()),
            )?;
            let definition = BackgroundDefinition {
                info,
                location: Location::Data(path.clone()),
            };
            validate_asset(&definition)?;
            Ok(definition)
        })();
        results.push((folder, result));
    }
    results.sort_by(|left, right| left.0.cmp(&right.0));
    results
}

fn parse_manifest(
    folder: &str,
    manifest_raw: &str,
    source: BackgroundSource,
    path: Option<String>,
) -> Result<BackgroundInfo> {
    let manifest: BackgroundManifest = serde_json::from_str(manifest_raw)
        .with_context(|| format!("parsing {MANIFEST_FILE} for `{folder}`"))?;

    let id = manifest.id.trim();
    if id.is_empty() || id.chars().count() > MAX_ID_CHARS || !valid_background_id(id) {
        bail!(
            "background `{folder}` has an invalid id; use `<domain>/<extension>` with letters, digits, `-`, `_`, and `.`"
        );
    }
    let title = manifest.title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
        bail!("background `{folder}` title must be 1-{MAX_TITLE_CHARS} characters");
    }
    let description = manifest.description.trim();
    if description.is_empty() || description.chars().count() > MAX_DESCRIPTION_CHARS {
        bail!("background `{folder}` description must be 1-{MAX_DESCRIPTION_CHARS} characters");
    }
    let kind = manifest.kind.trim();
    if kind.is_empty() || kind.chars().count() > MAX_KIND_CHARS || !SUPPORTED_KINDS.contains(&kind)
    {
        bail!(
            "background `{folder}` has unsupported kind `{kind}`; expected one of {}",
            SUPPORTED_KINDS.join(", ")
        );
    }
    let options = manifest.options;
    if !options.is_object() {
        bail!("background `{folder}` options must be a JSON object");
    }
    if serde_json::to_vec(&options)?.len() > MAX_OPTIONS_BYTES {
        bail!("background `{folder}` options must be at most {MAX_OPTIONS_BYTES} bytes");
    }

    Ok(BackgroundInfo {
        id: id.to_string(),
        title: title.to_string(),
        description: description.to_string(),
        kind: kind.to_string(),
        options,
        source,
        path,
    })
}

#[derive(Deserialize)]
struct BackgroundManifest {
    id: String,
    title: String,
    description: String,
    kind: String,
    #[serde(default = "empty_object")]
    options: Value,
}

fn empty_object() -> Value {
    Value::Object(serde_json::Map::new())
}

fn validate_asset(definition: &BackgroundDefinition) -> Result<()> {
    if definition.info.kind != "image" {
        return Ok(());
    }
    let Some(asset) = definition.info.options.get("asset").and_then(Value::as_str) else {
        bail!(
            "background `{}` uses kind `image` but its options have no `asset` path",
            definition.info.id
        );
    };
    let Some(relative) = safe_relative_path(asset) else {
        bail!(
            "background `{}` has an invalid asset path",
            definition.info.id
        );
    };
    match &definition.location {
        Location::Builtin(folder) => {
            let path = format!("{folder}/{relative}");
            if !builtin_paths()?.iter().any(|candidate| candidate == &path) {
                bail!(
                    "background `{}` asset `{asset}` was not found",
                    definition.info.id
                );
            }
        }
        Location::Data(root) => {
            let path = root.join(&relative);
            if !path.is_file() {
                bail!(
                    "background `{}` asset `{asset}` was not found",
                    definition.info.id
                );
            }
        }
    }
    Ok(())
}

fn valid_background_id(id: &str) -> bool {
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

fn safe_relative_path(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.contains('\\') || trimmed.starts_with('/') {
        return None;
    }
    let parsed = Path::new(trimmed);
    if parsed
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    Some(
        parsed
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

fn read_text(path: &Path, max_bytes: usize) -> Result<String> {
    let raw = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    if raw.len() > max_bytes {
        bail!("{} must be at most {max_bytes} bytes", path.display());
    }
    String::from_utf8(raw).with_context(|| format!("{} is not UTF-8", path.display()))
}

#[cfg(debug_assertions)]
fn builtin_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("builtin/backgrounds")
}

#[cfg(not(debug_assertions))]
fn builtin_paths() -> Result<Vec<String>> {
    Ok(BuiltinBackgroundAssets::iter()
        .map(|path| path.into_owned())
        .collect())
}

#[cfg(debug_assertions)]
fn builtin_paths() -> Result<Vec<String>> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                walk(root, &path, out)?;
            } else if entry.file_type()?.is_file() {
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .components()
                    .map(|component| component.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push(rel);
            }
        }
        Ok(())
    }

    let root = builtin_root();
    let mut paths = Vec::new();
    walk(&root, &root, &mut paths)?;
    paths.sort();
    Ok(paths)
}

#[cfg(not(debug_assertions))]
fn read_builtin(path: &str) -> Result<Vec<u8>> {
    Ok(BuiltinBackgroundAssets::get(path)
        .with_context(|| format!("missing embedded built-in background file `{path}`"))?
        .data
        .into_owned())
}

#[cfg(debug_assertions)]
fn read_builtin(path: &str) -> Result<Vec<u8>> {
    fs::read(builtin_root().join(path))
        .with_context(|| format!("reading built-in background file `{path}`"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_background(root: &Path, folder: &str, manifest: &str, asset: Option<&str>) {
        let dir = root.join("backgrounds").join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MANIFEST_FILE), manifest).unwrap();
        if let Some(asset) = asset {
            fs::write(dir.join(asset), b"asset").unwrap();
        }
    }

    #[test]
    fn loads_builtins_and_data_backgrounds() {
        let dir = tempdir().unwrap();
        write_background(
            dir.path(),
            "mine",
            r#"{"id":"Acme/mine","title":"Mine","description":"A test background.","kind":"dot-grid","options":{"gap":24}}"#,
            None,
        );
        let registry = BackgroundRegistry::new(dir.path()).unwrap();
        let list = registry.list();
        assert!(list
            .backgrounds
            .iter()
            .any(|background| background.id == "OpalNote/dot-grid"));
        assert!(list
            .backgrounds
            .iter()
            .any(|background| background.id == "OpalNote/plain"));
        assert!(list.backgrounds.iter().any(|background| {
            background.id == "Acme/mine" && background.source == BackgroundSource::Data
        }));
        assert!(list.errors.is_empty());
    }

    #[test]
    fn data_background_cannot_shadow_a_builtin_id() {
        let dir = tempdir().unwrap();
        write_background(
            dir.path(),
            "shadow",
            r#"{"id":"OpalNote/dot-grid","title":"Shadow","description":"Nope.","kind":"none"}"#,
            None,
        );
        let registry = BackgroundRegistry::new(dir.path()).unwrap();
        let list = registry.list();
        assert!(list.errors.iter().any(|error| error.folder == "shadow"));
        assert_eq!(
            list.backgrounds
                .iter()
                .filter(|background| background.id == "OpalNote/dot-grid")
                .count(),
            1
        );
    }

    #[test]
    fn image_background_requires_its_asset() {
        let dir = tempdir().unwrap();
        write_background(
            dir.path(),
            "missing",
            r#"{"id":"Acme/missing","title":"Missing","description":"No asset.","kind":"image","options":{"asset":"nope.jpg"}}"#,
            None,
        );
        write_background(
            dir.path(),
            "present",
            r#"{"id":"Acme/present","title":"Present","description":"Has asset.","kind":"image","options":{"asset":"photo.jpg"}}"#,
            Some("photo.jpg"),
        );
        let registry = BackgroundRegistry::new(dir.path()).unwrap();
        let list = registry.list();
        assert!(list.backgrounds.iter().any(|background| {
            background.id == "Acme/present" && background.source == BackgroundSource::Data
        }));
        assert!(list.errors.iter().any(|error| error.folder == "missing"));

        let (bytes, mime) = registry
            .read_asset("Acme/present", "photo.jpg")
            .unwrap()
            .unwrap();
        assert_eq!(bytes, b"asset");
        assert!(mime.starts_with("image/"));
        assert!(registry.read_asset("Acme/present", "../secret").is_err());
    }

    #[test]
    fn rejects_unknown_kinds() {
        let dir = tempdir().unwrap();
        write_background(
            dir.path(),
            "weird",
            r#"{"id":"Acme/weird","title":"Weird","description":"Nope.","kind":"magic"}"#,
            None,
        );
        let registry = BackgroundRegistry::new(dir.path()).unwrap();
        assert!(registry
            .list()
            .errors
            .iter()
            .any(|error| error.folder == "weird"));
    }
}
