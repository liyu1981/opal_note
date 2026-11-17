use axum::body::Body;
use axum::extract::multipart::Field;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, HeaderValue, Response, StatusCode};
use axum::Json;
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use crate::error::{ApiResult, AppError};
use crate::routes::{clamp_limit, clamp_offset, db_call};
use crate::state::AppState;
use crate::store::files::{self, EDITABLE_ASSET_EXTENSIONS};
use crate::store::model::{AssetEntry, AssetInfo, AssetList};
use crate::store::{AssetListOptions, AssetRename, AssetUpdate};

fn default_limit() -> usize {
    24
}

/// Asset kinds the upload endpoint accepts: images, audio, video, documents
/// (pdf/office/text) and common archives. Anything else is rejected so the
/// server never stores executable payloads it would later serve same-origin.
fn upload_type_allowed(file_name: &str) -> bool {
    let essence = mime_guess::from_path(file_name)
        .first_or_octet_stream()
        .essence_str()
        .to_ascii_lowercase();
    if essence.starts_with("image/")
        || essence.starts_with("audio/")
        || essence.starts_with("video/")
    {
        return true;
    }
    let extension = std::path::Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "pdf"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx"
            | "odt"
            | "ods"
            | "odp"
            | "rtf"
            | "txt"
            | "md"
            | "markdown"
            | "csv"
            | "tsv"
            | "json"
            | "yaml"
            | "yml"
            | "xml"
            | "epub"
            | "zip"
            | "tar"
            | "gz"
            | "tgz"
            | "7z"
            | "rar"
            | "log"
    )
}

async fn discard(path: &std::path::Path) {
    let _ = tokio::fs::remove_file(path).await;
}

/// Stream one multipart file field into `dir`, enforcing the configured cap.
async fn write_upload(
    field: &mut Field<'_>,
    dir: &std::path::Path,
    max_bytes: u64,
) -> ApiResult<std::path::PathBuf> {
    let temp = dir.join(format!(".upload-{}", uuid::Uuid::new_v4()));
    let mut file = tokio::fs::File::create(&temp)
        .await
        .map_err(|err| AppError::Internal(err.into()))?;
    let mut written = 0u64;
    loop {
        let chunk = match field.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(err) => {
                drop(file);
                discard(&temp).await;
                return Err(AppError::bad_request(err.to_string()));
            }
        };
        written = written.saturating_add(chunk.len() as u64);
        if written > max_bytes {
            drop(file);
            discard(&temp).await;
            return Err(AppError::PayloadTooLarge(format!(
                "asset exceeds the {} MB upload limit (Settings → Files)",
                max_bytes / (1024 * 1024)
            )));
        }
        if let Err(err) = file.write_all(&chunk).await {
            drop(file);
            discard(&temp).await;
            return Err(AppError::Internal(err.into()));
        }
    }
    if let Err(err) = file.sync_all().await {
        drop(file);
        discard(&temp).await;
        return Err(AppError::Internal(err.into()));
    }
    Ok(temp)
}

#[derive(Debug, Deserialize)]
pub struct CreateContentAssetRequest {
    #[serde(default)]
    pub name: String,
    pub extension: String,
    #[serde(default)]
    pub content: String,
    pub folder: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateContentAssetRequest {
    #[serde(default)]
    pub content: String,
    pub base_updated_at: Option<String>,
}

fn editable_extension(value: &str) -> Option<String> {
    let extension = value.trim().trim_start_matches('.').to_ascii_lowercase();
    EDITABLE_ASSET_EXTENSIONS
        .contains(&extension.as_str())
        .then_some(extension)
}

fn check_content_size(extension: &str, content: &str) -> ApiResult<()> {
    let limit = files::editable_asset_max_bytes(extension);
    if content.len() as u64 > limit {
        return Err(AppError::PayloadTooLarge(format!(
            "asset content exceeds the {} KB limit",
            limit / 1024
        )));
    }
    Ok(())
}

/// Create a text asset (Mermaid source, Excalidraw scene) from JSON.
pub async fn create_content(
    State(state): State<AppState>,
    Path(notebook_id): Path<String>,
    Json(body): Json<CreateContentAssetRequest>,
) -> ApiResult<Json<AssetEntry>> {
    let Some(extension) = editable_extension(&body.extension) else {
        return Err(AppError::bad_request(format!(
            "unsupported asset extension; use {}",
            EDITABLE_ASSET_EXTENSIONS.join(", ")
        )));
    };
    check_content_size(&extension, &body.content)?;
    let name = body.name.trim().to_string();
    let folder = body
        .folder
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let content = body.content;
    let store = state.store.clone();
    let entry = db_call(
        move || store.write_asset(&notebook_id, &name, &extension, folder.as_deref(), &content),
        AppError::Internal,
    )
    .await?;
    Ok(Json(entry))
}

/// Overwrite an existing text asset. `base_updated_at` guards against a stale
/// editor clobbering a newer save.
pub async fn update_content(
    State(state): State<AppState>,
    Path((notebook_id, path)): Path<(String, String)>,
    Json(body): Json<UpdateContentAssetRequest>,
) -> ApiResult<Json<AssetEntry>> {
    let extension = std::path::Path::new(&path)
        .extension()
        .and_then(|value| value.to_str())
        .and_then(editable_extension)
        .ok_or_else(|| {
            AppError::bad_request(format!(
                "asset `{path}` is not an editable text asset; use {}",
                EDITABLE_ASSET_EXTENSIONS.join(", ")
            ))
        })?;
    check_content_size(&extension, &body.content)?;
    let content = body.content;
    let base = body.base_updated_at;
    let store = state.store.clone();
    let outcome = db_call(
        move || store.update_asset(&notebook_id, &path, &content, base.as_deref()),
        AppError::Internal,
    )
    .await?;
    match outcome {
        AssetUpdate::Updated(entry) => Ok(Json(entry)),
        AssetUpdate::NotFound => Err(AppError::not_found("asset not found")),
        AssetUpdate::Conflict => Err(AppError::Conflict(
            "asset was modified elsewhere; reload before saving".to_string(),
        )),
    }
}

/// Multipart asset upload. The first file field wins; the original file name is
/// kept (sanitized) and conflicts get a unix-timestamp suffix.
pub async fn upload(
    State(state): State<AppState>,
    Path(notebook_id): Path<String>,
    mut multipart: Multipart,
) -> ApiResult<Json<AssetEntry>> {
    let store = state.store.clone();
    let assets_dir = {
        let notebook_id = notebook_id.clone();
        db_call(move || store.assets_dir(&notebook_id), AppError::Internal).await?
    }
    .ok_or_else(|| AppError::not_found("notebook not found"))?;
    let settings = state.settings.clone();
    let max_bytes = db_call(move || Ok(settings.max_upload_bytes()), AppError::Internal).await?;

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|err| AppError::bad_request(err.to_string()))?
    {
        let Some(file_name) = field.file_name().map(str::to_string) else {
            continue;
        };
        if !upload_type_allowed(&file_name) {
            return Err(AppError::bad_request(format!(
                "unsupported asset type for `{file_name}`; upload images, audio, video, \
                 pdf/office documents or archives"
            )));
        }
        let temp = write_upload(&mut field, &assets_dir, max_bytes).await?;
        let store = state.store.clone();
        let notebook_id = notebook_id.clone();
        return db_call(
            move || store.finalize_asset(&notebook_id, &file_name, &temp),
            AppError::Internal,
        )
        .await
        .map(Json);
    }

    Err(AppError::bad_request("file field is required"))
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
    // Assets are user files served from the app's own origin: never let the
    // browser sniff a different type, and sandbox documents (SVG) so inline
    // scripts cannot run.
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; sandbox"),
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

pub async fn delete(
    State(state): State<AppState>,
    Path((notebook_id, path)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let store = state.store.clone();
    let removed = db_call(
        move || store.delete_asset(&notebook_id, &path),
        AppError::Internal,
    )
    .await?;
    if removed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::not_found("asset not found"))
    }
}
