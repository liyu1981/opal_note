use std::sync::Arc;
use std::time::Instant;

use crate::store::Store;

/// Shared, cheap-to-clone application state. The store itself is `Sync` and
/// internally multiplexes transactions, so a single instance serves all tasks.
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub token: Option<Arc<str>>,
    pub query_timeout_secs: f64,
    pub plugin_timeout_secs: f64,
    pub started_at: Instant,
    pub version: &'static str,
}

impl AppState {
    pub fn new(
        store: Arc<Store>,
        token: Option<String>,
        query_timeout_secs: f64,
        plugin_timeout_secs: f64,
    ) -> Self {
        Self {
            store,
            token: token.map(Arc::from),
            query_timeout_secs,
            plugin_timeout_secs,
            started_at: Instant::now(),
            version: env!("CARGO_PKG_VERSION"),
        }
    }
}
