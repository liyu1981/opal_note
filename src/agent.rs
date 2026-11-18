//! Agent provider plumbing: the encrypted credential envelope and the upstream
//! request itself.
//!
//! The upstream key never reaches the server in plaintext. The browser derives a
//! key from the user's password (PBKDF2-SHA256 today) and encrypts the API key
//! with AES-256-GCM; `<data-dir>/opalnote.db` stores that envelope. Every agent
//! request carries the derived key in `x-opalnote-agent-key`, this module
//! decrypts the envelope with it, uses the result for one upstream call and drops
//! it. See `doc/adr/0001-durable-server-state.md`.

use std::io::Read;
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD};
use base64::Engine as _;
use serde::Deserialize;

/// Endpoints the agent may reach. Everything else is refused, so the proxy
/// cannot be turned into a general-purpose forwarder.
pub const ALLOWED_PATHS: &[&str] = &[
    "models",
    "chat/completions",
    "responses",
    "messages",
    "messages/count_tokens",
];

/// Derived key length the browser must send (AES-256).
pub const DERIVED_KEY_BYTES: usize = 32;
/// AES-GCM nonce length.
const NONCE_BYTES: usize = 12;
/// Largest accepted envelope document.
const MAX_ENVELOPE_BYTES: usize = 16 * 1024;

/// Browser-made credential envelope. The KDF parameters (`kdf`, `iterations`,
/// `salt`) are informational for the client — the server never runs the KDF —
/// so only `v`, `nonce` and `ciphertext` are read here.
#[derive(Debug, Deserialize)]
struct Envelope {
    v: u32,
    nonce: String,
    ciphertext: String,
}

/// Decrypt the stored API key with the client-supplied derived key.
pub fn decrypt_api_key(envelope: &str, derived_key: &str) -> Result<String> {
    if envelope.len() > MAX_ENVELOPE_BYTES {
        bail!("agent key envelope is too large");
    }
    let envelope: Envelope =
        serde_json::from_str(envelope).context("parsing the agent key envelope")?;
    if envelope.v != 1 {
        bail!("unsupported agent key envelope version {}", envelope.v);
    }
    let key = URL_SAFE_NO_PAD
        .decode(derived_key.trim())
        .or_else(|_| BASE64.decode(derived_key.trim()))
        .context("decoding the derived key")?;
    if key.len() != DERIVED_KEY_BYTES {
        bail!("derived key must be {DERIVED_KEY_BYTES} bytes");
    }
    let nonce = BASE64
        .decode(envelope.nonce.trim())
        .context("decoding the envelope nonce")?;
    if nonce.len() != NONCE_BYTES {
        bail!("envelope nonce must be {NONCE_BYTES} bytes");
    }
    let ciphertext = BASE64
        .decode(envelope.ciphertext.trim())
        .context("decoding the envelope ciphertext")?;
    if ciphertext.is_empty() {
        bail!("envelope ciphertext is empty");
    }

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| anyhow!("invalid key size"))?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| anyhow!("the stored key could not be decrypted with this password"))?;
    String::from_utf8(plaintext).context("decrypted agent key is not UTF-8")
}

/// Normalize and validate a base URL: `http(s)`, no credentials, query or
/// fragment, no trailing slash.
pub fn normalize_base_url(input: &str) -> Result<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        bail!("base URL must not be empty");
    }
    let parsed = url::Url::parse(trimmed).context("base URL is not a valid URL")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        bail!("base URL must use http or https");
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        bail!("base URL must not contain credentials");
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        bail!("base URL must not contain a query or fragment");
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

/// Streaming upstream response.
pub struct UpstreamResponse {
    pub status: u16,
    pub content_type: String,
    pub reader: Box<dyn Read + Send>,
}

/// Perform one upstream request with the resolved credential.
pub fn send(
    base_url: &str,
    api_key: Option<&str>,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<UpstreamResponse> {
    if !ALLOWED_PATHS.contains(&path) {
        bail!("unsupported agent endpoint `{path}`");
    }
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        // Per-read budget: a long generation may pause between chunks.
        .timeout_read(Duration::from_secs(300))
        .build();
    let url = format!("{}/{}", base_url.trim_end_matches('/'), path);
    let mut request = agent
        .request(method, &url)
        .set("accept", "text/event-stream, application/json")
        .set("user-agent", "OpalNote");
    if let Some(key) = api_key {
        request = request.set("authorization", &format!("Bearer {key}"));
    }
    let response = match body {
        Some(body) => {
            let request = request.set("content-type", "application/json");
            request.send_string(body)
        }
        None => request.call(),
    };
    let response = match response {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(err) => return Err(anyhow!("agent upstream request failed: {err}")),
    };
    let status = response.status();
    let content_type = response
        .header("content-type")
        .unwrap_or("application/json")
        .to_string();
    Ok(UpstreamResponse {
        status,
        content_type,
        reader: response.into_reader(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::rand_core::RngCore;
    use aes_gcm::aead::Aead;
    use aes_gcm::aead::OsRng;

    fn envelope_for(api_key: &str, derived_key: &[u8]) -> String {
        let cipher = Aes256Gcm::new_from_slice(derived_key).unwrap();
        let mut nonce = [0u8; NONCE_BYTES];
        OsRng.fill_bytes(&mut nonce);
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), api_key.as_bytes())
            .unwrap();
        serde_json::json!({
            "v": 1,
            "kdf": "PBKDF2-SHA256",
            "iterations": 600000,
            "salt": BASE64.encode([9u8; 16]),
            "nonce": BASE64.encode(nonce),
            "ciphertext": BASE64.encode(ciphertext),
        })
        .to_string()
    }

    fn derived_key() -> [u8; DERIVED_KEY_BYTES] {
        let mut key = [0u8; DERIVED_KEY_BYTES];
        OsRng.fill_bytes(&mut key);
        key
    }

    #[test]
    fn decrypts_an_envelope_made_with_the_same_key() {
        let key = derived_key();
        let encoded = URL_SAFE_NO_PAD.encode(key);
        let envelope = envelope_for("sk-or-secret", &key);
        assert_eq!(
            decrypt_api_key(&envelope, &encoded).unwrap(),
            "sk-or-secret"
        );
        // Standard base64 works too (the browser may use either form).
        assert_eq!(
            decrypt_api_key(&envelope, &BASE64.encode(key)).unwrap(),
            "sk-or-secret"
        );
    }

    #[test]
    fn rejects_a_wrong_key_and_a_tampered_envelope() {
        let key = derived_key();
        let other = derived_key();
        let envelope = envelope_for("sk-or-secret", &key);

        let error = decrypt_api_key(&envelope, &URL_SAFE_NO_PAD.encode(other)).unwrap_err();
        assert!(error.to_string().contains("could not be decrypted"));

        let tampered = envelope.replace("ciphertext\":\"", "ciphertext\":\"AAAA");
        assert!(decrypt_api_key(&tampered, &URL_SAFE_NO_PAD.encode(key)).is_err());

        assert!(decrypt_api_key(&envelope, "not-base64!!").is_err());
        assert!(decrypt_api_key("{}", &URL_SAFE_NO_PAD.encode(key)).is_err());
    }

    #[test]
    fn validates_and_normalizes_base_urls() {
        assert_eq!(
            normalize_base_url(" https://openrouter.ai/api/v1/ ").unwrap(),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(
            normalize_base_url("http://localhost:11434/v1").unwrap(),
            "http://localhost:11434/v1"
        );
        for bad in [
            "",
            "ftp://example.com",
            "https://user:pass@example.com",
            "https://example.com/v1?x=1",
            "not a url",
        ] {
            assert!(normalize_base_url(bad).is_err(), "should reject {bad}");
        }
    }

    #[test]
    fn only_allow_listed_paths_are_forwarded() {
        assert!(ALLOWED_PATHS.contains(&"chat/completions"));
        assert!(!ALLOWED_PATHS.contains(&"../secrets"));
        assert!(send("http://127.0.0.1:1/v1", None, "GET", "../secrets", None).is_err());
    }
}
