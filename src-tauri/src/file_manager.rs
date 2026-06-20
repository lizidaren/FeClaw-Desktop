//! Phase 2A Desktop — VFS File Manager Tauri commands.
//!
//! All commands call the Engine REST API (same base URL + auth as side_panel).
//! The frontend (file-manager.ts) calls these via `invoke('list_vfs_dir', {...})`.
//!
//! Engine endpoints used:
//!   GET  /api/user/agents/{hash}/vfs?path={path}       → list directory
//!   GET  /api/user/agents/{hash}/vfs/url?path=&mode=view  → presigned preview URL
//!   POST /api/user/agents/{hash}/vfs/url-upload        → presigned upload URL
//!   POST /api/user/agents/{hash}/vfs/mkdir            → create directory
//!   POST /api/user/agents/{hash}/vfs/rm               → delete entry
//!   POST /api/user/agents/{hash}/vfs/mv               → rename / move
//!   PATCH /api/user/agents/{hash}/vfs/permissions     → set permission
//!   POST /api/user/agents/{hash}/vfs/events           → notify events

use crate::config::Config;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

/// Path to the temp directory for downloaded preview files.
fn temp_preview_dir() -> PathBuf {
    Config::config_dir().join("temp").join("preview")
}

// ---------------------------------------------------------------------------
// Shared serializable structs
// ---------------------------------------------------------------------------

/// A file or directory entry returned by `list_vfs_dir`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub size: u64,
    pub mtime: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

/// Presigned URL for viewing / downloading a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewUrl {
    pub url: String,
    pub expires_at: u64,
}

/// Presigned URL for uploading a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadUrl {
    pub url: String,
    pub method: String,
    pub expires_at: u64,
}

/// A file-system change event sent to Engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
    pub timestamp: u64,
}

/// Response from the mkdir endpoint (empty on success).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MkdirResponse {}

/// Response from the rm endpoint (empty on success).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RmResponse {}

/// Request body for mv (rename / move).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvRequest {
    pub from_path: String,
    pub to_path: String,
}

/// Response from mv (empty on success).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MvResponse {}

/// Request body for set_permission.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPermissionRequest {
    pub path: String,
    pub permission: String,
}

/// Response from set_permission (empty on success).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetPermissionResponse {}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Return the Engine base URL and Bearer token for a given mode.
fn engine_base_and_token() -> Result<(String, Option<String>), String> {
    let config = Config::load();
    let base_url = match config.mode {
        crate::config::Mode::Local => config.engine_url(),
        crate::config::Mode::Cloud => {
            config.cloud_base_url().unwrap_or("https://feclaw.lizidaren.cn").to_string()
        }
    };
    Ok((base_url, config.cloud_token))
}

/// Build a reqwest client with standard timeout.
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("build reqwest client: {e}"))
}

/// Add Bearer auth header if token is present.
fn with_auth(req: reqwest::RequestBuilder, token: Option<String>) -> reqwest::RequestBuilder {
    if let Some(t) = token {
        req.bearer_auth(t)
    } else {
        req
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// List a VFS directory. Calls `GET /api/user/agents/{hash}/vfs?path={path}`.
#[tauri::command]
pub async fn list_vfs_dir(agent_hash: String, path: String) -> Result<Vec<FsEntry>, String> {
    let (base_url, token) = engine_base_and_token()?;
    let client = http_client()?;

    let encoded_path = urlencoding::encode(&path);
    let url = format!(
        "{}/api/user/agents/{}/vfs?path={}",
        base_url.trim_end_matches('/'),
        agent_hash,
        encoded_path
    );

    let resp = with_auth(client.get(&url), token)
        .send()
        .await
        .map_err(|e| format!("list_vfs_dir HTTP failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("list_vfs_dir returned {}: {}", status, text));
    }

    let entries: Vec<FsEntry> = resp
        .json()
        .await
        .map_err(|e| format!("parse list_vfs_dir response: {e}"))?;

    Ok(entries)
}

/// Get a presigned URL for viewing a file.
/// Calls `GET /api/user/agents/{hash}/vfs/url?path={path}&mode=view`.
#[tauri::command]
pub async fn get_vfs_preview_url(
    agent_hash: String,
    path: String,
) -> Result<PreviewUrl, String> {
    let (base_url, token) = engine_base_and_token()?;
    let client = http_client()?;

    let encoded_path = urlencoding::encode(&path);
    let url = format!(
        "{}/api/user/agents/{}/vfs/url?path={}&mode=view",
        base_url.trim_end_matches('/'),
        agent_hash,
        encoded_path
    );

    let resp = with_auth(client.get(&url), token)
        .send()
        .await
        .map_err(|e| format!("get_vfs_preview_url HTTP failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("get_vfs_preview_url returned {}: {}", status, text));
    }

    let preview: PreviewUrl = resp
        .json()
        .await
        .map_err(|e| format!("parse preview URL response: {e}"))?;

    Ok(preview)
}

/// Get a presigned URL for uploading a file.
/// Calls `POST /api/user/agents/{hash}/vfs/url-upload`.
#[tauri::command]
pub async fn get_vfs_upload_url(
    agent_hash: String,
    path: String,
) -> Result<UploadUrl, String> {
    let (base_url, token) = engine_base_and_token()?;
    let client = http_client()?;

    let url = format!(
        "{}/api/user/agents/{}/vfs/url-upload",
        base_url.trim_end_matches('/'),
        agent_hash
    );

    #[derive(Serialize)]
    struct UploadRequest<'a> {
        path: &'a str,
    }

    let resp = with_auth(client.post(&url).json(&UploadRequest { path: &path }), token)
        .send()
        .await
        .map_err(|e| format!("get_vfs_upload_url HTTP failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("get_vfs_upload_url returned {}: {}", status, text));
    }

    let upload: UploadUrl = resp
        .json()
        .await
        .map_err(|e| format!("parse upload URL response: {e}"))?;

    Ok(upload)
}

/// Create a directory. Calls `POST /api/user/agents/{hash}/vfs/mkdir`.
#[tauri::command]
pub async fn vfs_mkdir(agent_hash: String, path: String) -> Result<(), String> {
    let (base_url, token) = engine_base_and_token()?;
    let client = http_client()?;

    let url = format!(
        "{}/api/user/agents/{}/vfs/mkdir",
        base_url.trim_end_matches('/'),
        agent_hash
    );

    #[derive(Serialize)]
    struct MkdirRequest<'a> {
        path: &'a str,
    }

    let resp = with_auth(
        client.post(&url).json(&MkdirRequest { path: &path }),
        token,
    )
    .send()
    .await
    .map_err(|e| format!("vfs_mkdir HTTP failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("vfs_mkdir returned {}: {}", status, text));
    }

    Ok(())
}

/// Delete a file or directory. Calls `POST /api/user/agents/{hash}/vfs/rm`.
#[tauri::command]
pub async fn vfs_rm(agent_hash: String, path: String) -> Result<(), String> {
    let (base_url, token) = engine_base_and_token()?;
    let client = http_client()?;

    let url = format!(
        "{}/api/user/agents/{}/vfs/rm",
        base_url.trim_end_matches('/'),
        agent_hash
    );

    #[derive(Serialize)]
    struct RmRequest<'a> {
        path: &'a str,
    }

    let resp = with_auth(client.post(&url).json(&RmRequest { path: &path }), token)
        .send()
        .await
        .map_err(|e| format!("vfs_rm HTTP failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("vfs_rm returned {}: {}", status, text));
    }

    Ok(())
}

/// Move / rename a file or directory.
/// Calls `POST /api/user/agents/{hash}/vfs/mv`.
#[tauri::command]
pub async fn vfs_mv(
    agent_hash: String,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    let (base_url, token) = engine_base_and_token()?;
    let client = http_client()?;

    let url = format!(
        "{}/api/user/agents/{}/vfs/mv",
        base_url.trim_end_matches('/'),
        agent_hash
    );

    let resp = with_auth(
        client
            .post(&url)
            .json(&MvRequest { from_path, to_path }),
        token,
    )
    .send()
    .await
    .map_err(|e| format!("vfs_mv HTTP failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("vfs_mv returned {}: {}", status, text));
    }

    Ok(())
}

/// Set file / directory permission.
/// Calls `PATCH /api/user/agents/{hash}/vfs/permissions`.
#[tauri::command]
pub async fn vfs_set_permission(
    agent_hash: String,
    path: String,
    permission: String,
) -> Result<(), String> {
    let (base_url, token) = engine_base_and_token()?;
    let client = http_client()?;

    let url = format!(
        "{}/api/user/agents/{}/vfs/permissions",
        base_url.trim_end_matches('/'),
        agent_hash
    );

    let resp = with_auth(
        client
            .patch(&url)
            .json(&SetPermissionRequest { path, permission }),
        token,
    )
    .send()
    .await
    .map_err(|e| format!("vfs_set_permission HTTP failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("vfs_set_permission returned {}: {}", status, text));
    }

    Ok(())
}

/// Notify Engine of file-system change events.
/// Calls `POST /api/user/agents/{hash}/vfs/events`.
#[tauri::command]
pub async fn vfs_notify_event(agent_hash: String, events: Vec<FsEvent>) -> Result<(), String> {
    let (base_url, token) = engine_base_and_token()?;
    let client = http_client()?;

    let url = format!(
        "{}/api/user/agents/{}/vfs/events",
        base_url.trim_end_matches('/'),
        agent_hash
    );

    let resp = with_auth(client.post(&url).json(&events), token)
        .send()
        .await
        .map_err(|e| format!("vfs_notify_event HTTP failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("vfs_notify_event returned {}: {}", status, text));
    }

    Ok(())
}

/// Download a VFS file to a local temp path and return the local file path.
/// 1. Get presigned URL from Engine
/// 2. Download bytes via reqwest
/// 3. Save to ~/.feclaw/temp/preview/
/// 4. Return the local path
#[tauri::command]
pub async fn download_vfs_file(
    agent_hash: String,
    path: String,
) -> Result<String, String> {
    // Step 1: Get presigned URL
    let preview = get_vfs_preview_url(agent_hash.clone(), path.clone()).await?;

    // Step 2: Download bytes
    let client = http_client()?;
    let resp = client
        .get(&preview.url)
        .send()
        .await
        .map_err(|e| format!("download HTTP failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("download returned {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read download bytes: {e}"))?;

    // Step 3: Save to temp/preview/
    let preview_dir = temp_preview_dir();
    std::fs::create_dir_all(&preview_dir)
        .map_err(|e| format!("create preview dir: {e}"))?;

    // Use the file name from the path
    let file_name = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download");
    let local_path = preview_dir.join(file_name);

    std::fs::write(&local_path, &bytes)
        .map_err(|e| format!("write temp file: {e}"))?;

    Ok(local_path.to_string_lossy().to_string())
}
