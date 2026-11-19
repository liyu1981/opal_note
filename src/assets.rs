use axum::body::Body;
use axum::extract::OriginalUri;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

#[cfg(not(debug_assertions))]
use rust_embed::RustEmbed;

use crate::error::AppError;

/// Web MIME for served assets. `mime_guess` covers the hashed bundle; the PWA
/// files need the types browsers expect.
fn asset_mime(path: &str) -> String {
    if path.ends_with(".webmanifest") {
        return "application/manifest+json".to_string();
    }
    mime_guess::from_path(path)
        .first_or_octet_stream()
        .essence_str()
        .to_string()
}

/// Assets emitted by `vite build`. Release builds embed them; debug builds
/// read the same files from disk so frontend-only changes do not trigger a
/// Rust rebuild.
#[cfg(not(debug_assertions))]
#[derive(RustEmbed)]
#[folder = "web/dist"]
struct WebAssets;

/// Serve an embedded asset, falling back to `index.html` for client routes.
pub async fn static_handler(OriginalUri(uri): OriginalUri) -> Response {
    let path = uri.path().trim_start_matches('/');

    if path == "api" || path.starts_with("api/") {
        return AppError::not_found("route not found").into_response();
    }

    let requested = if path.is_empty() { "index.html" } else { path };
    #[cfg(not(debug_assertions))]
    if let Some(asset) = WebAssets::get(requested) {
        return asset_response(requested, asset.data.into_owned());
    }
    #[cfg(debug_assertions)]
    if let Some(bytes) = dev_asset(requested) {
        return asset_response(requested, bytes);
    }

    // Missing hashed assets should be a real 404, not the SPA shell. Only
    // extension-less paths are client-side routes. Asset detail URLs contain a
    // dot in the final path segment, so allow the notebook asset route through.
    let is_asset_detail = path.split('/').nth(1) == Some("asset");
    let looks_like_asset = requested.starts_with("assets/")
        || requested
            .rsplit('/')
            .next()
            .is_some_and(|name| name.contains('.'));
    if looks_like_asset && !is_asset_detail {
        return AppError::not_found("asset not found").into_response();
    }

    #[cfg(not(debug_assertions))]
    match WebAssets::get("index.html") {
        Some(asset) => asset_response("index.html", asset.data.into_owned()),
        None => (
            StatusCode::NOT_FOUND,
            "web assets are not built; run `pnpm --dir web build`",
        )
            .into_response(),
    }
    #[cfg(debug_assertions)]
    match dev_asset("index.html") {
        Some(bytes) => asset_response("index.html", bytes),
        None => (
            StatusCode::NOT_FOUND,
            "web assets are not built; run `pnpm --dir web build`",
        )
            .into_response(),
    }
}

#[cfg(debug_assertions)]
fn dev_asset(path: &str) -> Option<Vec<u8>> {
    if path.is_empty()
        || path.starts_with('/')
        || path.split('/').any(|part| part == ".." || part == ".")
    {
        return None;
    }
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("web/dist")
            .join(path),
    )
    .ok()
}

/// Content Security Policy for the SPA. Scripts are same-origin only; inline
/// styles remain allowed because React and CodeMirror use dynamic style
/// attributes. Google Fonts are explicitly allow-listed for the Settings font
/// picker, and authenticated image/audio/video blobs come from self or blob:.
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; \
script-src 'self'; \
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; \
font-src 'self' data: https://fonts.gstatic.com; \
img-src 'self' data: blob: https:; \
media-src 'self' data: blob: https:; \
connect-src 'self'; \
worker-src 'self' blob:; \
object-src 'none'; \
base-uri 'self'; \
form-action 'self'; \
frame-ancestors 'none'";

/// Files that must always be revalidated: the shell, the service worker, the
/// manifest and the icons they reference. Everything else is a hashed build
/// asset and can be cached forever.
fn must_revalidate(path: &str) -> bool {
    matches!(
        path,
        "index.html"
            | "sw.js"
            | "manifest.webmanifest"
            | "offline.html"
            | "favicon.svg"
            | "favicon.ico"
    ) || path.starts_with("icons/")
}

fn asset_response(path: &str, bytes: Vec<u8>) -> Response {
    let mime = asset_mime(path);
    let cache = if must_revalidate(path) {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, cache)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header("content-security-policy", CONTENT_SECURITY_POLICY)
        .header("referrer-policy", "no-referrer")
        .header("x-frame-options", "DENY")
        .header(
            "permissions-policy",
            "camera=(), microphone=(), geolocation=()",
        )
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pwa_files_are_revalidated_and_typed() {
        for path in [
            "index.html",
            "sw.js",
            "manifest.webmanifest",
            "offline.html",
            "favicon.svg",
            "icons/icon-192.png",
            "icons/icon-512.png",
            "icons/icon-512-maskable.png",
            "icons/apple-touch-icon.png",
            "icons/icon.svg",
        ] {
            assert!(must_revalidate(path), "{path} must not be cached forever");
        }
        for path in ["assets/index-abc123.js", "assets/index-abc123.css"] {
            assert!(!must_revalidate(path), "{path} is a hashed asset");
        }
        assert_eq!(
            asset_mime("manifest.webmanifest"),
            "application/manifest+json"
        );
        assert_eq!(asset_mime("sw.js"), "text/javascript");
        assert_eq!(asset_mime("offline.html"), "text/html");
        assert_eq!(asset_mime("icons/icon-192.png"), "image/png");
    }
}
