mod assets;
mod auth;
mod config;
mod error;
mod plugins;
mod routes;
mod settings;
mod state;
mod store;

use std::sync::Arc;

use std::net::SocketAddr;
use std::time::Duration;

use axum_server::tls_rustls::RustlsConfig;
use axum_server::Handle;
use clap::Parser;
use tracing_subscriber::EnvFilter;

use crate::config::{Cli, Command};
use crate::plugins::PluginRegistry;
use crate::settings::SettingsStore;
use crate::state::AppState;
use crate::store::Store;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();
    let cli = Cli::parse();

    if let Some(command) = cli.command {
        match command {
            Command::Config(args) => config::run_config(args, cli.config.as_deref())?,
            Command::InstallService(args) => {
                config::run_install_service(args, cli.config.as_deref())?
            }
        }
        return Ok(());
    }

    let args = cli.serve.resolve(cli.config.as_deref())?;

    let store = Arc::new(Store::open(&args.data_dir, args.query_timeout_secs)?);
    store.ping()?;
    let settings = Arc::new(SettingsStore::new(&args.data_dir)?);
    tracing::debug!(path = %settings.path().display(), "settings ready");
    let plugins = Arc::new(PluginRegistry::new(&args.data_dir)?);
    tracing::debug!(path = %plugins.directory().display(), "plugins ready");

    let token = args.token();
    if token.is_none() {
        tracing::warn!(
            "no OPALNOTE_TOKEN configured: the API is open to anyone who can reach the port"
        );
    }

    tracing::debug!(data_dir = %store.data_dir().display(), "store ready");
    let state = AppState::new(
        store,
        settings,
        plugins,
        token,
        args.query_timeout_secs,
        args.plugin_timeout_secs,
    );
    let app = routes::router(state, args.dev_cors);

    let address: SocketAddr = args
        .bind
        .parse()
        .map_err(|err| anyhow::anyhow!("invalid bind address {}: {err}", args.bind))?;
    let scheme = if args.no_tls { "http" } else { "https" };
    tracing::info!(
        address = %address,
        scheme = scheme,
        data_dir = %args.data_dir.display(),
        auth = args.token().is_some(),
        "opalnote listening"
    );

    let handle = Handle::new();
    let shutdown_handle = handle.clone();
    tokio::spawn(async move {
        shutdown_signal().await;
        shutdown_handle.graceful_shutdown(Some(Duration::from_secs(10)));
    });

    if args.no_tls {
        axum_server::bind(address)
            .handle(handle)
            .serve(app.into_make_service())
            .await?;
    } else {
        let tls = RustlsConfig::from_pem_file(&args.tls_cert, &args.tls_key)
            .await
            .map_err(|err| {
                anyhow::anyhow!(
                    "loading TLS certificate {} / key {}: {err}; run `pnpm certs` to generate local certificates, or pass --no-tls",
                    args.tls_cert.display(),
                    args.tls_key.display()
                )
            })?;
        axum_server::bind_rustls(address, tls)
            .handle(handle)
            .serve(app.into_make_service())
            .await?;
    }
    tracing::info!("opalnote stopped");
    Ok(())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("opalnote=info,tower_http=warn"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(err) => tracing::error!(error = %err, "failed to install SIGTERM handler"),
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
