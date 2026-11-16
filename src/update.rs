//! Self-update support.
//!
//! `opalnote update` discovers a binary plus manifest and stages it in
//! `<update-dir>/candidate/`. `opalnote serve` only validates and applies an
//! already staged candidate at startup. The running process keeps the old
//! inode; the new version is used on the next restart.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::build_info;

const CANDIDATE_DIR: &str = "candidate";
const DOWNLOAD_DIR: &str = "download";
const MANIFEST_FILE: &str = "manifest.json";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const BINARY_NAME: &str = if cfg!(windows) {
    "opalnote.exe"
} else {
    "opalnote"
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateManifest {
    pub version: String,
    #[serde(default)]
    pub commit: String,
    #[serde(default)]
    pub commit_time: i64,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct AppliedUpdate {
    pub version: String,
    pub commit: String,
    pub commit_time: i64,
}

pub fn candidate_dir(update_dir: &Path) -> PathBuf {
    update_dir.join(CANDIDATE_DIR)
}

pub fn download_dir(update_dir: &Path) -> PathBuf {
    update_dir.join(DOWNLOAD_DIR)
}

/// Recreate the download staging directory.
///
/// Downloads are unpacked into `<update-dir>/download/` so the extracted binary
/// lives next to the candidate instead of a per-process temp directory. The
/// staging area is wiped at the start of a run and again once the candidate has
/// been staged.
fn reset_download_dir(update_dir: &Path) -> Result<PathBuf> {
    let dir = download_dir(update_dir);
    if dir.exists() {
        fs::remove_dir_all(&dir).with_context(|| format!("cleaning up {}", dir.display()))?;
    }
    remove_stale_temp_dirs(update_dir);
    fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    Ok(dir)
}

/// Remove leftovers from older builds and interrupted runs that staged their
/// downloads in per-process `.download-*` / `.candidate-*` directories.
fn remove_stale_temp_dirs(update_dir: &Path) {
    let Ok(entries) = fs::read_dir(update_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(".download-") && !name.starts_with(".candidate-") {
            continue;
        }
        if entry.path().is_dir() {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Check for a newer candidate and apply it to the current executable.
pub fn apply_pending(update_dir: &Path) -> Result<Option<AppliedUpdate>> {
    let target = std::env::current_exe().context("finding the current executable")?;
    apply_pending_to(update_dir, &target)
}

/// Testable form of [`apply_pending`] with an explicit target executable.
pub fn apply_pending_to(update_dir: &Path, target: &Path) -> Result<Option<AppliedUpdate>> {
    let candidate = candidate_dir(update_dir);
    if !candidate.is_dir() {
        return Ok(None);
    }

    let _lock = UpdateLock::acquire(update_dir)?;
    let manifest_path = candidate.join(MANIFEST_FILE);
    if fs::metadata(&manifest_path)?.len() > MAX_MANIFEST_BYTES {
        bail!("update manifest is too large");
    }
    let manifest: CandidateManifest = serde_json::from_reader(
        File::open(&manifest_path)
            .with_context(|| format!("reading {}", manifest_path.display()))?,
    )
    .with_context(|| format!("parsing {}", manifest_path.display()))?;

    let binary = candidate.join(BINARY_NAME);
    if !binary.is_file() {
        bail!("update candidate {} is missing", binary.display());
    }
    let size = fs::metadata(&binary)?.len();
    if size == 0 {
        bail!("update candidate {} is empty", binary.display());
    }
    if let Some(expected) = manifest.size {
        if expected != size {
            bail!("update candidate size mismatch");
        }
    }
    if let Some(expected_target) = manifest.target.as_deref() {
        if !target_matches(expected_target) {
            bail!("update candidate target `{expected_target}` does not match this build");
        }
    }
    if let Some(expected_hash) = manifest.sha256.as_deref() {
        let actual = sha256_file(&binary)?;
        if !actual.eq_ignore_ascii_case(expected_hash.trim()) {
            bail!("update candidate sha256 mismatch");
        }
    }

    let current_version =
        semver::Version::parse(build_info::VERSION).context("parsing the running build version")?;
    let candidate_version = semver::Version::parse(manifest.version.trim_start_matches('v'))
        .context("parsing the update candidate version")?;
    if !is_newer(
        &candidate_version,
        manifest.commit_time,
        &current_version,
        build_info::commit_time(),
    ) {
        tracing::info!(
            version = %manifest.version,
            commit = %manifest.commit,
            "ignoring update candidate that is not newer"
        );
        return Ok(None);
    }

    install_candidate(&binary, target)?;
    let _ = fs::remove_dir_all(&candidate);
    tracing::info!(
        version = %manifest.version,
        commit = %manifest.commit,
        "self-update installed; restart to run the new version"
    );
    Ok(Some(AppliedUpdate {
        version: manifest.version,
        commit: manifest.commit,
        commit_time: manifest.commit_time,
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateChannel {
    Release,
    Dev,
}

impl UpdateChannel {
    pub fn parse(value: &str) -> Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "release" | "stable" => Ok(Self::Release),
            "dev" | "development" | "artifact" => Ok(Self::Dev),
            other => bail!("unknown update channel `{other}`; use release or dev"),
        }
    }
}

/// Discover and stage a newer candidate from GitHub. The user is responsible
/// for authenticating `gh`; no tokens are read or stored by OpalNote.
pub fn check_remote_update(
    update_dir: &Path,
    repo: &str,
    channel: UpdateChannel,
) -> Result<Option<CandidateManifest>> {
    let _lock = UpdateLock::acquire(update_dir)?;

    if let Some(existing) = read_candidate_manifest(update_dir)? {
        if candidate_is_newer(&existing)? {
            tracing::debug!(
                version = %existing.version,
                "using the already downloaded update candidate"
            );
            return Ok(Some(existing));
        }
    }

    let result = stage_candidate(update_dir, repo, channel);
    let _ = fs::remove_dir_all(download_dir(update_dir));
    result
}

fn stage_candidate(
    update_dir: &Path,
    repo: &str,
    channel: UpdateChannel,
) -> Result<Option<CandidateManifest>> {
    let found = match channel {
        UpdateChannel::Release => discover_release_candidate(update_dir, repo)?,
        UpdateChannel::Dev => discover_dev_candidate(update_dir, repo)?,
    };
    let Some((binary, manifest)) = found else {
        return Ok(None);
    };
    if !candidate_is_newer(&manifest)? {
        tracing::info!(
            version = %manifest.version,
            channel = ?channel,
            "latest GitHub candidate is not newer"
        );
        return Ok(None);
    }
    write_candidate(update_dir, &binary, &manifest)?;
    tracing::info!(
        version = %manifest.version,
        commit = %manifest.commit,
        channel = ?channel,
        "downloaded self-update candidate"
    );
    Ok(Some(manifest))
}

/// CLI entry point for `opalnote update`: discover and stage a newer candidate.
/// This does not replace the running binary; the next server restart applies it.
pub fn run_update(update_dir: &Path, repo: &str, channel: UpdateChannel) -> Result<()> {
    let result = check_remote_update(update_dir, repo, channel)?;
    match result {
        Some(manifest) => {
            println!(
                "Downloaded {} ({}) to {}; restart the server to apply it.",
                manifest.version,
                manifest.commit,
                candidate_dir(update_dir).display()
            );
        }
        None => {
            println!(
                "No newer {} update is available for this build.",
                match channel {
                    UpdateChannel::Release => "release",
                    UpdateChannel::Dev => "development",
                }
            );
        }
    }
    Ok(())
}

fn candidate_is_newer(manifest: &CandidateManifest) -> Result<bool> {
    let current_version =
        semver::Version::parse(build_info::VERSION).context("parsing the running build version")?;
    let candidate_version = semver::Version::parse(manifest.version.trim_start_matches('v'))
        .context("parsing the update candidate version")?;
    Ok(is_newer(
        &candidate_version,
        manifest.commit_time,
        &current_version,
        build_info::commit_time(),
    ))
}

fn read_candidate_manifest(update_dir: &Path) -> Result<Option<CandidateManifest>> {
    let path = candidate_dir(update_dir).join(MANIFEST_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    if fs::metadata(&path)?.len() > MAX_MANIFEST_BYTES {
        bail!("update manifest is too large");
    }
    let manifest = serde_json::from_reader(
        File::open(&path).with_context(|| format!("reading {}", path.display()))?,
    )
    .with_context(|| format!("parsing {}", path.display()))?;
    Ok(Some(manifest))
}

fn write_candidate(update_dir: &Path, binary: &Path, manifest: &CandidateManifest) -> Result<()> {
    fs::create_dir_all(update_dir)
        .with_context(|| format!("creating update directory {}", update_dir.display()))?;
    let temp = TempDir::new(update_dir, "candidate")?;
    let dest_binary = temp.path.join(BINARY_NAME);
    fs::copy(binary, &dest_binary)
        .with_context(|| format!("copying update candidate {}", binary.display()))?;
    fs::write(
        temp.path.join(MANIFEST_FILE),
        serde_json::to_vec_pretty(manifest)?,
    )?;
    let destination = candidate_dir(update_dir);
    if destination.exists() {
        fs::remove_dir_all(&destination)?;
    }
    fs::rename(&temp.path, &destination)?;
    Ok(())
}

fn discover_release_candidate(
    update_dir: &Path,
    repo: &str,
) -> Result<Option<(PathBuf, CandidateManifest)>> {
    #[derive(Deserialize)]
    struct Asset {
        name: String,
        browser_download_url: String,
    }
    #[derive(Deserialize)]
    struct ReleaseView {
        tag_name: String,
        #[serde(default)]
        published_at: Option<String>,
        #[serde(default)]
        assets: Vec<Asset>,
    }

    // The public releases API is enough for discovery; it does not need `gh`
    // or a GitHub token. The dev channel still uses the authenticated CLI.
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let response = ureq::get(&url)
        .set("user-agent", "opalnote-updater")
        .set("accept", "application/vnd.github+json")
        .call();
    let response = match response {
        Ok(response) => response,
        Err(ureq::Error::Status(404, _)) => {
            tracing::debug!("no stable GitHub releases found");
            return Ok(None);
        }
        Err(err) => return Err(err.into()),
    };
    let view: ReleaseView = response
        .into_json()
        .with_context(|| format!("parsing release response from {url}"))?;
    let target = target_triple();
    let binary_asset = view
        .assets
        .iter()
        .find(|asset| is_archive_for_target(&asset.name, &target))
        .or_else(|| {
            view.assets.iter().find(|asset| {
                (asset.name.ends_with(".tar.gz") || asset.name.ends_with(".tgz"))
                    && asset.name.contains(std::env::consts::ARCH)
                    && asset.name.contains(std::env::consts::OS)
            })
        })
        .ok_or_else(|| anyhow::anyhow!("release {} has no downloadable archive", view.tag_name))?;
    let manifest_asset = view.assets.iter().find(|asset| {
        asset.name == "manifest.json" || asset.name == format!("manifest-{target}.json")
    });

    let download = reset_download_dir(update_dir)?;
    let archive_name = asset_file_name(&binary_asset.name);
    let archive = download.join(&archive_name);
    download_asset(&binary_asset.browser_download_url, &archive)?;
    if let Some(asset) = manifest_asset {
        download_asset(
            &asset.browser_download_url,
            &download.join(asset_file_name(&asset.name)),
        )?;
    }

    let binary = extract_binary(&archive, &download)?;
    let mut manifest = match manifest_asset.and_then(|_| find_manifest(&download)) {
        Some(path) => {
            let manifest: CandidateManifest = serde_json::from_reader(
                File::open(&path).with_context(|| format!("reading {}", path.display()))?,
            )
            .with_context(|| format!("parsing {}", path.display()))?;
            manifest
        }
        None => CandidateManifest {
            version: view.tag_name.trim_start_matches('v').to_string(),
            commit: String::new(),
            commit_time: parse_time(view.published_at.as_deref()),
            target: Some(target.clone()),
            sha256: None,
            size: None,
        },
    };
    if manifest
        .target
        .as_deref()
        .is_some_and(|value| !target_matches(value))
    {
        bail!("release manifest target does not match this build");
    }
    manifest.target = Some(target);
    manifest.size = Some(fs::metadata(&binary)?.len());
    manifest.sha256 = Some(sha256_file(&binary)?);
    Ok(Some((binary, manifest)))
}

fn asset_file_name(name: &str) -> String {
    name.rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("opalnote-download")
        .to_string()
}

fn download_asset(url: &str, destination: &Path) -> Result<()> {
    let response = ureq::get(url)
        .set("user-agent", "opalnote-updater")
        .call()
        .with_context(|| format!("downloading {url}"))?;
    let mut reader = response.into_reader();
    let mut output =
        File::create(destination).with_context(|| format!("creating {}", destination.display()))?;
    std::io::copy(&mut reader, &mut output)
        .with_context(|| format!("writing {}", destination.display()))?;
    output.sync_all()?;
    Ok(())
}

fn discover_dev_candidate(
    update_dir: &Path,
    repo: &str,
) -> Result<Option<(PathBuf, CandidateManifest)>> {
    #[derive(Deserialize)]
    struct Run {
        id: u64,
        #[serde(rename = "head_sha", default)]
        head_sha: String,
    }
    #[derive(Deserialize)]
    struct Artifact {
        name: String,
        created_at: String,
        #[serde(default)]
        expired: bool,
        #[serde(default)]
        workflow_run: Option<Run>,
    }
    #[derive(Deserialize)]
    struct ArtifactList {
        artifacts: Vec<Artifact>,
    }

    let list: ArtifactList = gh_json(&[
        "api".into(),
        format!("repos/{repo}/actions/artifacts?per_page=100"),
    ])?;
    let arch = std::env::consts::ARCH;
    let Some(artifact) = list
        .artifacts
        .into_iter()
        .filter(|artifact| !artifact.expired)
        .filter(|artifact| artifact.workflow_run.is_some())
        .filter(|artifact| artifact.name.starts_with("opalnote-"))
        .filter(|artifact| artifact.name.ends_with(&format!("-{arch}")))
        .max_by_key(|artifact| artifact.created_at.clone())
    else {
        tracing::debug!("no unexpired development artifacts found");
        return Ok(None);
    };
    let (version, commit) = parse_dev_artifact_name(&artifact.name, arch)
        .ok_or_else(|| anyhow::anyhow!("could not parse development artifact {}", artifact.name))?;
    let Some(run) = artifact.workflow_run else {
        return Ok(None);
    };
    let download = reset_download_dir(update_dir)?;
    gh(&[
        "run".into(),
        "download".into(),
        run.id.to_string(),
        "--repo".into(),
        repo.into(),
        "--name".into(),
        artifact.name.clone(),
        "--dir".into(),
        download.display().to_string(),
    ])?;
    let archive = find_archive(&download)
        .ok_or_else(|| anyhow::anyhow!("downloaded development artifact archive not found"))?;
    let binary = extract_binary(&archive, &download)?;
    let manifest = CandidateManifest {
        version,
        commit: if commit.is_empty() {
            run.head_sha.chars().take(7).collect()
        } else {
            commit
        },
        commit_time: parse_time(Some(&artifact.created_at)),
        target: Some(target_triple()),
        sha256: Some(sha256_file(&binary)?),
        size: Some(fs::metadata(&binary)?.len()),
    };
    Ok(Some((binary, manifest)))
}

fn parse_dev_artifact_name(name: &str, arch: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("opalnote-")?;
    let mut parts = rest.rsplitn(3, '-');
    let artifact_arch = parts.next()?;
    let commit = parts.next()?;
    let version = parts.next()?;
    if artifact_arch != arch || version.is_empty() || commit.is_empty() {
        return None;
    }
    Some((version.to_string(), commit.to_string()))
}

fn is_archive_for_target(name: &str, target: &str) -> bool {
    (name.ends_with(".tar.gz") || name.ends_with(".tgz")) && name.contains(target)
}

fn target_triple() -> String {
    match (std::env::consts::ARCH, std::env::consts::OS) {
        ("aarch64", "linux") => "aarch64-unknown-linux-gnu".to_string(),
        ("x86_64", "linux") => "x86_64-unknown-linux-gnu".to_string(),
        ("aarch64", "macos") => "aarch64-apple-darwin".to_string(),
        ("x86_64", "macos") => "x86_64-apple-darwin".to_string(),
        (arch, os) => format!("{arch}-unknown-{os}-gnu"),
    }
}

fn parse_time(value: Option<&str>) -> i64 {
    value
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp())
        .unwrap_or(0)
}

fn find_archive(root: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_archive(&path) {
                return Some(found);
            }
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".tar.gz") || name.ends_with(".tgz"))
        {
            return Some(path);
        }
    }
    None
}

fn find_manifest(root: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.file_name().and_then(|name| name.to_str()) == Some(MANIFEST_FILE)
        {
            return Some(path);
        }
    }
    None
}

fn extract_binary(archive: &Path, destination: &Path) -> Result<PathBuf> {
    let decoder = flate2::read::GzDecoder::new(File::open(archive)?);
    let mut tar = tar::Archive::new(decoder);
    let target = destination.join(BINARY_NAME);
    for entry in tar.entries()? {
        let mut entry = entry?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path()?.to_string_lossy().replace('\\', "/");
        let name = path.rsplit('/').next().unwrap_or_default();
        if name == BINARY_NAME {
            let mut output = File::create(&target)?;
            std::io::copy(&mut entry, &mut output)?;
            output.sync_all()?;
            return Ok(target);
        }
    }
    bail!(
        "archive {} does not contain {}",
        archive.display(),
        BINARY_NAME
    )
}

fn gh_json<T: for<'de> Deserialize<'de>>(args: &[String]) -> Result<T> {
    let output = gh(args)?;
    serde_json::from_str(&output).context("parsing gh JSON output")
}

fn gh(args: &[String]) -> Result<String> {
    let output = Command::new("gh")
        .args(args)
        .output()
        .with_context(|| "running gh; install GitHub CLI and run `gh auth login`")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("gh failed: {}", stderr.trim());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(parent: &Path, prefix: &str) -> Result<Self> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let path = parent.join(format!(".{prefix}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&path)
            .with_context(|| format!("creating temporary directory {}", path.display()))?;
        Ok(Self { path })
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn is_newer(
    candidate: &semver::Version,
    candidate_time: i64,
    current: &semver::Version,
    current_time: i64,
) -> bool {
    candidate > current || (candidate == current && candidate_time > current_time)
}

fn target_matches(target: &str) -> bool {
    target.contains(std::env::consts::ARCH) && target.contains(std::env::consts::OS)
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn install_candidate(source: &Path, target: &Path) -> Result<()> {
    #[cfg(windows)]
    bail!("self-update is not supported on Windows yet");

    let parent = target
        .parent()
        .context("executable has no parent directory")?;
    let temp = parent.join(format!(
        ".{}.update-{}",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("opalnote"),
        std::process::id()
    ));

    let result = (|| -> Result<()> {
        let mut input = File::open(source)?;
        let mut output = File::create(&temp)?;
        std::io::copy(&mut input, &mut output)?;
        output.flush()?;
        output.sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(target)?.permissions().mode();
            fs::set_permissions(&temp, fs::Permissions::from_mode(mode))?;
        }
        fs::rename(&temp, target)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

struct UpdateLock {
    path: PathBuf,
}

impl UpdateLock {
    fn acquire(update_dir: &Path) -> Result<Self> {
        fs::create_dir_all(update_dir)
            .with_context(|| format!("creating update directory {}", update_dir.display()))?;
        let path = update_dir.join(".update.lock");
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .with_context(|| {
                format!("another update is already in progress ({})", path.display())
            })?;
        Ok(Self { path })
    }
}

impl Drop for UpdateLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_candidate(
        update_dir: &Path,
        version: &str,
        commit_time: i64,
        bytes: &[u8],
    ) -> PathBuf {
        let candidate = candidate_dir(update_dir);
        fs::create_dir_all(&candidate).unwrap();
        let binary = candidate.join(BINARY_NAME);
        fs::write(&binary, bytes).unwrap();
        let manifest = CandidateManifest {
            version: version.to_string(),
            commit: "test".to_string(),
            commit_time,
            target: Some(format!(
                "{}-unknown-{}-gnu",
                std::env::consts::ARCH,
                std::env::consts::OS
            )),
            sha256: Some(sha256_file(&binary).unwrap()),
            size: Some(bytes.len() as u64),
        };
        fs::write(
            candidate.join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        candidate
    }

    #[test]
    fn parses_dev_artifact_names() {
        assert_eq!(
            parse_dev_artifact_name("opalnote-0.1.0-e968d8-aarch64", "aarch64"),
            Some(("0.1.0".to_string(), "e968d8".to_string()))
        );
        assert!(parse_dev_artifact_name("opalnote-0.1.0-e968d8-x86_64", "aarch64").is_none());
        assert!(parse_dev_artifact_name("other-0.1.0-e968d8-aarch64", "aarch64").is_none());
    }

    #[test]
    fn validates_remote_target_archives() {
        assert!(is_archive_for_target(
            "opalnote-0.1.0-aarch64-unknown-linux-gnu.tar.gz",
            "aarch64-unknown-linux-gnu"
        ));
        assert!(!is_archive_for_target(
            "opalnote-0.1.0-x86_64-unknown-linux-gnu.tar.gz",
            "aarch64-unknown-linux-gnu"
        ));
    }

    #[test]
    fn compares_versions_then_commit_times() {
        let current = semver::Version::parse("0.1.0").unwrap();
        assert!(is_newer(
            &semver::Version::parse("0.1.1").unwrap(),
            0,
            &current,
            100
        ));
        assert!(!is_newer(
            &semver::Version::parse("0.0.9").unwrap(),
            1000,
            &current,
            100
        ));
        assert!(is_newer(&current, 101, &current, 100));
        assert!(!is_newer(&current, 100, &current, 100));
        assert!(!is_newer(&current, 99, &current, 100));
    }

    #[test]
    fn resets_the_download_staging_directory() {
        let dir = tempdir().unwrap();
        let updates = dir.path().join("updates");
        let download = download_dir(&updates);
        fs::create_dir_all(&download).unwrap();
        fs::write(download.join("stale.tar.gz"), b"stale").unwrap();

        let fresh = reset_download_dir(&updates).unwrap();
        assert_eq!(fresh, download);
        assert!(fresh.is_dir());
        assert_eq!(fs::read_dir(&fresh).unwrap().count(), 0);
    }

    #[test]
    fn stages_a_candidate_from_the_download_directory() {
        let dir = tempdir().unwrap();
        let updates = dir.path().join("updates");
        let download = reset_download_dir(&updates).unwrap();
        let binary = download.join(BINARY_NAME);
        fs::write(&binary, b"downloaded binary").unwrap();
        let manifest = CandidateManifest {
            version: "9.9.9".to_string(),
            commit: "abc1234".to_string(),
            commit_time: 1,
            target: Some(target_triple()),
            sha256: Some(sha256_file(&binary).unwrap()),
            size: Some(13),
        };

        super::write_candidate(&updates, &binary, &manifest).unwrap();
        let candidate = candidate_dir(&updates);
        assert_eq!(
            fs::read(candidate.join(BINARY_NAME)).unwrap(),
            b"downloaded binary"
        );
        assert!(candidate.join(MANIFEST_FILE).is_file());
    }

    #[test]
    fn installs_a_newer_candidate_and_removes_it() {
        let dir = tempdir().unwrap();
        let updates = dir.path().join("updates");
        let target = dir.path().join("opalnote");
        fs::write(&target, b"old binary").unwrap();
        let candidate = write_candidate(&updates, "0.1.0", i64::MAX, b"new binary");

        let applied = apply_pending_to(&updates, &target).unwrap().unwrap();
        assert_eq!(applied.version, "0.1.0");
        assert_eq!(fs::read(&target).unwrap(), b"new binary");
        assert!(!candidate.exists());
    }

    #[test]
    fn refuses_older_or_bad_candidates() {
        let dir = tempdir().unwrap();
        let updates = dir.path().join("updates");
        let target = dir.path().join("opalnote");
        fs::write(&target, b"old binary").unwrap();

        write_candidate(&updates, "0.0.9", i64::MAX, b"old candidate");
        assert!(apply_pending_to(&updates, &target).unwrap().is_none());
        assert_eq!(fs::read(&target).unwrap(), b"old binary");

        let candidate = write_candidate(&updates, "9.9.9", i64::MAX, b"new candidate");
        let manifest_path = candidate.join(MANIFEST_FILE);
        let mut bad: CandidateManifest =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        bad.sha256 = Some("0".repeat(64));
        fs::write(&manifest_path, serde_json::to_vec(&bad).unwrap()).unwrap();
        assert!(apply_pending_to(&updates, &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old binary");
    }
}
