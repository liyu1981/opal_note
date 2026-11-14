use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use serde::{Deserialize, Serialize};
use toml::Value;

pub const CONFIG_VERSION: u32 = 1;

const DEFAULT_BIND: &str = "127.0.0.1:7827";
const DEFAULT_DATA_DIR: &str = "./data";
const DEFAULT_TLS_CERT: &str = "certs/localhost.pem";
const DEFAULT_TLS_KEY: &str = "certs/localhost-key.pem";
const DEFAULT_QUERY_TIMEOUT: f64 = 5.0;
const DEFAULT_PLUGIN_TIMEOUT: f64 = 5.0;

/// Server-first, self-hosted notes with a Datalog-native index.
#[derive(Debug, Clone, Parser)]
#[command(name = "opalnote", version, about)]
pub struct Cli {
    /// Configuration file. Defaults to ~/.opalnote/config.
    #[arg(long, global = true, value_name = "PATH")]
    pub config: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Option<Command>,

    #[command(flatten)]
    pub serve: ServeArgs,
}

#[derive(Debug, Clone, Subcommand)]
pub enum Command {
    /// Write a default config, or upgrade an existing config in place.
    Config(ConfigArgs),
    /// Install a systemd user service for OpalNote.
    InstallService(InstallServiceArgs),
}

#[derive(Debug, Clone, Args)]
pub struct ConfigArgs {
    /// Config file path. Defaults to ./config.
    #[arg(long, value_name = "PATH")]
    pub path: Option<PathBuf>,

    /// Upgrade an existing config, keeping values that are already set.
    #[arg(long)]
    pub upgrade: bool,

    /// Overwrite an existing config when generating.
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, Clone, Args)]
pub struct InstallServiceArgs {
    /// Data directory used by the service.
    #[arg(long, value_name = "PATH")]
    pub data_dir: Option<PathBuf>,

    /// Binary to run. Defaults to the current executable.
    #[arg(long, value_name = "PATH")]
    pub binary: Option<PathBuf>,

    /// Replace an existing service file.
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, Clone, Args, Default)]
pub struct ServeArgs {
    /// Address to listen on.
    #[arg(long)]
    pub bind: Option<String>,

    /// Directory for the MnesticDB store. Created if missing.
    #[arg(long)]
    pub data_dir: Option<PathBuf>,

    /// Optional bearer token required by every `/api` route. Empty disables auth.
    #[arg(long)]
    pub token: Option<String>,

    /// Default wall-clock budget for the ad-hoc `/api/query` endpoint, in seconds.
    #[arg(long)]
    pub query_timeout_secs: Option<f64>,

    /// Maximum wall-clock budget for one journal plugin run, in seconds.
    #[arg(long)]
    pub plugin_timeout_secs: Option<f64>,

    /// Disable HTTPS and serve plain HTTP (development only).
    #[arg(long = "no-tls")]
    pub no_tls: bool,

    /// PEM certificate chain used for HTTPS.
    #[arg(long = "tls-cert")]
    pub tls_cert: Option<PathBuf>,

    /// PEM private key used for HTTPS.
    #[arg(long = "tls-key")]
    pub tls_key: Option<PathBuf>,

    /// Allow cross-origin API requests.
    #[arg(long)]
    pub dev_cors: bool,
}

#[derive(Debug, Clone)]
pub struct ResolvedServeArgs {
    pub bind: String,
    pub data_dir: PathBuf,
    pub token: Option<String>,
    pub query_timeout_secs: f64,
    pub plugin_timeout_secs: f64,
    pub no_tls: bool,
    pub tls_cert: PathBuf,
    pub tls_key: PathBuf,
    pub dev_cors: bool,
}

impl ResolvedServeArgs {
    pub fn token(&self) -> Option<String> {
        self.token
            .as_deref()
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .map(ToOwned::to_owned)
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
struct FileConfig {
    version: Option<u32>,
    #[serde(alias = "OPALNOTE_BIND")]
    bind: Option<String>,
    #[serde(alias = "OPALNOTE_DATA_DIR")]
    data_dir: Option<PathBuf>,
    #[serde(alias = "OPALNOTE_TOKEN")]
    token: Option<String>,
    #[serde(alias = "OPALNOTE_QUERY_TIMEOUT_SECS")]
    query_timeout_secs: Option<f64>,
    #[serde(alias = "OPALNOTE_PLUGIN_TIMEOUT_SECS")]
    plugin_timeout_secs: Option<f64>,
    #[serde(alias = "OPALNOTE_NO_TLS")]
    no_tls: Option<bool>,
    #[serde(alias = "OPALNOTE_TLS_CERT")]
    tls_cert: Option<PathBuf>,
    #[serde(alias = "OPALNOTE_TLS_KEY")]
    tls_key: Option<PathBuf>,
    #[serde(alias = "OPALNOTE_DEV_CORS")]
    dev_cors: Option<bool>,
}

#[derive(Debug, Clone, Default)]
struct EnvConfig {
    bind: Option<String>,
    data_dir: Option<PathBuf>,
    token: Option<String>,
    query_timeout_secs: Option<f64>,
    plugin_timeout_secs: Option<f64>,
    no_tls: Option<bool>,
    tls_cert: Option<PathBuf>,
    tls_key: Option<PathBuf>,
    dev_cors: Option<bool>,
}

impl ServeArgs {
    pub fn resolve(self, config: Option<&Path>) -> Result<ResolvedServeArgs> {
        let file = load_file_config(config)?;
        let env = EnvConfig::read()?;

        let no_tls = if self.no_tls {
            true
        } else if let Some(value) = env.no_tls {
            value
        } else {
            file.no_tls.unwrap_or(false)
        };
        let dev_cors = if self.dev_cors {
            true
        } else if let Some(value) = env.dev_cors {
            value
        } else {
            file.dev_cors.unwrap_or(false)
        };

        Ok(ResolvedServeArgs {
            bind: self
                .bind
                .or(env.bind)
                .or(file.bind)
                .unwrap_or_else(|| DEFAULT_BIND.to_string()),
            data_dir: expand_home(
                self.data_dir
                    .or(env.data_dir)
                    .or(file.data_dir)
                    .unwrap_or_else(|| PathBuf::from(DEFAULT_DATA_DIR)),
            ),
            token: self.token.or(env.token).or(file.token),
            query_timeout_secs: self
                .query_timeout_secs
                .or(env.query_timeout_secs)
                .or(file.query_timeout_secs)
                .unwrap_or(DEFAULT_QUERY_TIMEOUT),
            plugin_timeout_secs: self
                .plugin_timeout_secs
                .or(env.plugin_timeout_secs)
                .or(file.plugin_timeout_secs)
                .unwrap_or(DEFAULT_PLUGIN_TIMEOUT),
            no_tls,
            tls_cert: expand_home(
                self.tls_cert
                    .or(env.tls_cert)
                    .or(file.tls_cert)
                    .unwrap_or_else(|| PathBuf::from(DEFAULT_TLS_CERT)),
            ),
            tls_key: expand_home(
                self.tls_key
                    .or(env.tls_key)
                    .or(file.tls_key)
                    .unwrap_or_else(|| PathBuf::from(DEFAULT_TLS_KEY)),
            ),
            dev_cors,
        })
    }
}

impl EnvConfig {
    fn read() -> Result<Self> {
        Ok(Self {
            bind: env::var("OPALNOTE_BIND").ok(),
            data_dir: env::var_os("OPALNOTE_DATA_DIR").map(PathBuf::from),
            token: env::var("OPALNOTE_TOKEN").ok(),
            query_timeout_secs: env_f64("OPALNOTE_QUERY_TIMEOUT_SECS")?,
            plugin_timeout_secs: env_f64("OPALNOTE_PLUGIN_TIMEOUT_SECS")?,
            no_tls: env_bool("OPALNOTE_NO_TLS")?,
            tls_cert: env::var_os("OPALNOTE_TLS_CERT").map(PathBuf::from),
            tls_key: env::var_os("OPALNOTE_TLS_KEY").map(PathBuf::from),
            dev_cors: env_bool("OPALNOTE_DEV_CORS")?,
        })
    }
}

fn load_file_config(explicit: Option<&Path>) -> Result<FileConfig> {
    let (path, required) = match explicit {
        Some(path) => (expand_home(path), true),
        None => (default_config_path()?, false),
    };
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound && !required => {
            return Ok(FileConfig::default());
        }
        Err(err) => {
            return Err(err).with_context(|| format!("reading config {}", path.display()));
        }
    };
    let file: FileConfig =
        toml::from_str(&raw).with_context(|| format!("parsing config {}", path.display()))?;
    if let Some(version) = file.version {
        if version > CONFIG_VERSION {
            bail!(
                "config {} uses version {version}, but this OpalNote supports version {CONFIG_VERSION}",
                path.display()
            );
        }
    }
    Ok(file)
}

pub fn default_config_path() -> Result<PathBuf> {
    Ok(home_dir()?.join(".opalnote").join("config"))
}

pub fn run_config(args: ConfigArgs, global_config: Option<&Path>) -> Result<()> {
    let path = args
        .path
        .or_else(|| global_config.map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("config"));
    let path = expand_home(&path);

    if args.upgrade {
        let raw = fs::read_to_string(&path)
            .with_context(|| format!("reading config {}", path.display()))?;
        let existing: Value =
            toml::from_str(&raw).with_context(|| format!("parsing config {}", path.display()))?;
        let mut upgraded = default_config_value();
        merge_values(&mut upgraded, existing);
        if let Some(table) = upgraded.as_table_mut() {
            table.insert("version".to_string(), Value::Integer(CONFIG_VERSION as i64));
        }
        write_config(&path, &upgraded)?;
        println!("Upgraded {}", path.display());
    } else {
        if path.exists() && !args.force {
            bail!(
                "{} already exists; use --upgrade or --force",
                path.display()
            );
        }
        let value = default_config_value();
        write_config(&path, &value)?;
        println!("Wrote default config to {}", path.display());
    }
    Ok(())
}

pub fn run_install_service(args: InstallServiceArgs, global_config: Option<&Path>) -> Result<()> {
    if !cfg!(target_os = "linux") {
        bail!("install-service is only supported on Linux");
    }

    let home = home_dir()?;
    let config = expand_home(
        global_config
            .map(Path::to_path_buf)
            .unwrap_or(default_config_path()?),
    );
    let data_dir = expand_home(
        args.data_dir
            .unwrap_or_else(|| home.join(".opalnote").join("data")),
    );
    let binary = match args.binary {
        Some(path) => expand_home(&path),
        None => env::current_exe().context("finding the current executable")?,
    };
    let config_home = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    let service_dir = config_home.join("systemd").join("user");
    let service_path = service_dir.join("opalnote.service");

    fs::create_dir_all(&service_dir)
        .with_context(|| format!("creating {}", service_dir.display()))?;
    fs::create_dir_all(&data_dir).with_context(|| format!("creating {}", data_dir.display()))?;
    fs::create_dir_all(config.parent().unwrap_or(&home))
        .with_context(|| format!("creating {}", home.display()))?;

    if service_path.exists() && !args.force {
        bail!(
            "{} already exists; use --force to replace it",
            service_path.display()
        );
    }

    let service = format!(
        "[Unit]\n\
         Description=OpalNote\n\
         After=network.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         WorkingDirectory={data}\n\
         ExecStart={binary} --config {config} --data-dir {data}\n\
         Restart=on-failure\n\
         RestartSec=3\n\
         Environment=RUST_LOG=opalnote=info,tower_http=warn\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        binary = systemd_quote(&binary),
        config = systemd_quote(&config),
        data = data_dir.display(),
    );
    fs::write(&service_path, service)
        .with_context(|| format!("writing {}", service_path.display()))?;

    println!("Wrote {}", service_path.display());
    println!("Data directory: {}", data_dir.display());
    println!("Config file: {}", config.display());
    println!();
    println!("Enable it with:");
    println!("  systemctl --user daemon-reload");
    println!("  systemctl --user enable --now opalnote.service");
    Ok(())
}

fn default_config_value() -> Value {
    let mut table = toml::map::Map::new();
    table.insert("version".to_string(), Value::Integer(CONFIG_VERSION as i64));
    table.insert("bind".to_string(), Value::String(DEFAULT_BIND.to_string()));
    table.insert(
        "data_dir".to_string(),
        Value::String(DEFAULT_DATA_DIR.to_string()),
    );
    table.insert("token".to_string(), Value::String(String::new()));
    table.insert(
        "query_timeout_secs".to_string(),
        Value::Float(DEFAULT_QUERY_TIMEOUT),
    );
    table.insert(
        "plugin_timeout_secs".to_string(),
        Value::Float(DEFAULT_PLUGIN_TIMEOUT),
    );
    table.insert("no_tls".to_string(), Value::Boolean(false));
    table.insert(
        "tls_cert".to_string(),
        Value::String(DEFAULT_TLS_CERT.to_string()),
    );
    table.insert(
        "tls_key".to_string(),
        Value::String(DEFAULT_TLS_KEY.to_string()),
    );
    table.insert("dev_cors".to_string(), Value::Boolean(false));
    Value::Table(table)
}

fn merge_values(base: &mut Value, existing: Value) {
    match (base, existing) {
        (Value::Table(base_table), Value::Table(existing_table)) => {
            for (key, value) in existing_table {
                if let Some(base_value) = base_table.get_mut(&key) {
                    merge_values(base_value, value);
                } else {
                    base_table.insert(key, value);
                }
            }
        }
        (base, existing) => *base = existing,
    }
}

fn write_config(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
    let raw = toml::to_string_pretty(value).context("serializing config")?;
    fs::write(path, raw).with_context(|| format!("writing {}", path.display()))
}

fn expand_home(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    let Some(raw) = path.to_str() else {
        return path.to_path_buf();
    };
    if raw == "~" {
        return home_dir().unwrap_or_else(|_| path.to_path_buf());
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Ok(home) = home_dir() {
            return home.join(rest);
        }
    }
    path.to_path_buf()
}

fn home_dir() -> Result<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("HOME is not set"))
}

fn env_bool(key: &str) -> Result<Option<bool>> {
    let Some(raw) = env::var_os(key) else {
        return Ok(None);
    };
    let value = raw.to_string_lossy().trim().to_ascii_lowercase();
    match value.as_str() {
        "" => Ok(None),
        "1" | "true" | "yes" | "on" => Ok(Some(true)),
        "0" | "false" | "no" | "off" => Ok(Some(false)),
        _ => bail!("{key} must be a boolean"),
    }
}

fn env_f64(key: &str) -> Result<Option<f64>> {
    let Some(raw) = env::var_os(key) else {
        return Ok(None);
    };
    let value = raw.to_string_lossy().trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    value
        .parse::<f64>()
        .map(Some)
        .with_context(|| format!("{key} must be a number"))
}

fn systemd_quote(path: &Path) -> String {
    let value = path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!("\"{value}\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn generated_config_round_trips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config");
        write_config(&path, &default_config_value()).unwrap();
        let file: FileConfig = toml::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(file.version, Some(CONFIG_VERSION));
        assert_eq!(file.bind.as_deref(), Some(DEFAULT_BIND));
    }

    #[test]
    fn upgrade_keeps_existing_values_and_unknown_keys() {
        let mut upgraded = default_config_value();
        let existing: Value =
            toml::from_str("version = 0\nbind = \"0.0.0.0:9999\"\ncustom = \"kept\"\n").unwrap();
        merge_values(&mut upgraded, existing);
        let table = upgraded.as_table().unwrap();
        assert_eq!(table.get("bind").unwrap().as_str(), Some("0.0.0.0:9999"));
        assert_eq!(table.get("custom").unwrap().as_str(), Some("kept"));
    }

    #[test]
    fn explicit_missing_config_is_an_error() {
        let dir = tempdir().unwrap();
        assert!(load_file_config(Some(&dir.path().join("missing"))).is_err());
    }
}
