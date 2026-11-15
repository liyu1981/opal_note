use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderValue, Response};
use axum::Json;
use serde::Deserialize;

use crate::backgrounds::BackgroundList;
use crate::error::{ApiResult, AppError};
use crate::routes::db_call;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct BackgroundAssetQuery {
    pub id: String,
    pub path: String,
}

pub async fn list(State(state): State<AppState>) -> Json<BackgroundList> {
    Json(state.backgrounds.list())
}

pub async fn reload(State(state): State<AppState>) -> ApiResult<Json<BackgroundList>> {
    let backgrounds = state.backgrounds.clone();
    let list = db_call(move || backgrounds.reload(), AppError::Internal).await?;
    Ok(Json(list))
}

pub async fn asset(
    State(state): State<AppState>,
    Query(query): Query<BackgroundAssetQuery>,
) -> ApiResult<Response<Body>> {
    let backgrounds = state.backgrounds.clone();
    let asset = db_call(
        move || backgrounds.read_asset(&query.id, &query.path),
        AppError::Internal,
    )
    .await?
    .ok_or_else(|| AppError::not_found("background asset not found"))?;
    let (bytes, mime) = asset;

    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    Ok(response)
}
