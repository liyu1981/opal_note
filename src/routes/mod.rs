pub mod health;
pub mod notebooks;
pub mod notes;
pub mod plugins;
pub mod query;

use anyhow::anyhow;
use axum::routing::{get, post};
use axum::{middleware, Router};
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::auth;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;

pub const MAX_PAGE_LIMIT: usize = 200;
pub const MAX_PAGE_OFFSET: usize = 100_000;
pub const MAX_TITLE_CHARS: usize = 300;
pub const MAX_NAME_CHARS: usize = 120;
pub const MAX_DESCRIPTION_CHARS: usize = 2_000;
pub const MAX_CONTENT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_TAGS: usize = 200;

pub fn router(state: AppState, dev_cors: bool) -> Router {
    // Liveness metadata stays public so a client can discover whether a token
    // is required before it has one.
    let public = Router::new()
        .route("/health", get(health::health))
        .route("/meta", get(health::meta));

    let protected = Router::new()
        .route("/stats", get(health::stats))
        .route("/reindex", post(health::reindex))
        .route("/query", post(query::run))
        .route("/notebooks", get(notebooks::list).post(notebooks::create))
        .route(
            "/notebooks/{id}",
            get(notebooks::get)
                .patch(notebooks::update)
                .delete(notebooks::delete),
        )
        .route(
            "/notebooks/{id}/notes",
            get(notes::list).post(notes::create),
        )
        .route("/notebooks/{id}/pages", get(notes::pages))
        .route("/notebooks/{id}/orphans", get(notes::orphans))
        .route("/notebooks/{id}/graph", get(notes::graph))
        .route("/notebooks/{id}/plugins", get(plugins::journal))
        .route("/notebooks/{id}/search", get(notes::search))
        .route("/notebooks/{id}/journals", get(notes::journals))
        .route("/notebooks/{id}/tags", get(notebooks::tags))
        .route(
            "/notebooks/{id}/notes/{*path}",
            get(notes::get).patch(notes::update).delete(notes::delete),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_token,
        ));

    let api = public.merge(protected);

    let mut app = Router::new()
        .nest("/api", api)
        .fallback(crate::assets::static_handler)
        .with_state(state)
        .layer(tower_http::compression::CompressionLayer::new())
        .layer(TraceLayer::new_for_http());

    if dev_cors {
        app = app.layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        );
    }

    app
}

/// Run blocking database work off the async runtime.
///
/// MnesticDB is an embedded, synchronous engine; every call performs disk I/O
/// under a transaction. `spawn_blocking` keeps slow writes from parking tokio
/// workers that other requests need.
pub async fn db_call<T, F, M>(work: F, map_err: M) -> ApiResult<T>
where
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
    T: Send + 'static,
    M: FnOnce(anyhow::Error) -> AppError,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(err)) => Err(map_err(err)),
        Err(join_err) => Err(AppError::Internal(anyhow!(
            "database task failed: {join_err}"
        ))),
    }
}

pub fn clamp_limit(limit: usize) -> usize {
    limit.clamp(1, MAX_PAGE_LIMIT)
}

pub fn clamp_offset(offset: usize) -> usize {
    offset.min(MAX_PAGE_OFFSET)
}

/// Trim a required single-line field and enforce a size bound.
pub fn clean_text(raw: &str, field: &str, max_chars: usize) -> ApiResult<String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(AppError::bad_request(format!("{field} must not be empty")));
    }
    if value.chars().count() > max_chars {
        return Err(AppError::bad_request(format!(
            "{field} must be at most {max_chars} characters"
        )));
    }
    if value.contains('\n') {
        return Err(AppError::bad_request(format!(
            "{field} must be a single line"
        )));
    }
    Ok(value.to_string())
}

pub fn clean_title(raw: &str) -> ApiResult<String> {
    let value = raw.trim();
    if value.chars().count() > MAX_TITLE_CHARS {
        return Err(AppError::bad_request(format!(
            "title must be at most {MAX_TITLE_CHARS} characters"
        )));
    }
    if value.is_empty() {
        Ok("Untitled".to_string())
    } else {
        Ok(value.to_string())
    }
}

pub fn check_content(content: &str) -> ApiResult<()> {
    if content.len() > MAX_CONTENT_BYTES {
        return Err(AppError::bad_request(format!(
            "content must be at most {} bytes",
            MAX_CONTENT_BYTES
        )));
    }
    Ok(())
}

pub fn check_tags(tags: &[String]) -> ApiResult<()> {
    if tags.len() > MAX_TAGS {
        return Err(AppError::bad_request(format!(
            "at most {MAX_TAGS} tags are allowed"
        )));
    }
    Ok(())
}
