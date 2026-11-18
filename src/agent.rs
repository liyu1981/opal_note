//! Server-side proxy for the in-app agent's model traffic.
//!
//! The web client runs the agent loop in the browser, but the model endpoint is
//! reached through this proxy so the upstream credential stays on the server
//! and browser CORS rules stop mattering. Only an allow-listed set of
//! OpenAI/Anthropic-compatible paths is forwarded, the client can never set the
//! upstream URL or auth header, and streaming responses are relayed as they
//! arrive.

use std::io::Read;
use std::time::Duration;

use anyhow::{bail, Result};

/// Endpoints the agent may reach. Everything else is refused, so the proxy
/// cannot be turned into a general-purpose forwarder.
const ALLOWED_PATHS: &[&str] = &[
    "models",
    "chat/completions",
    "responses",
    "messages",
    "messages/count_tokens",
];

/// Upstream request/streaming behaviour, resolved from server config.
pub struct AgentProxy {
    base_url: String,
    api_key: Option<String>,
    models: Vec<String>,
}

pub struct UpstreamResponse {
    pub status: u16,
    pub content_type: String,
    pub reader: Box<dyn Read + Send>,
}

impl AgentProxy {
    /// Build the proxy from raw config values; `None` when no base URL is set.
    pub fn new(base_url: &str, api_key: Option<String>, models: Vec<String>) -> Option<Self> {
        let base_url = normalize_base_url(base_url);
        if base_url.is_empty() {
            return None;
        }
        let mut seen = std::collections::BTreeSet::new();
        let models = models
            .into_iter()
            .map(|model| model.trim().to_string())
            .filter(|model| !model.is_empty() && seen.insert(model.to_ascii_lowercase()))
            .collect();
        Some(Self {
            base_url,
            api_key: api_key
                .map(|key| key.trim().to_string())
                .filter(|key| !key.is_empty()),
            models,
        })
    }

    /// Model ids advertised to the client (the provider's picker entries).
    pub fn models(&self) -> &[String] {
        &self.models
    }

    pub fn path_allowed(&self, path: &str) -> bool {
        ALLOWED_PATHS.contains(&path)
    }

    pub fn endpoint(&self, path: &str) -> String {
        format!("{}/{}", self.base_url, path)
    }

    /// Perform the upstream request. Blocking: callers run this on a blocking
    /// task and relay `reader` from there.
    pub fn send(&self, method: &str, path: &str, body: Option<&str>) -> Result<UpstreamResponse> {
        if !self.path_allowed(path) {
            bail!("unsupported agent endpoint `{path}`");
        }
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            // Per-read budget: a long generation may pause between chunks.
            .timeout_read(Duration::from_secs(300))
            .build();
        let url = self.endpoint(path);
        let mut request = agent.request(method, &url);
        request = request
            .set("accept", "text/event-stream, application/json")
            .set("user-agent", "OpalNote");
        if let Some(key) = self.api_key.as_deref() {
            request = request.set("authorization", &format!("Bearer {key}"));
        }
        let response = match body {
            Some(body) => {
                let request = request.set("content-type", "application/json");
                request.send_string(body)
            }
            None => request.call(),
        };
        let response = match response {
            Ok(response) => response,
            Err(ureq::Error::Status(_, response)) => response,
            Err(err) => return Err(anyhow::anyhow!("agent upstream request failed: {err}")),
        };
        let status = response.status();
        let content_type = response
            .header("content-type")
            .unwrap_or("application/json")
            .to_string();
        let reader = response.into_reader();
        Ok(UpstreamResponse {
            status,
            content_type,
            reader,
        })
    }
}

/// Trim whitespace and trailing slashes so `{base}/{path}` never doubles up.
fn normalize_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy() -> AgentProxy {
        AgentProxy::new(
            " https://openrouter.ai/api/v1/ ",
            Some(" sk-or-key ".to_string()),
            vec![
                "openai/gpt-4o-mini".to_string(),
                " openai/gpt-4o-mini ".to_string(),
                "".to_string(),
                "anthropic/claude-3.5".to_string(),
            ],
        )
        .expect("proxy")
    }

    #[test]
    fn empty_base_url_disables_the_proxy() {
        assert!(AgentProxy::new("   ", None, vec![]).is_none());
    }

    #[test]
    fn normalizes_url_and_model_list() {
        let proxy = proxy();
        assert_eq!(
            proxy.endpoint("chat/completions"),
            "https://openrouter.ai/api/v1/chat/completions"
        );
        assert_eq!(
            proxy.models(),
            [
                "openai/gpt-4o-mini".to_string(),
                "anthropic/claude-3.5".to_string()
            ]
        );
    }

    #[test]
    fn only_allow_listed_paths_are_forwarded() {
        let proxy = proxy();
        assert!(proxy.path_allowed("models"));
        assert!(proxy.path_allowed("chat/completions"));
        // No traversal or absolute URLs.
        assert!(!proxy.path_allowed("../secrets"));
        assert!(!proxy.path_allowed("https://evil.example/v1"));
        assert!(!proxy.path_allowed(""));
        assert!(proxy.send("GET", "../secrets", None).is_err());
    }
}
