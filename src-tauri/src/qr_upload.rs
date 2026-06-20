//! QR Upload — Phase 8 Desktop
//!
//! Implements the "扫码拍照上传" flow:
//!   1. Desktop creates an upload session (presigned URL + session_id)
//!   2. Desktop generates a QR code encoding the upload URL
//!   3. Phone scans QR → opens upload page → POSTs photo
//!   4. Phone notifies server → server sends `upload_complete` WS event
//!   5. Desktop downloads the image via the presigned GET URL
//!   6. Image is added to the chat input as an image card

use crate::config::Config;
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::Luma;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

// ---- Auth -----------------------------------------------------------------

fn credentials_path() -> PathBuf {
    crate::config::Config::config_dir().join("local-credentials")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Credentials {
    #[serde(default)]
    username: String,
    #[serde(default)]
    token: Option<String>,
}

fn load_token() -> Result<String> {
    let path = credentials_path();
    let content = fs::read_to_string(&path)?;
    let creds: Credentials =
        serde_json::from_str(&content).map_err(|e| anyhow!("parse credentials: {e}"))?;
    creds
        .token
        .ok_or_else(|| anyhow!("no token in credentials file"))
}

fn build_client() -> Result<reqwest::Client> {
    let token = load_token()?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| anyhow!("build reqwest client: {e}"))?;
    // Re-attaching bearer auth each call via clone
    Ok(client)
}

fn engine_url() -> String {
    let config = Config::load();
    config.engine_url()
}

fn authed_client() -> Result<reqwest::Client> {
    build_client()
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
pub fn generate_qr_image(data: &str) -> Result<String> {
    use qrcode::QrCode;
    use image::ImageEncoder;

    let code = QrCode::new(data.as_bytes())
        .map_err(|e| anyhow!("qrcode encode error: {e}"))?;

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
    .map_err(|e| anyhow!("png encode error: {e}"))?;

    // Wrap as data URL
    let b64 = BASE64.encode(&buf);
    Ok(format!("data:image/png;base64,{}", b64))
}

// ---- Tauri commands -------------------------------------------------------

#[tauri::command]
pub async fn create_upload_session() -> Result<UploadSession> {
    let client = authed_client()?;
    let token = load_token()?;
    let url = format!("{}/api/desktop/upload_session", engine_url());

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| anyhow!("create_upload_session request: {e}"))?;

    if !resp.status().is_success() {
        return Err(anyhow!("create_upload_session failed: {}", resp.status()));
    }

    let session: UploadSession = resp
        .json()
        .await
        .map_err(|e| anyhow!("parse upload_session response: {e}"))?;

    Ok(session)
}

#[tauri::command]
pub async fn generate_qr_code(data: String) -> Result<String> {
    generate_qr_image(&data)
}

#[tauri::command]
pub async fn download_uploaded_file(url: String) -> Result<String> {
    let client = authed_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| anyhow!("download_uploaded_file request: {e}"))?;

    if !resp.status().is_success() {
        return Err(anyhow!("download_uploaded_file failed: {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| anyhow!("read download bytes: {e}"))?;

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
