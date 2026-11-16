mod assets;
mod auth;
mod backgrounds;
mod build_info;
mod config;
mod error;
mod plugins;
mod routes;
mod session;
mod settings;
mod state;
mod store;
mod update;

use std::sync::Arc;

use std::net::SocketAddr;
use std::time::Duration;

use axum_server::tls_rustls::RustlsConfig;
use axum_server::Handle;
use clap::Parser;
use tracing_subscriber::EnvFilter;

use crate::backgrounds::BackgroundRegistry;
use crate::config::{Cli, Command};
use crate::plugins::PluginRegistry;
use crate::session::SessionStore;
use crate::settings::SettingsStore;
use crate::state::AppState;
use crate::store::Store;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();
    let cli = Cli::parse();

    let serve = match cli.command {
        Command::Serve(args) => args,
        Command::Update(args) => {
            let args = args.resolve(cli.config.as_deref())?;
            let channel = update::UpdateChannel::parse(&args.update_channel)?;
            update::run_update(&args.update_dir, &args.update_repo, channel)?;
            return Ok(());
        }
        Command::Config(args) => {
            config::run_config(args, cli.config.as_deref())?;
            return Ok(());
        }
        Command::InstallService(args) => {
            config::run_install_service(args, cli.config.as_deref())?;
            return Ok(());
        }
    };

    let args = serve.resolve(cli.config.as_deref())?;

    if !args.no_self_update && !cfg!(debug_assertions) {
        match update::apply_pending(&args.update_dir) {
            Ok(Some(update)) => tracing::info!(
                version = %update.version,
                commit = %update.commit,
                commit_time = update.commit_time,
                "self-update applied; restart to run the new binary"
            ),
            Ok(None) => {}
            Err(err) => tracing::warn!(error = %err, "self-update check failed"),
        }
    }

    let store = Arc::new(Store::open(&args.data_dir, args.query_timeout_secs)?);
    store.ping()?;
    let settings = Arc::new(SettingsStore::new(&args.data_dir)?);
    tracing::debug!(path = %settings.path().display(), "settings ready");
    let plugins = Arc::new(PluginRegistry::new(&args.data_dir)?);
    tracing::debug!(path = %plugins.directory().display(), "plugins ready");
    let backgrounds = Arc::new(BackgroundRegistry::new(&args.data_dir)?);
    tracing::debug!(path = %backgrounds.directory().display(), "backgrounds ready");
    let sessions = Arc::new(SessionStore::new(crate::session::SESSION_TTL));

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
        backgrounds,
        sessions,
        token,
        !args.no_tls,
        args.query_timeout_secs,
        args.plugin_timeout_secs,
    );
    spawn_trash_purger(state.clone());
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

/// Permanently remove expired trash entries even when nobody opens the bin.
/// The first tick runs immediately, so startup also applies the current
/// retention setting.
fn spawn_trash_purger(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(3_600));
        loop {
            ticker.tick().await;
            let settings = state.settings.clone();
            let store = state.store.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                let days = settings.trash_retention_days();
                store.purge_expired_trash(days)
            })
            .await;
            match outcome {
                Ok(Ok(0)) => {}
                Ok(Ok(removed)) => {
                    tracing::info!(removed, "permanently deleted expired trash entries");
                }
                Ok(Err(err)) => tracing::warn!(error = %err, "trash purge failed"),
                Err(err) => tracing::warn!(error = %err, "trash purge task failed"),
            }
        }
    });
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
