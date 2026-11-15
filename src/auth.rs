use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, Method};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::error::AppError;
use crate::session::{session_cookie, CSRF_HEADER};
use crate::state::AppState;

/// Optional bearer-token gate for `/api`. When no token is configured the
/// server is intentionally open (typical for a loopback self-hosted setup).
///
/// Browser requests may authenticate with an HttpOnly session cookie, created
/// by `POST /api/session`. Cookie-authenticated state-changing requests must
/// also carry the session's CSRF token.
pub async fn require_token(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let expected = state.token.as_deref();

    if let Some(expected) = expected {
        if bearer_token(request.headers())
            .is_some_and(|token| constant_time_eq(token.as_bytes(), expected.as_bytes()))
        {
            return next.run(request).await;
        }
    }

    if let Some(session_id) = session_cookie(request.headers()) {
        if let Some(session) = state.sessions.validate(&session_id) {
            if !is_safe_method(request.method()) && !csrf_is_valid(request.headers(), &session.csrf)
            {
                return AppError::Forbidden("csrf token mismatch".to_string()).into_response();
            }
            return next.run(request).await;
        }
    }

    if expected.is_none() {
        return next.run(request).await;
    }

    AppError::Unauthorized.into_response()
}

pub fn csrf_is_valid(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(CSRF_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| constant_time_eq(value.as_bytes(), expected.as_bytes()))
}

fn is_safe_method(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
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
        .or_else(|| {
            headers
                .get("x-opalnote-token")
                .and_then(|value| value.to_str().ok())
        })
}

/// Compare without short-circuiting on the first differing byte.
pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}
