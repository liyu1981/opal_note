use axum::body::Body;
use axum::extract::OriginalUri;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

#[cfg(not(debug_assertions))]
use rust_embed::RustEmbed;

use crate::error::AppError;

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

fn asset_response(path: &str, bytes: Vec<u8>) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let cache = if path == "index.html" {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CACHE_CONTROL, cache)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
