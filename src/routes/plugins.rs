use axum::extract::{Path, State};
use axum::Json;

use crate::error::{ApiResult, AppError};
use crate::plugins::{run_journal_plugins, JournalPluginResult};
use crate::routes::db_call;
use crate::state::AppState;

pub async fn journal(
    State(state): State<AppState>,
    Path(notebook_id): Path<String>,
) -> ApiResult<Json<Vec<JournalPluginResult>>> {
    let timeout = state.plugin_timeout_secs;
    let store = state.store.clone();
    let results = db_call(
        move || -> anyhow::Result<Option<Vec<JournalPluginResult>>> {
            if !store.notebook_exists(&notebook_id)? {
                return Ok(None);
            }
            Ok(Some(run_journal_plugins(&store, &notebook_id, timeout)))
        },
        AppError::Internal,
    )
    .await?
    .ok_or_else(|| AppError::not_found("notebook not found"))?;

    Ok(Json(results))
}
