use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;

use crate::error::{ApiResult, AppError};
use crate::routes::{check_content, check_tags, clamp_limit, clamp_offset, clean_title, db_call};
use crate::state::AppState;
use crate::store::model::{GraphData, JournalPage, Note, NoteSummary, PageList, PageOverview};
use crate::store::{NoteSection, NoteUpdate};

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

fn default_journal_limit() -> usize {
    7
}

fn default_page_limit() -> usize {
    20
}

#[derive(Debug, Deserialize)]
pub struct PageQuery {
    #[serde(default = "default_page_limit")]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
    pub q: Option<String>,
    pub tag: Option<String>,
    pub sort: Option<String>,
    pub dir: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct JournalQuery {
    pub before: Option<String>,
    #[serde(default = "default_journal_limit")]
    pub limit: usize,
}

#[derive(Debug, Deserialize)]
pub struct CreateNoteRequest {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// `pages` (default) or `journals`.
    pub section: Option<String>,
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

pub async fn pages(
    State(state): State<AppState>,
    Path(notebook_id): Path<String>,
    Query(query): Query<PageQuery>,
) -> ApiResult<Json<PageList>> {
    let limit = clamp_limit(query.limit);
    let offset = clamp_offset(query.offset);
    let q = query.q.unwrap_or_default().trim().to_string();
    let tag = query.tag.unwrap_or_default().trim().to_string();
    let sort = query.sort.unwrap_or_default();
    let dir = query.dir.unwrap_or_default();
    let store = state.store.clone();

    let pages = db_call(
        move || -> anyhow::Result<Option<PageList>> {
            if !store.notebook_exists(&notebook_id)? {
                return Ok(None);
            }
            Ok(Some(store.list_page_overviews(
                &notebook_id,
                limit,
                offset,
                (!q.is_empty()).then_some(q.as_str()),
                (!tag.is_empty()).then_some(tag.as_str()),
                (!sort.is_empty()).then_some(sort.as_str()),
                (!dir.is_empty()).then_some(dir.as_str()),
            )?))
        },
        AppError::Internal,
    )
    .await?
    .ok_or_else(|| AppError::not_found("notebook not found"))?;

    Ok(Json(pages))
}

pub async fn graph(
    State(state): State<AppState>,
    Path(notebook_id): Path<String>,
) -> ApiResult<Json<GraphData>> {
    let store = state.store.clone();
    let graph = db_call(
        move || -> anyhow::Result<Option<GraphData>> {
            if !store.notebook_exists(&notebook_id)? {
                return Ok(None);
            }
            Ok(Some(store.graph(&notebook_id)?))
        },
        AppError::Internal,
    )
    .await?
    .ok_or_else(|| AppError::not_found("notebook not found"))?;

    Ok(Json(graph))
}

pub async fn orphans(
    State(state): State<AppState>,
    Path(notebook_id): Path<String>,
) -> ApiResult<Json<Vec<PageOverview>>> {
    let store = state.store.clone();
    let pages = db_call(
        move || -> anyhow::Result<Option<Vec<PageOverview>>> {
            if !store.notebook_exists(&notebook_id)? {
                return Ok(None);
            }
            Ok(Some(store.list_orphan_pages(&notebook_id)?))
        },
        AppError::Internal,
    )
    .await?
    .ok_or_else(|| AppError::not_found("notebook not found"))?;

    Ok(Json(pages))
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

pub async fn journals(
    State(state): State<AppState>,
    Path(notebook_id): Path<String>,
    Query(query): Query<JournalQuery>,
) -> ApiResult<Json<Vec<JournalPage>>> {
    if let Some(before) = &query.before {
        let valid = before.starts_with("journals/")
            && before.ends_with(".md")
            && !before.contains("..")
            && !before.contains('\\');
        if !valid {
            return Err(AppError::bad_request("invalid journal cursor"));
        }
    }
    let before = query.before.clone();
    let limit = query.limit.clamp(1, 30);

    let store = state.store.clone();
    let pages = db_call(
        move || -> anyhow::Result<Option<Vec<JournalPage>>> {
            if !store.notebook_exists(&notebook_id)? {
                return Ok(None);
            }
            Ok(Some(store.list_journals(
                &notebook_id,
                before.as_deref(),
                limit,
            )?))
        },
        AppError::Internal,
    )
    .await?
    .ok_or_else(|| AppError::not_found("notebook not found"))?;

    Ok(Json(pages))
}

pub async fn create(
    State(state): State<AppState>,
    Path(notebook_id): Path<String>,
    Json(body): Json<CreateNoteRequest>,
) -> ApiResult<(StatusCode, Json<Note>)> {
    let title = clean_title(&body.title)?;
    check_content(&body.content)?;
    check_tags(&body.tags)?;
    let section = NoteSection::parse(body.section.as_deref().unwrap_or("pages"))
        .ok_or_else(|| AppError::bad_request("section must be `pages` or `journals`"))?;

    let store = state.store.clone();
    let note = db_call(
        move || match section {
            NoteSection::Pages => {
                store.create_note(&notebook_id, &title, &body.content, &body.tags)
            }
            NoteSection::Journals => store.create_note_in_section(
                &notebook_id,
                section,
                &title,
                &body.content,
                &body.tags,
            ),
        },
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
