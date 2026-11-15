//! In-memory browser sessions.
//!
//! The optional `OPALNOTE_TOKEN` remains the authentication secret for API
//! clients. The web UI exchanges that token for an HttpOnly session cookie so
//! the token itself is not kept in JavaScript-readable storage. Mutating
//! cookie-authenticated requests also need a CSRF header.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::http::{header, HeaderMap};
use uuid::Uuid;

pub const SESSION_COOKIE: &str = "opalnote_session";
pub const CSRF_HEADER: &str = "x-opalnote-csrf";
pub const SESSION_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub csrf: String,
}

struct Session {
    csrf: String,
    expires_at: Instant,
}

pub struct SessionStore {
    sessions: Mutex<HashMap<String, Session>>,
    ttl: Duration,
}

impl SessionStore {
    pub fn new(ttl: Duration) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            ttl,
        }
    }

    pub fn create(&self) -> (String, String, Instant) {
        let id = Uuid::new_v4().to_string();
        let csrf = Uuid::new_v4().to_string();
        let expires_at = Instant::now() + self.ttl;

        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        sessions.retain(|_, session| session.expires_at > Instant::now());
        sessions.insert(
            id.clone(),
            Session {
                csrf: csrf.clone(),
                expires_at,
            },
        );
        (id, csrf, expires_at)
    }

    pub fn validate(&self, id: &str) -> Option<SessionInfo> {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let now = Instant::now();
        sessions.retain(|_, session| session.expires_at > now);
        sessions.get(id).map(|session| SessionInfo {
            csrf: session.csrf.clone(),
        })
    }

    pub fn remove(&self, id: &str) {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        sessions.remove(id);
    }
}

/// Read the first session cookie from a Cookie header.
pub fn session_cookie(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        if name == SESSION_COOKIE && !value.is_empty() {
            Some(value.to_string())
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_expires_sessions() {
        let sessions = SessionStore::new(Duration::from_secs(5));
        let (id, csrf, _) = sessions.create();
        assert_eq!(sessions.validate(&id).unwrap().csrf, csrf);
        assert!(!csrf.is_empty());

        sessions.remove(&id);
        assert!(sessions.validate(&id).is_none());

        let short = SessionStore::new(Duration::from_millis(1));
        let (id, _, _) = short.create();
        std::thread::sleep(Duration::from_millis(5));
        assert!(short.validate(&id).is_none());
    }

    #[test]
    fn reads_session_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "other=1; opalnote_session=abc; last=2".parse().unwrap(),
        );
        assert_eq!(session_cookie(&headers), Some("abc".to_string()));
    }
}
