use std::sync::Arc;
use std::time::Instant;

use crate::backgrounds::BackgroundRegistry;
use crate::plugins::PluginRegistry;
use crate::session::SessionStore;
use crate::settings::SettingsStore;
use crate::store::Store;

/// Shared, cheap-to-clone application state. The store itself is `Sync` and
/// internally multiplexes transactions, so a single instance serves all tasks.
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub settings: Arc<SettingsStore>,
    pub plugins: Arc<PluginRegistry>,
    pub backgrounds: Arc<BackgroundRegistry>,
    pub sessions: Arc<SessionStore>,
    pub token: Option<Arc<str>>,
    pub secure_cookies: bool,
    pub query_timeout_secs: f64,
    pub plugin_timeout_secs: f64,
    pub started_at: Instant,
    pub version: &'static str,
}

impl AppState {
    pub fn new(
        store: Arc<Store>,
        settings: Arc<SettingsStore>,
        plugins: Arc<PluginRegistry>,
        backgrounds: Arc<BackgroundRegistry>,
        sessions: Arc<SessionStore>,
        token: Option<String>,
        secure_cookies: bool,
        query_timeout_secs: f64,
        plugin_timeout_secs: f64,
    ) -> Self {
        Self {
            store,
            settings,
            plugins,
            backgrounds,
            sessions,
            token: token.map(Arc::from),
            secure_cookies,
            query_timeout_secs,
            plugin_timeout_secs,
            started_at: Instant::now(),
            version: env!("CARGO_PKG_VERSION"),
        }
    }
}
