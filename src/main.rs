mod assets;
mod auth;
mod config;
mod error;
mod plugins;
mod routes;
mod state;
mod store;

use std::sync::Arc;

use clap::Parser;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use crate::config::Cli;
use crate::state::AppState;
use crate::store::Store;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();
    let cli = Cli::parse();
    let args = cli.serve;

    let store = Arc::new(Store::open(&args.data_dir, args.query_timeout_secs)?);
    store.ping()?;

    let token = args.token();
    if token.is_none() {
        tracing::warn!(
            "no OPALNOTE_TOKEN configured: the API is open to anyone who can reach the port"
        );
    }

    tracing::debug!(data_dir = %store.data_dir().display(), "store ready");
    let state = AppState::new(
        store,
        token,
        args.query_timeout_secs,
        args.plugin_timeout_secs,
    );
    let app = routes::router(state, args.dev_cors);

    let listener = TcpListener::bind(&args.bind)
        .await
        .map_err(|err| anyhow::anyhow!("binding {}: {err}", args.bind))?;
    let address = listener.local_addr()?;
    tracing::info!(
        address = %address,
        data_dir = %args.data_dir.display(),
        auth = args.token().is_some(),
        "opalnote listening"
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
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
