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
    /// Extra host[:port] values trusted by the viewer CSP (proxy deployments).
    pub csp_hosts: Vec<String>,
    pub started_at: Instant,
    pub version: &'static str,
}

/// Everything `AppState::new` needs, assembled once during startup.
pub struct AppStateInit {
    pub store: Arc<Store>,
    pub settings: Arc<SettingsStore>,
    pub plugins: Arc<PluginRegistry>,
    pub backgrounds: Arc<BackgroundRegistry>,
    pub sessions: Arc<SessionStore>,
    pub token: Option<String>,
    pub secure_cookies: bool,
    pub query_timeout_secs: f64,
    pub plugin_timeout_secs: f64,
    /// Extra host[:port] values trusted by the viewer CSP (proxy deployments).
    pub csp_hosts: Vec<String>,
}

impl AppState {
    pub fn new(init: AppStateInit) -> Self {
        Self {
            store: init.store,
            settings: init.settings,
            plugins: init.plugins,
            backgrounds: init.backgrounds,
            sessions: init.sessions,
            token: init.token.map(Arc::from),
            secure_cookies: init.secure_cookies,
            query_timeout_secs: init.query_timeout_secs,
            plugin_timeout_secs: init.plugin_timeout_secs,
            csp_hosts: init.csp_hosts,
            started_at: Instant::now(),
            version: crate::build_info::VERSION,
        }
    }
}
