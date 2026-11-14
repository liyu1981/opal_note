use axum::body::Body;
use axum::extract::OriginalUri;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

use crate::error::AppError;

/// Assets emitted by `vite build`. In debug builds `rust-embed` reads from
/// disk; in release builds the bytes are compiled into the binary.
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
    if let Some(asset) = WebAssets::get(requested) {
        return asset_response(requested, asset.data.into_owned());
    }

    // Missing hashed assets should be a real 404, not the SPA shell. Only
    // extension-less paths are client-side routes.
    let is_asset_detail = path.split('/').nth(1) == Some("asset");
    let looks_like_asset = requested.starts_with("assets/")
        || requested
            .rsplit('/')
            .next()
            .is_some_and(|name| name.contains('.'));
    if looks_like_asset && !is_asset_detail {
        return AppError::not_found("asset not found").into_response();
    }

    match WebAssets::get("index.html") {
        Some(asset) => asset_response("index.html", asset.data.into_owned()),
        None => (
            StatusCode::NOT_FOUND,
            "web assets are not built; run `pnpm --dir web build`",
        )
            .into_response(),
    }
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
