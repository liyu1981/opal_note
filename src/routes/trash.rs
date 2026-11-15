use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, Response, StatusCode};
use axum::Json;
use serde::Deserialize;

use crate::error::{ApiResult, AppError};
use crate::routes::{clamp_limit, clamp_offset, db_call};
use crate::state::AppState;
use crate::store::model::{TrashDetail, TrashList, TrashRestoreResult};
use crate::store::TrashListOptions;

fn default_limit() -> usize {
    20
}

#[derive(Debug, Deserialize)]
pub struct TrashQuery {
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
    pub q: Option<String>,
    pub kind: Option<String>,
    pub sort: Option<String>,
    pub dir: Option<String>,
}

async fn retention_days(state: &AppState) -> ApiResult<u64> {
    let settings = state.settings.clone();
    db_call(
        move || -> anyhow::Result<u64> { Ok(settings.trash_retention_days()) },
        AppError::Internal,
    )
    .await
}

pub async fn list(
    State(state): State<AppState>,
    Query(query): Query<TrashQuery>,
) -> ApiResult<Json<TrashList>> {
    let limit = clamp_limit(query.limit);
    let offset = clamp_offset(query.offset);
    let q = query.q.unwrap_or_default().trim().to_string();
    let kind = query.kind.unwrap_or_default().trim().to_string();
    let sort = query.sort.unwrap_or_default();
    let dir = query.dir.unwrap_or_default();
    let days = retention_days(&state).await?;

    let store = state.store.clone();
    let entries = db_call(
        move || {
            store.list_trash(
                days,
                TrashListOptions {
                    limit,
                    offset,
                    query: (!q.is_empty()).then_some(q.as_str()),
                    kind: (!kind.is_empty()).then_some(kind.as_str()),
                    sort: (!sort.is_empty()).then_some(sort.as_str()),
                    direction: (!dir.is_empty()).then_some(dir.as_str()),
                },
            )
        },
        AppError::Internal,
    )
    .await?;
    Ok(Json(entries))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<TrashDetail>> {
    let days = retention_days(&state).await?;
    let store = state.store.clone();
    let detail = db_call(move || store.get_trash(&id, days), AppError::Internal).await?;
    detail
        .map(Json)
        .ok_or_else(|| AppError::not_found("trash entry not found"))
}

pub async fn content(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Response<Body>> {
    let store = state.store.clone();
    let payload = db_call(move || store.read_trash_content(&id), AppError::Internal)
        .await?
        .ok_or_else(|| AppError::not_found("trash entry not found"))?;
    let (bytes, mime) = payload;

    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

pub async fn restore(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<TrashRestoreResult>> {
    let store = state.store.clone();
    let restored = db_call(move || store.restore_trash(&id), AppError::Internal).await?;
    restored
        .map(Json)
        .ok_or_else(|| AppError::not_found("trash entry not found"))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let store = state.store.clone();
    let removed = db_call(move || store.delete_trash_entry(&id), AppError::Internal).await?;
    if removed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::not_found("trash entry not found"))
    }
}
