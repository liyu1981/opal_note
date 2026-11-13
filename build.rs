//! Build script for the single-binary distribution.
//!
//! `web/dist` is embedded into the server binary by `rust-embed`. To keep
//! `cargo build` a one-command experience we build the web client when its
//! output is missing or older than the client sources. Set
//! `OPALNOTE_SKIP_WEB_BUILD=1` to opt out (a placeholder page is embedded if
//! no build exists at all).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

const PLACEHOLDER: &str = r#"<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>OpalNote</title></head>
  <body style="font-family: system-ui; padding: 2rem">
    <h1>OpalNote</h1>
    <p>The web client was not built. Run <code>pnpm --dir web build</code> (or
    <code>pnpm build</code>) and rebuild the server.</p>
  </body>
</html>
"#;

fn main() {
    println!("cargo:rerun-if-changed=web/dist");
    println!("cargo:rerun-if-changed=web/src");
    println!("cargo:rerun-if-changed=web/index.html");
    println!("cargo:rerun-if-changed=web/package.json");
    println!("cargo:rerun-if-env-changed=OPALNOTE_SKIP_WEB_BUILD");

    let dist = Path::new("web/dist");
    let index = dist.join("index.html");
    let exists = index.exists();
    let skip = std::env::var("OPALNOTE_SKIP_WEB_BUILD").as_deref() == Ok("1");

    if exists && !stale(&index) {
        return;
    }

    if skip {
        if !exists {
            write_placeholder(dist, &index);
        } else {
            println!(
                "cargo:warning=OPALNOTE_SKIP_WEB_BUILD=1: using the existing (possibly stale) web/dist"
            );
        }
        return;
    }

    if build_web() {
        return;
    }

    if exists {
        println!("cargo:warning=web build failed; embedding the existing web/dist");
        return;
    }

    panic!(
        "failed to build the web client.\n\
         Run `pnpm --dir web install && pnpm --dir web build` manually, then rebuild.\n\
         To build the Rust side without web assets, set OPALNOTE_SKIP_WEB_BUILD=1."
    );
}

/// True when client sources are newer than the last web build.
fn stale(index: &Path) -> bool {
    let Some(built_at) = modified(index) else {
        return true;
    };

    let mut watched = vec![
        PathBuf::from("web/index.html"),
        PathBuf::from("web/package.json"),
        PathBuf::from("web/vite.config.ts"),
        PathBuf::from("web/tsconfig.json"),
    ];
    watched.extend(walk(Path::new("web/src")));

    watched
        .iter()
        .filter_map(|path| modified(path))
        .any(|source_at| source_at > built_at)
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(walk(&path));
        } else {
            files.push(path);
        }
    }
    files
}

fn build_web() -> bool {
    if !Path::new("web/node_modules").exists() {
        let installed = run(Command::new("pnpm")
            .args(["install", "--frozen-lockfile"])
            .current_dir("web"));
        if !installed {
            return false;
        }
    }

    run(Command::new("pnpm")
        .args(["run", "build"])
        .current_dir("web"))
}

fn run(cmd: &mut Command) -> bool {
    let program = cmd.get_program().to_string_lossy().into_owned();
    match cmd.status() {
        Ok(status) if status.success() => true,
        Ok(status) => {
            println!("cargo:warning=`{program}` exited with {status}");
            false
        }
        Err(error) => {
            println!("cargo:warning=could not run `{program}`: {error}");
            false
        }
    }
}

fn write_placeholder(dist: &Path, index: &Path) {
    let _ = std::fs::create_dir_all(dist);
    let _ = std::fs::write(index, PLACEHOLDER);
}
