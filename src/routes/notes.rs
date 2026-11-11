use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;

use crate::error::{ApiResult, AppError};
use crate::routes::{check_content, check_tags, clamp_limit, clamp_offset, clean_title, db_call};
use crate::state::AppState;
use crate::store::model::{Note, NoteSummary};
use crate::store::NoteUpdate;

fn default_limit() -> usize {
    50
}

#[derive(Debug, Deserialize)]
pub struct ListNotesQuery {
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
    #[serde(default = "default_search_limit")]
    pub limit: usize,
}

fn default_search_limit() -> usize {
    30
}

#[derive(Debug, Deserialize)]
pub struct CreateNoteRequest {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateNoteRequest {
    pub title: Option<String>,
    pub content: Option<String>,
    pub tags: Option<Vec<String>>,
}

pub async fn list(
    State(state): State<AppState>,
    Path(notebook_id): Path<String>,
    Query(query): Query<ListNotesQuery>,
) -> ApiResult<Json<Vec<NoteSummary>>> {
    let limit = clamp_limit(query.limit);
    let offset = clamp_offset(query.offset);
    let store = state.store.clone();

    let notes = db_call(
        move || -> anyhow::Result<Option<Vec<NoteSummary>>> {
            if !store.notebook_exists(&notebook_id)? {
                return Ok(None);
            }
            Ok(Some(store.list_notes(&notebook_id, limit, offset)?))
        },
        AppError::Internal,
    )
    .await?
    .ok_or_else(|| AppError::not_found("notebook not found"))?;

    Ok(Json(notes))
}

pub async fn search(
    State(state): State<AppState>,
    Path(notebook_id): Path<String>,
    Query(query): Query<SearchQuery>,
) -> ApiResult<Json<Vec<NoteSummary>>> {
    let q = query.q.trim().to_string();
    if q.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let limit = clamp_limit(query.limit);

    let store = state.store.clone();
    let notes = db_call(
        move || -> anyhow::Result<Option<Vec<NoteSummary>>> {
            if !store.notebook_exists(&notebook_id)? {
                return Ok(None);
            }
            Ok(Some(store.search_notes(&notebook_id, &q, limit)?))
        },
        |err| AppError::Query(format!("search failed: {err:#}")),
    )
    .await?
    .ok_or_else(|| AppError::not_found("notebook not found"))?;

    Ok(Json(notes))
}

pub async fn create(
    State(state): State<AppState>,
    Path(notebook_id): Path<String>,
    Json(body): Json<CreateNoteRequest>,
) -> ApiResult<(StatusCode, Json<Note>)> {
    let title = clean_title(&body.title)?;
    check_content(&body.content)?;
    check_tags(&body.tags)?;

    let store = state.store.clone();
    let note = db_call(
        move || store.create_note(&notebook_id, &title, &body.content, &body.tags),
        AppError::Internal,
    )
    .await?
    .ok_or_else(|| AppError::not_found("notebook not found"))?;

    Ok((StatusCode::CREATED, Json(note)))
}

pub async fn get(
    State(state): State<AppState>,
    Path((notebook_id, path)): Path<(String, String)>,
) -> ApiResult<Json<Note>> {
    let store = state.store.clone();
    let note = db_call(
        move || store.get_note(&notebook_id, &path),
        AppError::Internal,
    )
    .await?;
    note.map(Json)
        .ok_or_else(|| AppError::not_found("note not found"))
}

pub async fn update(
    State(state): State<AppState>,
    Path((notebook_id, path)): Path<(String, String)>,
    Json(body): Json<UpdateNoteRequest>,
) -> ApiResult<Json<Note>> {
    if body.title.is_none() && body.content.is_none() && body.tags.is_none() {
        return Err(AppError::bad_request("nothing to update"));
    }

    let store = state.store.clone();
    let lookup_notebook = notebook_id.clone();
    let lookup_path = path.clone();
    let current = db_call(
        move || store.get_note(&lookup_notebook, &lookup_path),
        AppError::Internal,
    )
    .await?
    .ok_or_else(|| AppError::not_found("note not found"))?;

    let title = match body.title {
        Some(raw) => clean_title(&raw)?,
        None => current.title,
    };
    let content = body.content.unwrap_or(current.content);
    let tags = body.tags.unwrap_or(current.explicit_tags);
    check_content(&content)?;
    check_tags(&tags)?;

    let store = state.store.clone();
    let outcome = db_call(
        move || store.update_note(&notebook_id, &path, &title, &content, &tags),
        AppError::Internal,
    )
    .await?;

    match outcome {
        NoteUpdate::Updated(note) => Ok(Json(*note)),
        NoteUpdate::NotFound => Err(AppError::not_found("note not found")),
    }
}

pub async fn delete(
    State(state): State<AppState>,
    Path((notebook_id, path)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let store = state.store.clone();
    let deleted = db_call(
        move || store.delete_note(&notebook_id, &path),
        AppError::Internal,
    )
    .await?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::not_found("note not found"))
    }
}
