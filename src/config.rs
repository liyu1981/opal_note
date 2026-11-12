use std::path::PathBuf;

use clap::{Args, Parser};

/// Server-first, self-hosted notes with a Datalog-native index.
#[derive(Debug, Clone, Parser)]
#[command(name = "opalnote", version, about)]
pub struct Cli {
    #[command(flatten)]
    pub serve: ServeArgs,
}

#[derive(Debug, Clone, Args)]
pub struct ServeArgs {
    /// Address to listen on.
    #[arg(long, env = "OPALNOTE_BIND", default_value = "127.0.0.1:7827")]
    pub bind: String,

    /// Directory for the MnesticDB store. Created if missing.
    #[arg(long, env = "OPALNOTE_DATA_DIR", default_value = "./data")]
    pub data_dir: PathBuf,

    /// Optional bearer token required by every `/api` route. Empty disables auth.
    #[arg(long, env = "OPALNOTE_TOKEN")]
    pub token: Option<String>,

    /// Default wall-clock budget for the ad-hoc `/api/query` endpoint, in seconds.
    #[arg(long, env = "OPALNOTE_QUERY_TIMEOUT_SECS", default_value_t = 5.0)]
    pub query_timeout_secs: f64,

    /// Maximum wall-clock budget for one journal plugin run, in seconds.
    #[arg(long, env = "OPALNOTE_PLUGIN_TIMEOUT_SECS", default_value_t = 5.0)]
    pub plugin_timeout_secs: f64,

    /// Allow cross-origin API requests (useful when calling the API from
    /// another origin or a separate frontend host).
    #[arg(long, env = "OPALNOTE_DEV_CORS", default_value_t = false)]
    pub dev_cors: bool,
}

impl ServeArgs {
    pub fn token(&self) -> Option<String> {
        self.token
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(ToOwned::to_owned)
    }
}
