//! Filesystem primitives for the file-first store.
//!
//! A notebook is a folder:
//!
//! ```text
//! notebooks/<notebook>/
//!   .opalnote.json     optional description
//!   pages/*.md
//!   journals/*.md
//!   assets/*
//! ```
//!
//! Everything in this module is synchronous and assumes the caller holds the
//! store's filesystem lock when mutating.

use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const PAGE_DIR: &str = "pages";
pub const JOURNAL_DIR: &str = "journals";
pub const ASSET_DIR: &str = "assets";
pub const META_FILE: &str = ".opalnote.json";
pub const NOTE_EXT: &str = "md";

const MAX_NAME_CHARS: usize = 180;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NotebookMeta {
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone)]
pub struct PageFile {
    /// Path relative to the notebook root, using `/` separators.
    pub rel: String,
    pub abs: PathBuf,
    pub mtime_ns: i64,
    pub updated_at: f64,
    pub created_at: f64,
    pub size: i64,
}

#[derive(Debug, Clone)]
pub struct AssetFile {
    /// Path relative to the notebook's `assets/` directory.
    pub rel: String,
    pub name: String,
    pub mime: String,
    pub kind: &'static str,
    pub size: i64,
    pub updated_at: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct Times {
    pub created_at: f64,
    pub updated_at: f64,
}

/// Turn a title into a safe single path component.
///
/// Spaces and unicode are preserved; only path separators and control
/// characters are replaced. Leading dots are stripped so notebooks and pages
/// never become hidden files.
pub fn sanitize_name(input: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.trim().chars() {
        if ch == '/' || ch == '\\' || ch == '\0' || ch.is_control() {
            out.push('-');
        } else {
            out.push(ch);
        }
    }

    let mut out = out.trim().trim_matches('.').trim().to_string();
    while out.starts_with('.') {
        out.remove(0);
    }
    let mut out = out.trim().to_string();

    if out.is_empty() || out == "." || out == ".." {
        return fallback.to_string();
    }

    if out.chars().count() > MAX_NAME_CHARS {
        out = out
            .chars()
            .take(MAX_NAME_CHARS)
            .collect::<String>()
            .trim()
            .trim_matches('.')
            .trim()
            .to_string();
        if out.is_empty() {
            return fallback.to_string();
        }
    }
    out
}

pub fn title_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| "Untitled".to_string())
}

/// Pick `stem.ext`, `stem 2.ext`, … so creation never overwrites an existing
/// page.
pub fn unique_file_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let stem = sanitize_name(stem, "Untitled");
    let suffix = |name: &str| {
        if ext.is_empty() {
            dir.join(name)
        } else {
            dir.join(format!("{name}.{ext}"))
        }
    };

    let mut candidate = suffix(&stem);
    let mut index = 2;
    while candidate.exists() && index < 10_000 {
        candidate = suffix(&format!("{stem} {index}"));
        index += 1;
    }
    candidate
}

pub fn write_atomic(path: &Path, contents: &str) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    fs::create_dir_all(parent)?;

    let tmp = parent.join(format!(
        ".opalnote-tmp-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));

    let result = (|| -> io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub fn read_text(path: &Path) -> io::Result<String> {
    let bytes = fs::read(path)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn read_meta(notebook: &Path) -> NotebookMeta {
    let path = notebook.join(META_FILE);
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn remove_meta(notebook: &Path) -> io::Result<()> {
    match fs::remove_file(notebook.join(META_FILE)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

pub fn write_meta(notebook: &Path, description: &str) -> io::Result<()> {
    let meta = NotebookMeta {
        description: description.to_string(),
    };
    let mut raw = serde_json::to_string_pretty(&meta)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    raw.push('\n');
    write_atomic(&notebook.join(META_FILE), &raw)
}

/// Create the canonical notebook layout.
pub fn ensure_layout(notebook: &Path) -> io::Result<()> {
    fs::create_dir_all(notebook)?;
    for dir in [PAGE_DIR, JOURNAL_DIR, ASSET_DIR] {
        fs::create_dir_all(notebook.join(dir))?;
    }
    Ok(())
}

/// Rename legacy Logseq folders (`Pages`, `Journal`) to lowercase.
///
/// If both a legacy and a canonical folder exist, files are merged into the
/// canonical one without overwriting; collisions get a numeric suffix.
pub fn canonicalize_layout(notebook: &Path) -> io::Result<()> {
    for (legacy, canonical) in [
        ("Pages", PAGE_DIR),
        ("Journals", JOURNAL_DIR),
        ("Journal", JOURNAL_DIR),
    ] {
        let from = notebook.join(legacy);
        if !from.is_dir() {
            continue;
        }
        let to = notebook.join(canonical);
        if !to.exists() {
            fs::rename(&from, &to)?;
        } else {
            merge_dir(&from, &to)?;
        }
    }
    Ok(())
}

fn merge_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = to.join(entry.file_name());

        if !target.exists() {
            fs::rename(entry.path(), &target)?;
        } else if file_type.is_dir() && target.is_dir() {
            merge_dir(&entry.path(), &target)?;
        } else if file_type.is_file() {
            let path = entry.path();
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
            let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
            let unique = unique_file_path(to, stem, ext);
            fs::rename(&path, unique)?;
        }
        // Symlinks and other special files are left untouched.
    }
    let _ = fs::remove_dir(from);
    Ok(())
}

pub fn section_dir_for_new_notes(notebook: &Path, journals: bool) -> io::Result<PathBuf> {
    let dir = notebook.join(if journals { JOURNAL_DIR } else { PAGE_DIR });
    if dir.is_dir() {
        return Ok(dir);
    }
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn list_notebook_dirs(notebooks_dir: &Path) -> io::Result<Vec<String>> {
    let mut dirs = Vec::new();
    let entries = match fs::read_dir(notebooks_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(dirs),
        Err(err) => return Err(err),
    };
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        dirs.push(name);
    }
    dirs.sort();
    Ok(dirs)
}

pub fn list_page_files(notebook: &Path) -> io::Result<Vec<PageFile>> {
    let mut files = Vec::new();
    for dir in [PAGE_DIR, JOURNAL_DIR] {
        let root = notebook.join(dir);
        if !root.is_dir() {
            continue;
        }
        walk_pages(&root, notebook, &mut files)?;
    }
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(files)
}

fn walk_pages(root: &Path, notebook: &Path, out: &mut Vec<PageFile>) -> io::Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.is_empty() || name.starts_with('.') {
            continue;
        }

        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_dir() {
            walk_pages(&path, notebook, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        if !path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case(NOTE_EXT))
        {
            continue;
        }

        let metadata = entry.metadata()?;
        let (mtime_ns, updated_at, created_at) = file_times(&metadata);
        out.push(PageFile {
            rel: relative_path(notebook, &path),
            abs: path,
            mtime_ns,
            updated_at,
            created_at,
            size: metadata.len().min(i64::MAX as u64) as i64,
        });
    }
    Ok(())
}

pub fn list_asset_files(notebook: &Path) -> io::Result<Vec<AssetFile>> {
    let root = notebook.join(ASSET_DIR);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    walk_assets(&root, &root, &mut files)?;
    files.sort_by(|left, right| left.rel.cmp(&right.rel));
    Ok(files)
}

fn walk_assets(root: &Path, dir: &Path, out: &mut Vec<AssetFile>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_dir() {
            walk_assets(root, &path, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let metadata = entry.metadata()?;
        let (_, updated_at, _) = file_times(&metadata);
        let mime = asset_mime(&path);
        out.push(AssetFile {
            rel,
            name: path
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default(),
            kind: asset_kind(&mime, &path),
            mime,
            size: metadata.len().min(i64::MAX as u64) as i64,
            updated_at,
        });
    }
    Ok(())
}

pub fn asset_mime(path: &Path) -> String {
    mime_guess::from_path(path)
        .first_or_octet_stream()
        .essence_str()
        .to_string()
}

pub fn asset_file(notebook: &Path, rel: &str) -> io::Result<AssetFile> {
    let absolute = resolve_asset_path(notebook, rel)?;
    let metadata = fs::metadata(&absolute)?;
    let (_, updated_at, _) = file_times(&metadata);
    let mime = asset_mime(&absolute);
    Ok(AssetFile {
        rel: rel.to_string(),
        name: absolute
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default(),
        kind: asset_kind(&mime, &absolute),
        mime,
        size: metadata.len().min(i64::MAX as u64) as i64,
        updated_at,
    })
}

fn asset_kind(mime: &str, path: &Path) -> &'static str {
    if mime.starts_with("image/") {
        return "image";
    }
    if mime.starts_with("video/") {
        return "video";
    }
    if mime.starts_with("audio/") {
        return "audio";
    }
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        ext.as_str(),
        "pdf"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx"
            | "txt"
            | "md"
            | "csv"
            | "json"
            | "zip"
            | "tar"
            | "gz"
    ) {
        "document"
    } else {
        "other"
    }
}

/// Resolve an asset path from an API request, rejecting traversal and files
/// outside the notebook's `assets/` directory.
pub fn resolve_asset_path(notebook: &Path, rel: &str) -> io::Result<PathBuf> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidInput, "invalid asset path");
    if rel.is_empty() || rel.contains('\\') || rel.starts_with('/') {
        return Err(invalid());
    }
    let path = Path::new(rel);
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(invalid());
    }
    let root = notebook.join(ASSET_DIR);
    let absolute = root.join(path);
    if !absolute.is_file() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "asset not found"));
    }
    let root = fs::canonicalize(root)?;
    let absolute = fs::canonicalize(absolute)?;
    if !absolute.starts_with(&root) {
        return Err(invalid());
    }
    Ok(absolute)
}

pub fn relative_path(notebook: &Path, path: &Path) -> String {
    path.strip_prefix(notebook)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Resolve a note path from an API request, rejecting traversal and files
/// outside the canonical page/journal directories.
pub fn resolve_note_path(notebook: &Path, rel: &str) -> io::Result<PathBuf> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidInput, "invalid note path");
    if rel.is_empty() || rel.contains('\\') || rel.starts_with('/') {
        return Err(invalid());
    }

    let path = Path::new(rel);
    let mut components = path.components();
    match components.next() {
        Some(Component::Normal(first)) if first == PAGE_DIR || first == JOURNAL_DIR => {}
        _ => return Err(invalid()),
    }
    for component in components {
        if !matches!(component, Component::Normal(_)) {
            return Err(invalid());
        }
    }
    if !path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(NOTE_EXT))
    {
        return Err(invalid());
    }

    let absolute = notebook.join(path);
    if !absolute.is_file() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "note not found"));
    }

    let notebook = fs::canonicalize(notebook)?;
    let absolute = fs::canonicalize(&absolute)?;
    if !absolute.starts_with(&notebook) {
        return Err(invalid());
    }
    Ok(absolute)
}

/// `(created_at, updated_at)` for one file.
pub fn note_times(path: &Path) -> io::Result<(f64, f64)> {
    let metadata = fs::metadata(path)?;
    let (_, updated_at, created_at) = file_times(&metadata);
    Ok((created_at, updated_at))
}

pub fn notebook_times(notebook: &Path) -> io::Result<Times> {
    let metadata = fs::metadata(notebook)?;
    let (_, updated_at, created_at) = file_times(&metadata);
    Ok(Times {
        created_at,
        updated_at,
    })
}

fn file_times(metadata: &fs::Metadata) -> (i64, f64, f64) {
    let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
    let duration = modified.duration_since(UNIX_EPOCH).unwrap_or_default();
    let mtime_ns = duration.as_nanos().min(i64::MAX as u128) as i64;
    let updated_at = duration.as_secs_f64();

    let created = metadata.created().unwrap_or(modified);
    let created_at = created
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or(updated_at);

    (mtime_ns, updated_at, created_at)
}

/// Move a note file into `data/.trash/notes/<stamp>/<notebook>/<path>`.
pub fn trash_file(
    data_dir: &Path,
    notebook: &str,
    rel: &str,
    absolute: &Path,
) -> io::Result<PathBuf> {
    let destination = data_dir
        .join(".trash")
        .join("notes")
        .join(stamp())
        .join(sanitize_name(notebook, "notebook"))
        .join(rel);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(absolute, &destination)?;
    Ok(destination)
}

/// Move an entire notebook folder into `data/.trash/notebooks/`.
pub fn trash_notebook(data_dir: &Path, notebook: &str, absolute: &Path) -> io::Result<PathBuf> {
    let destination = data_dir.join(".trash").join("notebooks").join(format!(
        "{}-{}",
        stamp(),
        sanitize_name(notebook, "notebook")
    ));
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(absolute, &destination)?;
    Ok(destination)
}

fn stamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| format!("{}-{}", duration.as_secs(), duration.subsec_nanos()))
        .unwrap_or_else(|_| "0-0".to_string())
}
