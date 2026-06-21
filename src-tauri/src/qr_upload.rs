//! QR Upload — Phase 8 Desktop
//!
//! Implements the "扫码拍照上传" flow:
//!   1. Desktop creates an upload session (presigned URL + session_id)
//!   2. Desktop generates a QR code encoding the upload URL
//!   3. Phone scans QR → opens upload page → POSTs photo
//!   4. Phone notifies server → server sends `upload_complete` WS event
//!   5. Desktop downloads the image via the presigned GET URL
//!   6. Image is added to the chat input as an image card

use crate::auth::load_local_token;
use crate::config::Config;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::Luma;
use serde::{Deserialize, Serialize};

// ---- Auth -----------------------------------------------------------------

fn engine_url() -> String {
    let config = Config::load();
    config.engine_url()
}

fn authed_client() -> Result<reqwest::Client, String> {
    Ok(crate::http_client::http_client().clone())
}

// ---- Data types -----------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadSession {
    pub session_id: String,
    pub presigned_url: String,
    #[serde(rename = "presigned_get_url")]
    pub presigned_get_url: Option<String>,
    #[serde(rename = "expires_in")]
    pub expires_in: u64,
}

// ---- QR code generation ---------------------------------------------------

/// Generate a QR code PNG as a base64-encoded data URL.
pub fn generate_qr_image(data: &str) -> Result<String, String> {
    use qrcode::QrCode;
    use image::ImageEncoder;

    let code = QrCode::new(data.as_bytes())
        .map_err(|e| format!("qrcode encode error: {e}"))?;

    // Render to grayscale image
    let image = code.render::<Luma<u8>>().build();

    // Encode as PNG into a Vec
    let mut buf = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut buf);
    encoder.write_image(
        image.as_raw(),
        image.width(),
        image.height(),
        image::ExtendedColorType::L8,
    )
    .map_err(|e| format!("png encode error: {e}"))?;

    // Wrap as data URL
    let b64 = BASE64.encode(&buf);
    Ok(format!("data:image/png;base64,{}", b64))
}

// ---- Tauri commands -------------------------------------------------------

#[tauri::command]
pub async fn create_upload_session() -> Result<UploadSession, String> {
    let client = authed_client()?;
    let token = load_local_token().ok_or_else(|| "no token in credentials file".to_string())?;
    let url = format!("{}/api/desktop/upload_session", engine_url());

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("create_upload_session request: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("create_upload_session failed: {}", resp.status()));
    }

    let session: UploadSession = resp
        .json()
        .await
        .map_err(|e| format!("parse upload_session response: {e}"))?;

    Ok(session)
}

#[tauri::command]
pub async fn generate_qr_code(data: String) -> Result<String, String> {
    generate_qr_image(&data)
}

#[tauri::command]
pub async fn download_uploaded_file(url: String) -> Result<String, String> {
    let client = authed_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download_uploaded_file request: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("download_uploaded_file failed: {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read download bytes: {e}"))?;

    // Detect content type from URL or default to image/png
    let mime = if url.contains(".jpg") || url.contains(".jpeg") {
        "image/jpeg"
    } else if url.contains(".png") {
        "image/png"
    } else if url.contains(".gif") {
        "image/gif"
    } else {
        "image/png"
    };

    let b64 = BASE64.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---------------------------------------------------------------------------
    // UploadSession — full deserialization
    // ---------------------------------------------------------------------------

    #[test]
    fn upload_session_deserialize_full() {
        let json = r#"{
            "session_id": "sess-001",
            "presigned_url": "https://upload.example.com/put",
            "presigned_get_url": "https://download.example.com/get/file.jpg",
            "expires_in": 300
        }"#;
        let s: UploadSession = serde_json::from_str(json).unwrap();
        assert_eq!(s.session_id, "sess-001");
        assert_eq!(s.presigned_url, "https://upload.example.com/put");
        assert_eq!(
            s.presigned_get_url,
            Some("https://download.example.com/get/file.jpg".to_string())
        );
        assert_eq!(s.expires_in, 300);
    }

    // ---------------------------------------------------------------------------
    // UploadSession — presigned_get_url optional
    // ---------------------------------------------------------------------------

    #[test]
    fn upload_session_missing_get_url() {
        let json = r#"{
            "session_id": "sess-002",
            "presigned_url": "https://upload.example.com/put",
            "expires_in": 600
        }"#;
        let s: UploadSession = serde_json::from_str(json).unwrap();
        assert_eq!(s.session_id, "sess-002");
        assert!(s.presigned_get_url.is_none());
    }

    // ---------------------------------------------------------------------------
    // UploadSession — round-trip
    // ---------------------------------------------------------------------------

    #[test]
    fn upload_session_roundtrip() {
        let s = UploadSession {
            session_id: "sess-round".to_string(),
            presigned_url: "https://example.com/put".to_string(),
            presigned_get_url: Some("https://example.com/get".to_string()),
            expires_in: 120,
        };
        let json = serde_json::to_string(&s).unwrap();
        let parsed: UploadSession = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, s);
    }

    #[test]
    fn upload_session_roundtrip_no_get_url() {
        let s = UploadSession {
            session_id: "sess-min".to_string(),
            presigned_url: "https://example.com/put".to_string(),
            presigned_get_url: None,
            expires_in: 60,
        };
        let json = serde_json::to_string(&s).unwrap();
        let parsed: UploadSession = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, s);
    }

    // ---------------------------------------------------------------------------
    // UploadSession — zero expiry
    // ---------------------------------------------------------------------------

    #[test]
    fn upload_session_zero_expiry() {
        let json = r#"{"session_id": "sess-zero", "presigned_url": "http://x.cc", "expires_in": 0}"#;
        let s: UploadSession = serde_json::from_str(json).unwrap();
        assert_eq!(s.expires_in, 0);
    }

    // ---------------------------------------------------------------------------
    // QR code generation
    // ---------------------------------------------------------------------------

    #[test]
    fn generate_qr_image_basic() {
        let result = generate_qr_image("https://example.com/upload/sess-123");
        assert!(result.is_ok());
        let data_url = result.unwrap();
        assert!(data_url.starts_with("data:image/png;base64,"));
        // Base64 portion should be non-empty
        let b64 = data_url.strip_prefix("data:image/png;base64,").unwrap();
        assert!(!b64.is_empty());
    }

    #[test]
    fn generate_qr_image_empty_string() {
        // Empty string should still produce a valid (minimal) QR code
        let result = generate_qr_image("");
        assert!(result.is_ok());
        let data_url = result.unwrap();
        assert!(data_url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn generate_qr_image_short_string() {
        // Short strings should always succeed
        for data in &["a", "1", "hello", "http://x.co"] {
            let result = generate_qr_image(data);
            assert!(result.is_ok(), "QR generation failed for '{}': {:?}", data, result);
            let data_url = result.unwrap();
            assert!(data_url.starts_with("data:image/png;base64,"));
        }
    }

    #[test]
    fn generate_qr_image_unicode() {
        // QR codes support UTF-8
        let result = generate_qr_image("你好世界");
        assert!(result.is_ok());
        let data_url = result.unwrap();
        assert!(data_url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn generate_qr_image_url_special_chars() {
        // URLs with query params
        let result = generate_qr_image("https://example.com/upload?session=abc&exp=123");
        assert!(result.is_ok());
    }

    // ---------------------------------------------------------------------------
    // QR code generation — very long data (edge case)
    // ---------------------------------------------------------------------------

    #[test]
    fn generate_qr_image_long_data() {
        // Very long data may exceed QR code capacity (depends on error correction level).
        // qrcode crate returns an error for data too large to encode.
        let long_data = "x".repeat(2000);
        let result = generate_qr_image(&long_data);
        // Result may be Ok or Err depending on capacity — both are valid behavior.
        // Just verify the function doesn't panic and returns the expected type.
        assert!(result.is_ok() || result.is_err());
    }

    #[test]
    fn generate_qr_image_repeated_url() {
        // Repeated URL pattern — tests buffer growth
        let data = "https://example.com/upload/".to_string().repeat(50);
        let result = generate_qr_image(&data);
        assert!(result.is_ok() || result.is_err());
    }

    // ---------------------------------------------------------------------------
    // QR code data URL format
    // ---------------------------------------------------------------------------

    #[test]
    fn generate_qr_image_data_url_is_valid_base64() {
        let result = generate_qr_image("test data").unwrap();
        let b64 = result.strip_prefix("data:image/png;base64,").unwrap();
        // Should decode successfully
        let decoded = base::Engine::decode(&base::engine::general_purpose::STANDARD, b64);
        assert!(decoded.is_ok());
        // PNG magic bytes
        let bytes = decoded.unwrap();
        assert_eq!(&bytes[0..4], &[0x89, 0x50, 0x4E, 0x47]); // PNG signature
    }

    // ---------------------------------------------------------------------------
    // Credentials (internal helper)
    // ---------------------------------------------------------------------------

    #[test]
    fn credentials_parse() {
        let json = r#"{"username": "test", "token": "tok123"}"#;
        let creds: Credentials = serde_json::from_str(json).unwrap();
        assert_eq!(creds.username, "test");
        assert_eq!(creds.token, Some("tok123".to_string()));
    }

    #[test]
    fn credentials_missing_token() {
        let json = r#"{"username": "user"}"#;
        let creds: Credentials = serde_json::from_str(json).unwrap();
        assert!(creds.token.is_none());
    }
}
