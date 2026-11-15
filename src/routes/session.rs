use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::auth::constant_time_eq;
use crate::error::{ApiResult, AppError};
use crate::session::{SESSION_COOKIE, SESSION_TTL};
use crate::state::AppState;

#[derive(Debug, Default, Deserialize)]
pub struct SessionRequest {
    #[serde(default)]
    pub token: Option<String>,
}

/// Exchange the optional server token for an HttpOnly session cookie.
///
/// With no `OPALNOTE_TOKEN` configured this still issues a session so the
/// browser can use CSRF-protected requests. Possession of this cookie is not
/// user authentication; the server token remains the authentication secret.
pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SessionRequest>,
) -> ApiResult<Response> {
    let existing =
        crate::session::session_cookie(&headers).filter(|id| state.sessions.validate(id).is_some());

    if let Some(expected) = state.token.as_deref() {
        let provided = body
            .token
            .as_deref()
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .or_else(|| bearer_token(&headers))
            .unwrap_or_default();
        if !constant_time_eq(provided.as_bytes(), expected.as_bytes()) && existing.is_none() {
            return Err(AppError::Unauthorized);
        }
    }
    if let Some(old) = existing {
        state.sessions.remove(&old);
    }

    let (id, csrf, _expires_at) = state.sessions.create();
    let secure = state.secure_cookies || forwarded_https(&headers);
    let cookie = cookie_header(&id, secure, SESSION_TTL.as_secs());
    let mut response = Json(serde_json::json!({
        "authenticated": true,
        "csrf_token": csrf,
        "expires_in": SESSION_TTL.as_secs(),
    }))
    .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie)
            .map_err(|_| AppError::Internal(anyhow::anyhow!("session cookie")))?,
    );
    Ok(response)
}

pub async fn clear(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(id) = crate::session::session_cookie(&headers) {
        state.sessions.remove(&id);
    }
    let secure = state.secure_cookies || forwarded_https(&headers);
    let cookie = cookie_header("", secure, 0);
    let mut response = StatusCode::NO_CONTENT.into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

fn cookie_header(value: &str, secure: bool, max_age: u64) -> String {
    format!(
        "{SESSION_COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{}",
        if secure { "; Secure" } else { "" }
    )
}

fn forwarded_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .is_some_and(|proto| proto.trim().eq_ignore_ascii_case("https"))
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
        })
}
