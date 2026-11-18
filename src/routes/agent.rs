//! HTTP surface of the server-side agent proxy.
//!
//! `GET /agent` tells the client whether the OpalNote provider is available and
//! which models it offers; `GET|POST /agent/v1/{*path}` relays the agent's model
//! traffic to the configured upstream (see `crate::agent`).

use std::io::Read;

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, Method, Response, StatusCode};
use axum::Json;
use serde::Serialize;
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::ReceiverStream;

use crate::error::{ApiResult, AppError};
use crate::state::AppState;

/// Chunks buffered between the upstream reader and the response body.
const STREAM_CHANNEL: usize = 16;
/// Largest request body forwarded upstream (chat payloads, not uploads).
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize)]
pub struct AgentInfo {
    /// True when an upstream endpoint is configured on the server.
    configured: bool,
    /// Model ids the provider advertises.
    models: Vec<String>,
}

pub async fn info(State(state): State<AppState>) -> ApiResult<Json<AgentInfo>> {
    let agent = state.agent.as_ref();
    Ok(Json(AgentInfo {
        configured: agent.is_some(),
        models: agent
            .map(|agent| agent.models().to_vec())
            .unwrap_or_default(),
    }))
}

pub async fn proxy(
    State(state): State<AppState>,
    method: Method,
    Path(path): Path<String>,
    body: Bytes,
) -> ApiResult<Response<Body>> {
    let agent = state
        .agent
        .clone()
        .ok_or_else(|| AppError::not_found("the OpalNote agent provider is not configured"))?;
    let path = path.trim_start_matches('/').to_string();
    if !agent.path_allowed(&path) {
        return Err(AppError::not_found("unsupported agent endpoint"));
    }
    if !matches!(method, Method::GET | Method::POST) {
        return Err(AppError::bad_request("method not allowed"));
    }
    if body.len() > MAX_REQUEST_BYTES {
        return Err(AppError::PayloadTooLarge(
            "agent request is too large".to_string(),
        ));
    }
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

    // The upstream client is blocking, so the request and the byte relay both
    // live on a blocking task; the response streams as chunks arrive.
    tokio::task::spawn_blocking(move || {
        match agent.send(&method_name, &path, payload.as_deref()) {
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
