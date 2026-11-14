use axum::extract::{Multipart, Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;

use crate::error::{ApiResult, AppError};
use crate::routes::{clean_text, db_call, MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS};
use crate::state::AppState;
use crate::store::model::{Notebook, TagCount};
use crate::store::NotebookUpdate;

#[derive(Debug, Deserialize)]
pub struct CreateNotebookRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateNotebookRequest {
    pub name: Option<String>,
    pub description: Option<String>,
}

pub async fn list(State(state): State<AppState>) -> ApiResult<Json<Vec<Notebook>>> {
    let store = state.store.clone();
    let notebooks = db_call(move || store.list_notebooks(), AppError::Internal).await?;
    Ok(Json(notebooks))
}

pub async fn import(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<Notebook>)> {
    let mut requested_name = String::new();
    let mut file_name = String::new();
    let mut data: Option<Vec<u8>> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|err| AppError::bad_request(err.to_string()))?
    {
        let name = field.name().unwrap_or_default().to_string();
        if name == "name" {
            requested_name = field
                .text()
                .await
                .map_err(|err| AppError::bad_request(err.to_string()))?;
        } else if name == "file" {
            file_name = field.file_name().unwrap_or("import.zip").to_string();
            data = Some(
                field
                    .bytes()
                    .await
                    .map_err(|err| AppError::bad_request(err.to_string()))?
                    .to_vec(),
            );
        }
    }

    let data = data.ok_or_else(|| AppError::bad_request("zip file is required"))?;
    let requested_name = requested_name.trim();
    let name = if requested_name.is_empty() {
        file_name
            .trim_end_matches(".zip")
            .trim_end_matches(".ZIP")
            .to_string()
    } else {
        requested_name.to_string()
    };
    let store = state.store.clone();
    let notebook = db_call(
        move || store.import_notebook_zip(&name, &data),
        AppError::Internal,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(notebook)))
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateNotebookRequest>,
) -> ApiResult<(StatusCode, Json<Notebook>)> {
    let name = clean_text(&body.name, "name", MAX_NAME_CHARS)?;
    let description = check_description(&body.description)?;

    let store = state.store.clone();
    let notebook = db_call(
        move || store.create_notebook(&name, &description),
        AppError::Internal,
    )
    .await?
    .ok_or_else(|| {
        AppError::Conflict("a notebook folder with that name already exists".to_string())
    })?;
    Ok((StatusCode::CREATED, Json(notebook)))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Notebook>> {
    let store = state.store.clone();
    let notebook = db_call(move || store.get_notebook(&id), AppError::Internal).await?;
    notebook
        .map(Json)
        .ok_or_else(|| AppError::not_found("notebook not found"))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateNotebookRequest>,
) -> ApiResult<Json<Notebook>> {
    if body.name.is_none() && body.description.is_none() {
        return Err(AppError::bad_request("nothing to update"));
    }

    let store = state.store.clone();
    let lookup = id.clone();
    let current = db_call(move || store.get_notebook(&lookup), AppError::Internal)
        .await?
        .ok_or_else(|| AppError::not_found("notebook not found"))?;

    let name = match body.name {
        Some(raw) => clean_text(&raw, "name", MAX_NAME_CHARS)?,
        None => current.name,
    };
    let description = match body.description {
        Some(raw) => check_description(&raw)?,
        None => current.description,
    };

    let store = state.store.clone();
    let outcome = db_call(
        move || store.update_notebook(&id, &name, &description),
        AppError::Internal,
    )
    .await?;

    match outcome {
        NotebookUpdate::Updated(notebook) => Ok(Json(notebook)),
        NotebookUpdate::NotFound => Err(AppError::not_found("notebook not found")),
        NotebookUpdate::Conflict => Err(AppError::Conflict(
            "a notebook folder with that name already exists".to_string(),
        )),
    }
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let store = state.store.clone();
    let deleted = db_call(move || store.delete_notebook(&id), AppError::Internal).await?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::not_found("notebook not found"))
    }
}

pub async fn tags(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<TagCount>>> {
    let store = state.store.clone();
    let tags = db_call(
        move || -> anyhow::Result<Option<Vec<TagCount>>> {
            if !store.notebook_exists(&id)? {
                return Ok(None);
            }
            Ok(Some(store.list_tags(&id)?))
        },
        AppError::Internal,
    )
    .await?;

    tags.map(Json)
        .ok_or_else(|| AppError::not_found("notebook not found"))
}

fn check_description(raw: &str) -> ApiResult<String> {
    let value = raw.trim();
    if value.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(AppError::bad_request(format!(
            "description must be at most {MAX_DESCRIPTION_CHARS} characters"
        )));
    }
    Ok(value.to_string())
}
