use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, Response};
use axum::Json;
use serde::Deserialize;

use crate::error::{ApiResult, AppError};
use crate::routes::{clamp_limit, clamp_offset, db_call};
use crate::state::AppState;
use crate::store::model::{AssetEntry, AssetInfo, AssetList};
use crate::store::{AssetListOptions, AssetRename};

fn default_limit() -> usize {
    24
}

#[derive(Debug, Deserialize)]
pub struct AssetQuery {
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
    pub q: Option<String>,
    pub kind: Option<String>,
    pub sort: Option<String>,
    pub dir: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AssetInfoQuery {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct RenameAssetRequest {
    pub path: String,
    pub name: String,
}

pub async fn list(
    State(state): State<AppState>,
    Path(notebook_id): Path<String>,
    Query(query): Query<AssetQuery>,
) -> ApiResult<Json<AssetList>> {
    let limit = clamp_limit(query.limit);
    let offset = clamp_offset(query.offset);
    let q = query.q.unwrap_or_default().trim().to_string();
    let kind = query.kind.unwrap_or_default().trim().to_string();
    let sort = query.sort.unwrap_or_default();
    let dir = query.dir.unwrap_or_default();
    let store = state.store.clone();
    let assets = db_call(
        move || {
            store.list_assets(
                &notebook_id,
                AssetListOptions {
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
    .await?
    .ok_or_else(|| AppError::not_found("notebook not found"))?;
    Ok(Json(assets))
}

pub async fn info(
    State(state): State<AppState>,
    Path(notebook_id): Path<String>,
    Query(query): Query<AssetInfoQuery>,
) -> ApiResult<Json<AssetInfo>> {
    let store = state.store.clone();
    let info = db_call(
        move || store.asset_info(&notebook_id, &query.path),
        AppError::Internal,
    )
    .await?;
    info.map(Json)
        .ok_or_else(|| AppError::not_found("asset not found"))
}

pub async fn content(
    State(state): State<AppState>,
    Path((notebook_id, path)): Path<(String, String)>,
) -> ApiResult<Response<Body>> {
    let store = state.store.clone();
    let asset = db_call(
        move || store.read_asset(&notebook_id, &path),
        AppError::Internal,
    )
    .await?
    .ok_or_else(|| AppError::not_found("asset not found"))?;
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
        HeaderValue::from_static("private, max-age=3600"),
    );
    Ok(response)
}

pub async fn rename(
    State(state): State<AppState>,
    Path(notebook_id): Path<String>,
    Json(body): Json<RenameAssetRequest>,
) -> ApiResult<Json<AssetEntry>> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::bad_request("name must not be empty"));
    }
    let path = body.path;
    let store = state.store.clone();
    let outcome = db_call(
        move || store.rename_asset(&notebook_id, &path, &name),
        AppError::Internal,
    )
    .await?;
    match outcome {
        AssetRename::Renamed(asset) => Ok(Json(asset)),
        AssetRename::NotFound => Err(AppError::not_found("asset not found")),
        AssetRename::Conflict => Err(AppError::Conflict(
            "an asset with that name already exists".to_string(),
        )),
    }
}
