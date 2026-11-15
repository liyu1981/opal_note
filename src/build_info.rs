//! Compile-time build identity used by `--version` diagnostics and the
//! self-update comparison.

pub const VERSION: &str = env!("OPALNOTE_BUILD_VERSION");
pub const COMMIT: &str = env!("OPALNOTE_BUILD_COMMIT");
pub const CHANNEL: &str = env!("OPALNOTE_BUILD_CHANNEL");
pub const COMMIT_TIME: &str = env!("OPALNOTE_BUILD_COMMIT_TIME");

/// Commit timestamp (Unix seconds). Build.rs always sets this, but malformed
/// values degrade to zero so diagnostics never fail.
pub fn commit_time() -> i64 {
    COMMIT_TIME.parse().unwrap_or(0)
}

pub const LONG_VERSION: &str = concat!(
    env!("OPALNOTE_BUILD_VERSION"),
    " (",
    env!("OPALNOTE_BUILD_CHANNEL"),
    " ",
    env!("OPALNOTE_BUILD_COMMIT"),
    ", ",
    env!("OPALNOTE_BUILD_COMMIT_TIME"),
    ")"
);
