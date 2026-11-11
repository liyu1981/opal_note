use anyhow::Context;
use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::error::{ApiResult, AppError};
use crate::routes::db_call;
use crate::state::AppState;
use crate::store::model::Stats;

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
    pub uptime_secs: u64,
    pub auth_required: bool,
}

pub async fn health(State(state): State<AppState>) -> ApiResult<Json<HealthResponse>> {
    let store = state.store.clone();
    db_call(
        move || store.ping().context("database health check failed"),
        AppError::Internal,
    )
    .await?;

    Ok(Json(HealthResponse {
        status: "ok",
        version: state.version,
        uptime_secs: state.started_at.elapsed().as_secs(),
        auth_required: state.token.is_some(),
    }))
}

#[derive(Debug, Serialize)]
pub struct MetaResponse {
    pub name: &'static str,
    pub version: &'static str,
    pub api_version: u32,
    pub auth_required: bool,
    pub engine: &'static str,
}

pub async fn meta(State(state): State<AppState>) -> Json<MetaResponse> {
    Json(MetaResponse {
        name: "Opal Note",
        version: state.version,
        api_version: 1,
        auth_required: state.token.is_some(),
        engine: "mnesticdb",
    })
}

pub async fn reindex(State(state): State<AppState>) -> ApiResult<Json<Stats>> {
    let store = state.store.clone();
    let stats = db_call(
        move || store.reindex().context("rebuilding the index"),
        AppError::Internal,
    )
    .await?;
    Ok(Json(stats))
}

pub async fn stats(State(state): State<AppState>) -> ApiResult<Json<Stats>> {
    let store = state.store.clone();
    let stats = db_call(
        move || store.stats().context("computing stats"),
        AppError::Internal,
    )
    .await?;
    Ok(Json(stats))
}
