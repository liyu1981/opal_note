use axum::extract::State;
use axum::Json;
use serde_json::Value;

use crate::error::{ApiResult, AppError};
use crate::routes::db_call;
use crate::state::AppState;

pub async fn get(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let settings = state.settings.clone();
    let value = db_call(move || settings.load(), AppError::Internal).await?;
    Ok(Json(value))
}

pub async fn put(
    State(state): State<AppState>,
    Json(value): Json<Value>,
) -> ApiResult<Json<Value>> {
    if !value.is_object() {
        return Err(AppError::bad_request("settings must be a JSON object"));
    }
    let settings = state.settings.clone();
    let store = state.store.clone();
    let saved = value.clone();
    db_call(
        move || {
            settings.save(&saved)?;
            if saved.get("trashRetentionDays").is_some() {
                // Settings are saved even if a purge fails; the hourly task
                // retries and logs the problem.
                if let Err(err) = store.purge_expired_trash(settings.trash_retention_days()) {
                    tracing::warn!(error = %err, "trash purge after settings change failed");
                }
            }
            Ok(())
        },
        AppError::Internal,
    )
    .await?;
    Ok(Json(value))
}
