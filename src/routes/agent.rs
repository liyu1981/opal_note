//! HTTP surface of the agent provider.
//!
//! - `GET /agent` reports whether a provider is configured and what it looks
//!   like (never the key).
//! - `PUT /agent/config` stores a browser-made envelope; `DELETE` forgets it.
//! - `GET|POST /agent/v1/{*path}` relays model traffic to the configured
//!   upstream, decrypting the stored key with the caller's derived key
//!   (`x-opalnote-agent-key`) for that one request.

use std::io::Read;

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, Response, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::ReceiverStream;

use crate::agent;
use crate::error::{ApiResult, AppError};
use crate::routes::db_call;
use crate::state::AppState;
use crate::system_db::StoredAgentConfig;

/// Header carrying the password-derived key for one request.
pub const AGENT_KEY_HEADER: &str = "x-opalnote-agent-key";

/// Chunks buffered between the upstream reader and the response body.
const STREAM_CHANNEL: usize = 16;
/// Largest request body forwarded upstream (chat payloads, not uploads).
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
/// Models a configuration may advertise.
const MAX_MODELS: usize = 100;

#[derive(Serialize)]
pub struct AgentInfo {
    /// True when a provider has been configured through the app.
    configured: bool,
    /// Model ids the provider advertises.
    models: Vec<String>,
    /// The stored connection, without the key.
    stored: Option<StoredAgentInfo>,
}

#[derive(Serialize)]
pub struct StoredAgentInfo {
    base_url: String,
    models: Vec<String>,
    /// True when the row carries a key envelope (not a keyless local server).
    key_stored: bool,
    /// The envelope itself (AES-GCM ciphertext): useless without the password,
    /// and needed by any device that wants to unlock the provider.
    key_envelope: Option<String>,
    updated_at: i64,
}

#[derive(Deserialize)]
pub struct AgentConfigRequest {
    base_url: String,
    #[serde(default)]
    models: Vec<String>,
    /// Envelope from `agentCrypto.encryptApiKey`; omitted or null for a
    /// keyless endpoint (a local OpenAI-compatible server).
    #[serde(default)]
    key_envelope: Option<String>,
}

pub async fn info(State(state): State<AppState>) -> ApiResult<Json<AgentInfo>> {
    let system = state.system.clone();
    let stored = db_call(move || system.agent_config(), AppError::Internal).await?;
    Ok(Json(AgentInfo {
        configured: stored.is_some(),
        models: stored
            .as_ref()
            .map(|config| config.models.clone())
            .unwrap_or_default(),
        stored: stored.map(stored_info),
    }))
}

pub async fn put_config(
    State(state): State<AppState>,
    Json(body): Json<AgentConfigRequest>,
) -> ApiResult<Json<AgentInfo>> {
    let base_url = agent::normalize_base_url(&body.base_url)
        .map_err(|err| AppError::bad_request(format!("{err:#}")))?;
    let envelope = body.key_envelope.unwrap_or_default();
    if !envelope.is_empty() {
        // Validate the shape now instead of failing on the first chat request.
        serde_json::from_str::<serde_json::Value>(&envelope)
            .map_err(|_| AppError::bad_request("agent key envelope is not valid JSON"))?;
        if envelope.len() > crate::system_db::MAX_ENVELOPE_BYTES {
            return Err(AppError::PayloadTooLarge(
                "agent key envelope is too large".to_string(),
            ));
        }
    }
    let models: Vec<String> = body
        .models
        .into_iter()
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .take(MAX_MODELS)
        .collect();

    let system = state.system.clone();
    let config = StoredAgentConfig {
        base_url: base_url.clone(),
        models: models.clone(),
        key_envelope: envelope.clone(),
        updated_at: 0,
    };
    let stored = db_call(
        move || {
            system.save_agent_config(&config)?;
            system.agent_config()
        },
        AppError::Internal,
    )
    .await?
    .ok_or_else(|| AppError::Internal(anyhow::anyhow!("agent config vanished")))?;

    tracing::info!(
        base_url = %base_url,
        models = models.len(),
        key_stored = !envelope.is_empty(),
        "agent provider configured"
    );
    Ok(Json(AgentInfo {
        configured: true,
        models: stored.models.clone(),
        stored: Some(stored_info(stored)),
    }))
}

pub async fn delete_config(State(state): State<AppState>) -> ApiResult<Json<AgentInfo>> {
    let system = state.system.clone();
    db_call(move || system.clear_agent_config(), AppError::Internal).await?;
    tracing::info!("agent provider configuration removed");
    Ok(Json(AgentInfo {
        configured: false,
        models: Vec::new(),
        stored: None,
    }))
}

pub async fn proxy(
    State(state): State<AppState>,
    method: Method,
    Path(path): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response<Body>> {
    let path = path.trim_start_matches('/').to_string();
    if !matches!(method, Method::GET | Method::POST) {
        return Err(AppError::bad_request("method not allowed"));
    }
    if body.len() > MAX_REQUEST_BYTES {
        return Err(AppError::PayloadTooLarge(
            "agent request is too large".to_string(),
        ));
    }

    let system = state.system.clone();
    let config = db_call(move || system.agent_config(), AppError::Internal)
        .await?
        .ok_or_else(|| AppError::not_found("the agent provider is not configured"))?;

    // Only the allow-listed endpoints are reachable, and a locked provider is
    // reported before any upstream call is attempted.
    if !agent::ALLOWED_PATHS.contains(&path.as_str()) {
        return Err(AppError::not_found("unsupported agent endpoint"));
    }
    let api_key = match decrypt_for_request(&config, &headers) {
        Ok(key) => key,
        Err(message) => {
            // A locked proxy is the one failure a user can fix in the UI, so say
            // plainly which request needed a key and was turned away.
            tracing::warn!(path = %path, %message, "agent request rejected");
            return Err(AppError::AgentLocked(message));
        }
    };
    tracing::info!(
        method = %method,
        path = %path,
        keyed = api_key.is_some(),
        "agent proxy request"
    );

    let payload = if body.is_empty() {
        None
    } else {
        Some(
            String::from_utf8(body.to_vec())
                .map_err(|_| AppError::bad_request("agent request must be UTF-8 JSON"))?,
        )
    };

    let (meta_tx, meta_rx) = oneshot::channel::<(u16, String)>();
    let (chunk_tx, chunk_rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(STREAM_CHANNEL);
    let method_name = method.as_str().to_string();
    let base_url = config.base_url.clone();

    // The upstream client is blocking, so the request and the byte relay both
    // live on a blocking task; the response streams as chunks arrive.
    tokio::task::spawn_blocking(move || {
        match agent::send(
            &base_url,
            api_key.as_deref(),
            &method_name,
            &path,
            payload.as_deref(),
        ) {
            Ok(upstream) => {
                if meta_tx
                    .send((upstream.status, upstream.content_type))
                    .is_err()
                {
                    return;
                }
                relay(upstream.reader, chunk_tx);
            }
            Err(err) => {
                let _ = meta_tx.send((StatusCode::BAD_GATEWAY.as_u16(), "application/json".into()));
                let payload = serde_json::json!({
                    "error": {
                        "code": "upstream_error",
                        "message": format!("{err:#}"),
                    }
                })
                .to_string();
                let _ = chunk_tx.blocking_send(Ok(Bytes::from(payload)));
            }
        }
    });

    let (status, content_type) = meta_rx
        .await
        .map_err(|_| AppError::Internal(anyhow::anyhow!("agent upstream task ended early")))?;
    // The matching `agent proxy request` line above carries the path.
    tracing::info!(status, "agent upstream response");
    let mut response = Response::new(Body::from_stream(ReceiverStream::new(chunk_rx)));
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/json")),
    );
    // Streaming responses must not be buffered or cached anywhere.
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache, no-transform"),
    );
    headers.insert(
        header::HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

/// Resolve the upstream credential for one request: a keyless configuration
/// needs nothing, otherwise the caller must supply the derived key that opens
/// the stored envelope.
fn decrypt_for_request(
    config: &StoredAgentConfig,
    headers: &HeaderMap,
) -> Result<Option<String>, String> {
    if config.key_envelope.is_empty() {
        return Ok(None);
    }
    let derived = headers
        .get(AGENT_KEY_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The OpalNote provider is locked.".to_string())?;
    let key = agent::decrypt_api_key(&config.key_envelope, derived).map_err(|_| {
        "The OpalNote provider could not unlock; enter the password again.".to_string()
    })?;
    Ok(Some(key))
}

fn stored_info(config: StoredAgentConfig) -> StoredAgentInfo {
    StoredAgentInfo {
        base_url: config.base_url,
        models: config.models,
        key_stored: !config.key_envelope.is_empty(),
        key_envelope: (!config.key_envelope.is_empty()).then(|| config.key_envelope.clone()),
        updated_at: config.updated_at,
    }
}

fn relay(mut reader: Box<dyn Read + Send>, tx: mpsc::Sender<Result<Bytes, std::io::Error>>) {
    let mut buffer = [0u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                if tx
                    .blocking_send(Ok(Bytes::copy_from_slice(&buffer[..read])))
                    .is_err()
                {
                    // The client went away (closed tab, stopped generation).
                    break;
                }
            }
            Err(err) => {
                let _ = tx.blocking_send(Err(err));
                break;
            }
        }
    }
}
