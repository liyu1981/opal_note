use std::collections::BTreeMap;
use std::time::Instant;

use axum::extract::State;
use axum::Json;
use cozo::{DataValue, JsonData};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiResult, AppError};
use crate::routes::db_call;
use crate::state::AppState;

const MAX_SCRIPT_BYTES: usize = 20_000;
const MAX_PARAMS: usize = 100;

#[derive(Debug, Deserialize)]
pub struct QueryRequest {
    /// A CozoScript/Datalog query. Read-only: `::` system ops are rejected.
    pub script: String,
    #[serde(default)]
    pub params: BTreeMap<String, Value>,
    /// Optional per-query budget, clamped to [0.1, 30] seconds.
    pub timeout_secs: Option<f64>,
}

pub async fn run(
    State(state): State<AppState>,
    Json(body): Json<QueryRequest>,
) -> ApiResult<Json<Value>> {
    let script = body.script.trim();
    if script.is_empty() {
        return Err(AppError::bad_request("script must not be empty"));
    }
    if script.len() > MAX_SCRIPT_BYTES {
        return Err(AppError::bad_request(format!(
            "script must be at most {MAX_SCRIPT_BYTES} bytes"
        )));
    }
    if script.contains("::") {
        return Err(AppError::bad_request(
            "system commands (`::`) are not allowed on the ad-hoc query endpoint",
        ));
    }
    if body.params.len() > MAX_PARAMS {
        return Err(AppError::bad_request(format!(
            "at most {MAX_PARAMS} parameters are allowed"
        )));
    }

    let params: BTreeMap<String, DataValue> = body
        .params
        .iter()
        .map(|(key, value)| (key.clone(), to_data_value(value)))
        .collect();

    let timeout = body
        .timeout_secs
        .unwrap_or(state.query_timeout_secs)
        .clamp(0.1, 30.0);

    let started = Instant::now();
    let script = script.to_string();
    let store = state.store.clone();
    let rows = db_call(
        move || store.run_query(&script, params, Some(timeout)),
        |err| AppError::Query(err.to_string()),
    )
    .await?;

    let mut response = rows.into_json();
    if let Some(object) = response.as_object_mut() {
        object.insert(
            "took_ms".to_string(),
            json!(started.elapsed().as_millis() as u64),
        );
    }
    Ok(Json(response))
}

/// Map plain JSON values onto CozoScript values. JSON objects become the
/// database's JSON scalar, not a nested relation.
fn to_data_value(value: &Value) -> DataValue {
    match value {
        Value::Null => DataValue::Null,
        Value::Bool(boolean) => DataValue::Bool(*boolean),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                DataValue::from(int)
            } else {
                DataValue::from(number.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(text) => DataValue::from(text.as_str()),
        Value::Array(items) => DataValue::List(items.iter().map(to_data_value).collect()),
        Value::Object(_) => DataValue::Json(JsonData(value.clone())),
    }
}
