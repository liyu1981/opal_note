//! Offline self-update support.
//!
//! A future downloader (GitHub releases) writes a binary plus manifest into
//! `<update-dir>/candidate/`. On startup this module validates and atomically
//! replaces the current executable. The running process keeps the old inode;
//! the new version is used on the next restart.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::build_info;

const CANDIDATE_DIR: &str = "candidate";
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

/// Placeholder for the future GitHub release check/downloader.
pub fn check_remote_update_placeholder() -> Result<Option<CandidateManifest>> {
    tracing::debug!("remote update detection is not implemented yet");
    Ok(None)
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
