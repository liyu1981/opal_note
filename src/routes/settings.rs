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
    let saved = value.clone();
    db_call(
        move || {
            settings.save(&saved)?;
            Ok(saved)
        },
        AppError::Internal,
    )
    .await?;
    Ok(Json(value))
}
