use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, Response};
use axum::Json;

use crate::error::{ApiResult, AppError};
use crate::plugins::{is_safe_viewer_path, viewer_csp_for, JournalPluginResult, PluginList};
use crate::routes::db_call;
use crate::state::AppState;

pub async fn journal(
    State(state): State<AppState>,
    Path(notebook_id): Path<String>,
) -> ApiResult<Json<Vec<JournalPluginResult>>> {
    let timeout = state.plugin_timeout_secs;
    let store = state.store.clone();
    let plugins = state.plugins.clone();
    let results = db_call(
        move || -> anyhow::Result<Option<Vec<JournalPluginResult>>> {
            if !store.notebook_exists(&notebook_id)? {
                return Ok(None);
            }
            Ok(Some(plugins.run_journal(&store, &notebook_id, timeout)))
        },
        AppError::Internal,
    )
    .await?
    .ok_or_else(|| AppError::not_found("notebook not found"))?;

    Ok(Json(results))
}

pub async fn list(State(state): State<AppState>) -> Json<PluginList> {
    Json(state.plugins.list())
}

pub async fn reload(State(state): State<AppState>) -> ApiResult<Json<PluginList>> {
    let plugins = state.plugins.clone();
    let list = db_call(move || plugins.reload(), AppError::Internal).await?;
    Ok(Json(list))
}

/// File types a viewer bundle may serve. Anything else is a 404, so
/// `plugin.json` and handler sources can never leak through this route.
fn viewer_content_type(path: &str) -> Option<&'static str> {
    // Manifest and build metadata are not bundle assets (suwu makes the same
    // split: handler sources and package.json never have a static route).
    let name = path.rsplit('/').next().unwrap_or(path);
    if matches!(name, "plugin.json" | "package.json" | "build.json")
        || path.split('/').any(|part| part.starts_with('.'))
    {
        return None;
    }
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    Some(match extension.as_str() {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "txt" => "text/plain; charset=utf-8",
        // Excalidraw's font subsetter compiles a wasm module; streaming
        // instantiation requires this exact type.
        "wasm" => "application/wasm",
        _ => return None,
    })
}

fn sanitize_host(raw: &str) -> Option<String> {
    let host: String = raw
        .trim()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | ':' | '-' | '[' | ']'))
        .collect();
    (!host.is_empty()).then_some(host)
}

/// Candidate hosts for CSP sources.
///
/// Same-origin viewers rely on `'self'`, so the Host header only matters for
/// opaque-sandbox data viewers. Proxies that rewrite `Host` are covered by
/// `X-Forwarded-Host` / `Forwarded`, and `--csp-host` (or
/// `OPALNOTE_CSP_HOSTS`) is the escape hatch for anything else.
fn csp_hosts(headers: &HeaderMap, configured: &[String]) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    let mut push = |value: &str| {
        if let Some(host) = sanitize_host(value) {
            if !hosts.contains(&host) {
                hosts.push(host);
            }
        }
    };

    for header_name in ["x-forwarded-host", "x-original-host"] {
        if let Some(value) = headers.get(header_name).and_then(|v| v.to_str().ok()) {
            if let Some(first) = value.split(',').next() {
                push(first);
            }
        }
    }
    if let Some(value) = headers.get(header::FORWARDED).and_then(|v| v.to_str().ok()) {
        for part in value.split(',') {
            for pair in part.split(';') {
                if let Some((name, value)) = pair.trim().split_once('=') {
                    if name.eq_ignore_ascii_case("host") {
                        push(value.trim_matches('"'));
                    }
                }
            }
        }
    }
    if let Some(value) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) {
        push(value);
    }
    for value in configured {
        push(value);
    }
    if hosts.is_empty() {
        hosts.push("localhost".to_string());
    }
    hosts
}

/// Whether a CORS origin may read viewer assets. Viewers run in an opaque
/// origin (`Origin: null`); a same-origin request (module scripts from a
/// non-sandboxed preview) echoes the app's own origin.
fn allowed_cors_origin(headers: &HeaderMap, host: &str) -> Option<String> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())?
        .trim();
    if origin == "null" {
        return Some("null".to_string());
    }
    let rest = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))?;
    (rest == host).then(|| origin.to_string())
}

/// Public viewer bundle files (`/static/plugins/<domain>/<ext>/<path>`).
///
/// Unauthenticated like suwu's extension static route: viewer bundles are
/// client-shipped code (never secrets), and an opaque-origin frame cannot send
/// cookies for ES-module or font fetches. Documents get a host-scoped CSP;
/// module scripts and fonts get `Access-Control-Allow-Origin: null`.
pub async fn static_file(
    State(state): State<AppState>,
    Path((domain, extension, path)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> ApiResult<Response<Body>> {
    if !is_safe_viewer_path(&path) {
        return Err(AppError::bad_request("invalid viewer file path"));
    }
    let Some(content_type) = viewer_content_type(&path) else {
        return Err(AppError::not_found("viewer file not found"));
    };
    let id = format!("{domain}/{extension}");
    let plugins = state.plugins.clone();
    let rel = path.clone();
    let lookup_id = id.clone();
    let bytes = db_call(
        move || plugins.viewer_file(&lookup_id, &rel),
        AppError::Internal,
    )
    .await?;
    let Some(bytes) = bytes else {
        return Err(AppError::not_found("viewer file not found"));
    };

    let hosts = csp_hosts(&headers, &state.csp_hosts);
    let mut response = Response::new(Body::from(bytes));
    let out = response.headers_mut();
    out.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    out.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if let Some(origin) = allowed_cors_origin(&headers, &hosts[0]) {
        if let Ok(value) = HeaderValue::from_str(&origin) {
            out.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
            out.insert(header::VARY, HeaderValue::from_static("Origin"));
        }
    }
    if path.ends_with(".html") || path.ends_with(".htm") {
        let plugins = state.plugins.clone();
        let extra_id = id.clone();
        let extra = db_call(
            move || Ok(plugins.viewer_csp_extra(&extra_id)),
            AppError::Internal,
        )
        .await?;
        let sandbox_id = id.clone();
        let plugins = state.plugins.clone();
        let sandbox = db_call(
            move || Ok(plugins.viewer_sandbox(&sandbox_id)),
            AppError::Internal,
        )
        .await?;
        let csp = viewer_csp_for(&hosts, &id, &sandbox, &extra);
        out.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_str(&csp)
                .unwrap_or_else(|_| HeaderValue::from_static("default-src 'none'")),
        );
        out.insert(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("SAMEORIGIN"),
        );
    }
    Ok(response)
}
