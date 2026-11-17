use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, Response};
use axum::Json;

use crate::error::{ApiResult, AppError};
use crate::plugins::{is_safe_viewer_path, JournalPluginResult, PluginList};
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

/// Frame-friendly CSP for viewer bundles. The app's static handler sends
/// `X-Frame-Options: DENY` + `frame-ancestors 'none'`; viewer files must be
/// embeddable by the app itself, and they get no network access.
const VIEWER_CSP: &str = "default-src 'none'; \
script-src 'self'; \
style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob:; \
font-src 'self' data:; \
connect-src 'none'; \
frame-ancestors 'self'";

/// Serve one file of a viewer plugin bundle.
pub async fn file(
    State(state): State<AppState>,
    Path((domain, extension, path)): Path<(String, String, String)>,
) -> ApiResult<Response<Body>> {
    if !is_safe_viewer_path(&path) {
        return Err(AppError::bad_request("invalid viewer file path"));
    }
    let id = format!("{domain}/{extension}");
    let plugins = state.plugins.clone();
    let rel = path.clone();
    let bytes = db_call(
        move || plugins.viewer_file(&id, &rel),
        AppError::Internal,
    )
    .await?;
    let Some(bytes) = bytes else {
        return Err(AppError::not_found("viewer file not found"));
    };
    let mime = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(VIEWER_CSP),
    );
    Ok(response)
}
